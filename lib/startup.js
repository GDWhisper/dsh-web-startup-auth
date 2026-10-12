/**
 * Remote-aware replacement for `@deepseek-ai/dsh-web-app/startup`.
 *
 * Behavioral differences from the stock web-startup:
 *
 * - `--host 0.0.0.0` is accepted (the stock plugin hard-rejects it for
 *   safety; the 0.2.1 line widened the rejection to every wildcard) and
 *   `--host ::` — or any concrete IPv4/IPv6 literal — works too (issue #35;
 *   `src/ipv6-shim.ts` widens the stock webserver schema in place). Remote
 *   exposure is expected to be covered by the paired `web-auth` plugin.
 * - the provided `webStartup.trustedHosts` carries the FULL fence authority
 *   list — explicit `--trusted-host` values plus the LAN authorities derived
 *   from the bind (`lanHosts`) — which the `connection` row consumes through
 *   the official `!!js ctx.webStartup.trustedHosts` expression. Upstream
 *   0.2.1 deleted its own LAN derivation (`resolveLanTrust`), so this module
 *   owns it now.
 * - `--public-url` and `--tls-cert`/`--tls-key` pass through to the same
 *   `webStartup` values the stock 0.2.1 startup provides; on older harnesses
 *   the flags are rejected with a clear error instead of being silently
 *   ignored.
 *
 * This plugin provides the same `webStartup` service (`'webStartup'`), so
 * the stock `webserver`, `web-runtime`, and `connection` rows resolve exactly
 * as before.
 *
 * It also owns the `auth-reset` subcommand (`dsh --profile web auth-reset`):
 * resetting the web-auth administrator password and/or username, which
 * rotates the session signing secret and invalidates every existing session
 * cookie.
 */
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { hasCredentials, updateCredentials, normalizeUsername, MIN_PASSWORD_LENGTH } from "./credential-store.js";
import { ensureIpv6BindSupport, lanHosts, normalizeBindHost, supportsTlsConfig, } from "./ipv6-shim.js";
/** Stable Cordis plugin name. */
export const name = 'remote-web-startup';
/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup';
/**
 * Local mirror of upstream `parsePublicUrl`
 * (`@deepseek-ai/dsh-web-app/src/public-url.ts` — validated here because the
 * package exports no `./public-url` subpath). Keep behavior-compatible with
 * the upstream validator and re-diff it on every dsh upgrade, like the
 * native-auth-bridge mirror (`docs/agent/native-auth-bridge.md`): parses the
 * advertised public HTTP(S) root, rejecting the hazards WHATWG URL parsing
 * would accept on its own, then normalizes the path to end in `/`.
 * @param value - advertised public HTTP(S) root.
 * @param label - field name or CLI flag included in rejection messages.
 * @returns the parsed URL with a trailing-slash pathname.
 * @throws when the value is not a usable advertised root, naming the reason.
 */
