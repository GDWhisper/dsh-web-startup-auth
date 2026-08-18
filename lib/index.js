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
 * - `dsh-web-startup-auth/client` — browser half: the settings-panel auth tab.
 */
/**
 * Host plugin body for the browser implementation exported from `./client`.
 *
 * The package root is a loader entry named by the package itself, so
 * `ClientModuleRegistry` (dsh-client-modules) scans this package's `dsh.client`
 * declaration and composes `lib/client.js` into `window.__DSH_BOOT__`. The
 * node half carries no host-side behavior (mirrors `ui-settings`).
 */
export function apply() { }
