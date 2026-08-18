/**
 * Auth plugin for remote dsh Web access with front-end login/register.
 *
 * Responsibilities:
 * - Refuse to start with `--host 0.0.0.0` unless credentials can be managed.
 * - Serve a login/register page at `/login`.
 * - Provide session management (signed cookies, 14-day expiry).
 * - Protect `/api` routes by wrapping the webserver's route registration.
 * - Provide a `webAuth` service that downstream transport layers can use.
 *
 * Wire-level enforcement:
 *   The plugin wraps `ctx.webServer.register` to inject a session check into
 *   every `/api` prefix route (except `/api/auth/*`). The `connection` row
 *   must inject `webAuth` so it activates after this plugin.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { IncomingMessage } from 'node:http';
declare module '@deepseek-ai/cordis' {
    interface Context {
        webAuth?: WebAuthService;
    }
}
/** Stable Cordis plugin name. */
export declare const name = "web-auth";
/** Services required before the auth policy can be installed. */
export declare const inject: string[];
/** Auth plugin configuration (no static config needed; credentials are stored on disk). */
export interface Config {
}
export declare const Config: z<Config>;
/** The auth service provided to transport/tool layers. */
export interface WebAuthService {
    /**
     * True when the request carries a valid session cookie.
     * Loopback-only mode is implicitly trusted (no session required).
     */
    authenticate(request: IncomingMessage): boolean;
}
/**
 * Install the auth policy after the web server has bound.
 * @param ctx - plugin context with `webServer` and `webStartup`.
 * @param config - resolved plugin config.
 */
export declare function apply(ctx: Context, _config: Config): void;
