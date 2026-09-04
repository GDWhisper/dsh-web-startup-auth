/**
 * Shared session-lifetime constants for the `dsh_sid` cookie.
 *
 * Dependency-free on purpose: the node half (credential-store / auth) and the
 * browser half (client bundle) both import it, so it must stay free of
 * `node:*` imports for tsdown to inline it into `lib/client.js`.
 */
/** Admin-selectable session lifetimes, in days (settings tab "会话有效期"). */
export const SESSION_MAX_AGE_CHOICES = [3, 7, 14, 30, 60, 90, 180];
/** Session lifetime used when the stored value is missing or invalid. */
export const DEFAULT_SESSION_MAX_AGE_DAYS = 14;
/** Whether `value` is one of the admin-selectable session lifetimes. */
export function isValidSessionMaxAgeDays(value) {
    return typeof value === 'number' && Number.isInteger(value)
        && SESSION_MAX_AGE_CHOICES.includes(value);
}
