/**
 * Remote-aware replacement for `@deepseek-ai/dsh-web-app/startup`.
 *
 * The only behavioral difference from the stock web-startup is that `--host
 * 0.0.0.0` is accepted (the stock plugin hard-rejects it for safety). Remote
 * exposure is expected to be covered by the paired `web-auth` plugin.
 *
 * This plugin provides the same `webStartup` service (`'webStartup'`), so the
 * stock `webserver`, `web-runtime`, and `connection` rows resolve exactly as
 * before.
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
/** Stable Cordis plugin name. */
export const name = 'remote-web-startup';
/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup';
/** This app's command: its flags, its description, and its help text. */
function webCommand() {
    return new Command()
        .name('dsh --profile web')
        .description('Serve the DeepSeek Harness browser UI (remote-capable).')
        .helpOption('-h, --help', 'show this help')
        .option('--host <host>', 'bind host (0.0.0.0 allowed when the auth plugin is configured)')
        .option('--no-open', 'do not open the Web UI in the default browser')
        .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
        .option('--trusted-host <authority...>', 'passthrough for the stock startup\'s browser-trust authorities (kept for CLI compatibility; not consulted by web-auth — sessions cover all remote clients)')
        .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --host 0.0.0.0 --port 8080   serve on all interfaces (requires auth)
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
 * Parse and provide the Web invocation. Unlike the stock web-startup, this
 * does NOT reject `--host 0.0.0.0`; remote security is the auth plugin's job.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const program = webCommand();
    program.action(() => {
        const options = program.opts();
        if (options.port !== undefined && !/^\d+$/.test(options.port)) {
            program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
        }
        ctx.provide(WEB_STARTUP_SERVICE, {
            openBrowser: options.open,
            ...options.host !== undefined && { host: options.host },
            ...options.port !== undefined && { port: Number(options.port) },
            trustedHosts: options.trustedHost ?? [],
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
