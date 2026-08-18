/**
 * @module dsh-web-startup-auth
 *
 * Remote-aware web-startup replacement + auth plugin.
 *
 * Plugins are exposed as independent subpath entries:
 * - `dsh-web-startup-auth/startup` — replacement for `@deepseek-ai/dsh-web-app/startup`
 *   that accepts `--host 0.0.0.0`.
 * - `dsh-web-startup-auth/auth` — auth guard with a login/register page and
 *   signed-session cookies when binding to all interfaces.
 */
export {};
