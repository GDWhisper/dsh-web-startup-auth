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
 * resetting the web-auth administrator password, which rotates the session
 * signing secret and invalidates every existing session cookie.
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
}
/**
 * Reset the web-auth administrator password.
 *
 * Rotates the session signing secret, so every previously issued session
 * cookie becomes invalid at once. This is the documented recovery path for a
 * forgotten password (deleting the credential file is the fallback).
 * @param options - `--password` value, or nothing for the interactive prompt.
 * @returns a human-readable success message.
 */
export declare function runAuthReset(options: AuthResetOptions): Promise<string>;
/**
 * Parse and provide the Web invocation. Unlike the stock web-startup, this
 * does NOT reject `--host 0.0.0.0`; remote security is the auth plugin's job.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;
