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
import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Launcher-provided bounded process-exit request. */
        appExit?: (code: number) => void;
    }
}
/** Stable Cordis plugin name. */
export declare const name = "remote-web-startup";
/** Services required before the flags can be resolved. */
export declare const inject: string[];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export declare const WEB_STARTUP_SERVICE = "webStartup";
/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
    /** `--host`, absent when the invocation did not name one. */
    host?: string;
    /** `--port`, absent when the invocation did not name one. */
    port?: number;
    /** `--public-url`, absent when not specified: the advertised HTTP(S) root (0.2.1 web-runtime row). */
    publicUrl?: string;
    /**
     * `--tls-cert` plus `--tls-key` as one pair (0.2.1 webserver row `tls`).
     * Structural mirror of the upstream `TlsConfig` — the 0.2.0-line deps do
     * not export that type. The webserver reads both files at init and rejects
     * unreadable or mismatched material itself.
     */
    tls?: {
        certFile: string;
        keyFile: string;
    };
    /**
     * Fence authorities for the `connection` row: explicit `--trusted-host`
     * values in argument order, then the bind-derived LAN authorities
     * ({@link lanHosts}). Consumed via `!!js ctx.webStartup.trustedHosts`.
     */
    trustedHosts: string[];
    /** `--no-open` support: whether the default browser should be opened (default true). */
    openBrowser?: boolean;
}
/** Options for the `auth-reset` subcommand. */
export interface AuthResetOptions {
    password?: string;
    /** Replacement administrator username; omitted keeps the current one. */
    username?: string;
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
export declare function runAuthReset(options: AuthResetOptions): Promise<string>;
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
export declare function apply(ctx: Context): void;
