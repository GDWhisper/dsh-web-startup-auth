/**
 * Remote-aware replacement for `@deepseek-ai/dsh-web-app/startup`.
 *
 * The behavioral differences from the stock web-startup: `--host 0.0.0.0` is
 * accepted (the stock plugin hard-rejects it for safety) and `--host ::` or
 * any IPv6 literal works too (issue #35 — the stock webserver schema only
 * allows the two IPv4 literals; `src/ipv6-shim.ts` widens it in place).
 * Remote exposure is expected to be covered by the paired `web-auth` plugin.
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
    /** Explicit `--trusted-host` authorities, in argument order (passthrough for downstream consumers; not consulted by web-auth). */
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
 * does NOT reject `--host 0.0.0.0`; remote security is the auth plugin's job.
 * `--host ::` (and any IPv6 literal) is accepted too — the stock webserver
 * schema is widened in place here, before the `webserver` row (which injects
 * `webStartup`) can validate against it.
 *
 * Also provides `webLanHosts`, the helper our cordis patch concatenates
 * into the `connection` row's `trustedHosts`: the stock LAN derivation
 * enumerates IPv4 interfaces only, and only for the `0.0.0.0` bind, while the
 * browser-trust fence rejects a non-loopback `Host` (403) unless listed.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
