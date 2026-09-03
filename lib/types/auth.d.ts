/**
 * Auth plugin for remote dsh Web access with front-end login/register.
 *
 * Responsibilities:
 * - Refuse to start with `--host 0.0.0.0` unless credentials can be managed.
 * - Serve a login/register page at `/login`.
 * - Provide session management (signed cookies, 14-day expiry).
 * - Protect every registered route by wrapping the webserver's registration.
 * - Bridge dsh 0.1.2's native browser authentication: mint the native
 *   `dsh-auth-*` cookie for callers our session layer already trusts, so a
 *   `dsh_sid` session (or a genuine loopback request) clears the upstream
 *   `isAuthenticated` fence without exposing the launch-token URL flow.
 * - Provide a `webAuth` service that downstream transport layers can use.
 *
 * Wire-level enforcement:
 *   The plugin wraps `ctx.webServer.register` to inject a session check into
 *   every registered route (except `/login` and `/api/auth/*`). The
 *   `connection` row must inject `webAuth` so it activates after this plugin.
 *
 * Trust model (dsh 0.1.2):
 *   Upstream now runs its own browser auth (`browser-auth.ts`): the `/api`
 *   fence is `trust fence (403) + native-cookie check (401)` with NO loopback
 *   exemption, and `index.html` is gated the same way. A valid `dsh_sid`
 *   session — or a genuine loopback request (loopback peer address *and*
 *   loopback `Host`, see `isTrustedOrigin`) — passes our wrapper, and the
 *   wrapper mints the native cookie on the fly (single 303 hop for page
 *   navigations) so the very next request satisfies upstream. The bind
 *   address alone is not a trust signal: binding to 127.0.0.1 behind a
 *   reverse proxy still serves remote clients, whose forwarded `Host` names
 *   the public domain.
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
     * True when the request carries a valid session cookie, or when it is a
     * genuine loopback request (loopback peer address *and* loopback `Host`),
     * which is implicitly trusted and needs no session.
     */
    authenticate(request: IncomingMessage): boolean;
}
/**
 * Install the auth policy after the web server has bound.
 * @param ctx - plugin context with `webServer` and `webStartup`.
 * @param config - resolved plugin config.
 */
export declare function apply(ctx: Context, _config: Config): void;
