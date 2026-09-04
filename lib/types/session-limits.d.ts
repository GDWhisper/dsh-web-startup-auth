/**
 * Shared session-lifetime constants for the `dsh_sid` cookie.
 *
 * Dependency-free on purpose: the node half (credential-store / auth) and the
 * browser half (client bundle) both import it, so it must stay free of
 * `node:*` imports for tsdown to inline it into `lib/client.js`.
 */
/** Admin-selectable session lifetimes, in days (settings tab "会话有效期"). */
export declare const SESSION_MAX_AGE_CHOICES: readonly [3, 7, 14, 30, 60, 90, 180];
/** Session lifetime used when the stored value is missing or invalid. */
export declare const DEFAULT_SESSION_MAX_AGE_DAYS: number;
/** Whether `value` is one of the admin-selectable session lifetimes. */
export declare function isValidSessionMaxAgeDays(value: unknown): value is number;