function parsePublicUrl(value, label = 'publicUrl') {
    if (/[\u0000-\u0020\u007f]/u.test(value)) {
        throw new Error(`${label} must not contain ASCII whitespace or control characters`);
    }
    if (!/^https?:\/\//iu.test(value)) {
        throw new Error(`${label} must be an absolute http or https URL of the form http(s)://host[/prefix]`);
    }
    if (value.includes('?') || value.includes('#')) {
        throw new Error(`${label} must not include a query or fragment (? or #)`);
    }
    // Userinfo lives in the raw authority (before the first path slash); the
    // empty-authority forms (`https://`, `https:///ui`, `http:///ui`) fail here too.
    const [authority = ''] = value.slice(value.indexOf('://') + 3).split(/[/\\]/, 1);
    if (authority === '') {
        throw new Error(`${label} must name a host after http:// or https://`);
    }
    if (authority.includes('@')) {
        throw new Error(`${label} must not include credentials (a username or password before @, including an empty user)`);
    }
    const url = URL.parse(value);
    if (url === null)
        throw new Error(`${label} must be an absolute http or https URL`);
    if (!url.pathname.endsWith('/'))
        url.pathname += '/';
    return url;
}
/** This app's command: its flags, its description, and its help text. */
function webCommand() {
    return new Command()
        .name('dsh --profile web')
        .description('Serve the DeepSeek Harness browser UI (remote-capable).')
        .helpOption('-h, --help', 'show this help')
        .option('--host <host>', 'bind host; 0.0.0.0 (all IPv4 interfaces), :: (all interfaces, IPv6 + IPv4-mapped on dual-stack Linux), or any IPv4/IPv6 literal of a local interface')
        .option('--no-open', 'do not open the Web UI in the default browser')
        .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
        .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, web-surface, and DSH_WEB_URL forms; grants no trust (requires dsh >= 0.2.1)')
        .option('--trusted-host <authority...>', 'passthrough for the stock startup\'s browser-trust authorities (kept for CLI compatibility; not consulted by web-auth — sessions cover all remote clients)')
        .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key (requires dsh >= 0.2.1)')
        .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert (requires dsh >= 0.2.1)')
        .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --host 0.0.0.0 --port 8080   serve on all IPv4 interfaces (requires auth)
  dsh --profile web --host :: --port 8080    serve on all interfaces over IPv6 (dual-stack where bindv6only=0; requires auth)
  dsh --profile web --host 192.168.1.5       bind one concrete local interface address
  dsh --profile web --tls-cert ./chain.pem --tls-key ./key.pem   serve HTTPS (dsh >= 0.2.1)
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping proxy entry (dsh >= 0.2.1)
  dsh --profile web auth-reset               reset the web-auth password (invalidates all sessions)
  dsh --profile web auth-reset --username alice   change the administrator username (invalidates all sessions)
`);
}
/**
 * Prompt for a password with echo suppressed. Works on POSIX TTYs; on a
 * non-terminal stdin the password is echoed and the user is told so.
 * @param question - the prompt text.
 */
function promptHiddenPassword(question) {
    process.stdout.write(question);
    let echoMuted = false;
    try {
        execSync('stty -echo', { stdio: 'ignore' });
        echoMuted = true;
    }
    catch {
        process.stdout.write('（stdin 不是终端，密码将以明文显示）\n');
    }
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('line', (line) => {
            if (echoMuted) {
                try {
                    execSync('stty echo', { stdio: 'ignore' });
                }
                catch {
                    // stdin vanished; nothing left to restore
                }
                process.stdout.write('\n');
            }
            rl.close();
            resolve(line);
        });
    });
}
/** Prompt for a new password twice and return it. */
async function promptNewPassword() {
    const first = await promptHiddenPassword('新密码: ');
    const second = await promptHiddenPassword('再次输入新密码: ');
    if (first !== second) {
        throw new Error('两次输入的密码不一致');
    }
    return first;
}
/**
 * Reset the web-auth administrator password and/or username.
 *
 * Always rotates the session signing secret, so every previously issued
 * session cookie becomes invalid at once. This is the documented recovery
 * path for a forgotten password (deleting the credential file is the
 * fallback) and for a username containing stray control characters (issue
 * #14).
 *
 * Password handling: `--password` supplies it directly; without `--username`
 * the interactive prompt asks for one (the historical behavior). With
 * `--username` but no `--password`, the password is left untouched.
 * @param options - `--password` / `--username` values.
 * @returns a human-readable success message.
 */
export async function runAuthReset(options) {
    if (!hasCredentials()) {
        throw new Error('尚未注册管理员账号，无需重置');
    }
    const username = options.username !== undefined ? normalizeUsername(options.username) : undefined;
    if (options.username !== undefined && !username) {
        throw new Error('用户名不能为空');
    }
    let password = options.password;
    if (password === undefined && username === undefined) {
        password = await promptNewPassword();
    }
    if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    updateCredentials({
        ...username !== undefined && { username },
        ...password !== undefined && { password },
    });
    const parts = [];
    if (username !== undefined)
        parts.push('管理员用户名已更新');
    if (password !== undefined)
        parts.push('管理员密码已重置');
    return `${parts.join('，')}，所有现有会话已失效`;
}
/**
 * Read the cordis context's base URL (the profile root at boot), the base
 * from which the `webserver` row resolves the package whose schema the boot
 * path validates against.
 * @param ctx - plugin context carrying the command line.
 */
function ctxBaseUrl(ctx) {
    if ('baseUrl' in ctx) {
        const base = ctx.baseUrl;
        if (typeof base === 'string')
            return base;
    }
    return undefined;
}
/**
 * Parse and provide the Web invocation. Unlike the stock web-startup, this
 * does NOT reject the wildcard hosts; remote security is the auth plugin's
 * job. IPv6 literals and concrete IPv4 literals pass too — the stock
 * webserver schema is widened in place here, before the `webserver` row
 * (which injects `webStartup`) can validate against it.
 *
 * `trustedHosts` is enriched with the LAN authorities the stock derivations
 * cannot produce for this bind ({@link lanHosts}), because the browser-trust
 * fence rejects a non-loopback `Host` (403) unless listed or — on the 0.2.1
 * fence — equal to the listener's own bind address.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const ipv6BindSupported = ensureIpv6BindSupport(ctxBaseUrl(ctx));
    const tlsSupported = supportsTlsConfig(ctxBaseUrl(ctx));
    const program = webCommand();
    program.action(() => {
        const options = program.opts();
        if (options.port !== undefined && !/^\d+$/.test(options.port)) {
            program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
        }
        let host;
        if (options.host !== undefined) {
            try {
                host = normalizeBindHost(options.host);
            }
            catch (error) {
                program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // The extended host domain rides on the widened schema: on the 0.2.0
        // line that covers IPv6 and concrete-IPv4 literals; on the 0.2.1 line
        // the wildcards are rejected by the stock member too. If the widen
        // failed, only 127.0.0.1 is guaranteed to validate on both eras.
        if (host !== undefined && host !== '127.0.0.1' && !ipv6BindSupported) {
            program.error('error: 当前 dsh 版本不支持扩展的 --host 值（通配 / IPv6 / 具体 IPv4 字面量）：无法扩展 webserver 的 host 配置；请升级 dsh，或改用 --host 127.0.0.1');
        }
        let tls;
        if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
            tls = { certFile: options.tlsCert, keyFile: options.tlsKey };
        }
        else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
            program.error('error: --tls-cert and --tls-key must be supplied together');
        }
        let publicUrl;
        if (options.publicUrl !== undefined) {
            try {
                parsePublicUrl(options.publicUrl, '--public-url');
                publicUrl = options.publicUrl;
            }
            catch (error) {
                program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // TLS and --public-url shipped in the same upstream line; on an older
        // harness the rows would ignore the provided values — a TLS flag under a
        // plain-HTTP listener must fail loudly, not silently.
        if ((tls !== undefined || publicUrl !== undefined) && !tlsSupported) {
            program.error('error: 当前 dsh 版本不支持 TLS / --public-url（需要 dsh >= 0.2.1）；请升级 dsh');
        }
        ctx.provide(WEB_STARTUP_SERVICE, {
            openBrowser: options.open,
            ...host !== undefined && { host },
            ...options.port !== undefined && { port: Number(options.port) },
            ...publicUrl !== undefined && { publicUrl },
            ...tls !== undefined && { tls },
            trustedHosts: [...options.trustedHost ?? [], ...lanHosts(host)],
        });
    });
    program
        .command('auth-reset')
        .description('Reset the web-auth administrator password and/or username; invalidates all existing sessions.')
        .option('--password <password>', 'new password (omit for a hidden interactive prompt)')
        .option('--username <username>', 'new administrator username (omit to keep the current one)')
        .action(async (options) => {
        const exit = ctx.get('appExit');
        try {
            const message = await runAuthReset(options);
            process.stdout.write(`${message}\n`);
            exit?.(0);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`错误: ${message}\n`);
            exit?.(1);
        }
    });
    parseCmdline(ctx, program);
}
