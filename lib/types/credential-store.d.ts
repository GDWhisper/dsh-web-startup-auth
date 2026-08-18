/**
 * File-based credential store for the auth plugin.
 *
 * Stores username, password hash, and session HMAC secret in
 * `~/.dsh/web-auth.json`. Created on first registration; read on every
 * authentication and session-verification.
 */
/** Minimum password length for registration and the CLI password reset. */
export declare const MIN_PASSWORD_LENGTH = 8;
declare function credentialFile(): string;
/** In-memory snapshot of the credential file (re-read on every auth). */
interface CredentialFile {
    /** The configured username. */
    username: string;
    /** `salt:hash` where hash = scryptSync(password, salt, 64)` */
    passwordHash: string;
    /** Random hex used to sign session cookies. */
    secret: string;
}
/** Hash a password with a salt using scrypt. */
declare function hashPassword(password: string, salt: string): string;
/** Generate a random salt (16 bytes hex). */
declare function makeSalt(): string;
/** Generate a random session secret (32 bytes hex). */
declare function makeSecret(): string;
/**
 * Read the credential file if it exists.
 * @returns the stored credentials, or `undefined` if not registered.
 */
declare function readCredentials(): CredentialFile | undefined;
/** Ensure the credential directory exists (owner-only access). */
declare function ensureDir(): void;
/**
 * Write the credential file (creates the directory if needed).
 *
 * The file is written owner-only (0o600): it holds the scrypt password hash
 * and the session HMAC secret, so group/other readers could crack the
 * password offline or forge session cookies outright.
 * @param data - the credentials to persist.
 */
declare function writeCredentials(data: CredentialFile): void;
/**
 * Restrict an existing credential file to owner-only access.
 *
 * Fixes files created by earlier versions that followed the process umask
 * (commonly 0o644), which would let other local users read the session
 * signing secret and forge cookies. No-op when the file does not exist yet.
 */
export declare function hardenCredentialFilePermissions(): void;
/** Whether a username/password has been registered. */
export declare function hasCredentials(): boolean;
/**
 * Register a new username/password. Throws if credentials already exist.
 * @param username - the username.
 * @param password - the password.
 * @returns the newly created secret (for session signing).
 */
export declare function registerCredentials(username: string, password: string): string;
/**
 * Validate a username/password against the stored credentials.
 * @param username - the candidate username.
 * @param password - the candidate password.
 * @returns `true` if the credentials match.
 */
export declare function validateCredentials(username: string, password: string): boolean;
/**
 * Replace the stored password (keeps the username).
 *
 * Also rotates the session signing secret, which invalidates every already
 * issued session cookie — resetting a forgotten password therefore signs the
 * previous administrator out everywhere at once.
 * @param newPassword - the replacement password.
 * @throws when no credentials exist yet.
 */
export declare function resetPassword(newPassword: string): void;
/**
 * Change the stored password after verifying the old one.
 *
 * Rotates the session signing secret (like {@link resetPassword}), which
 * invalidates every already-issued session cookie — the caller must re-issue
 * a fresh session for the authenticated user.
 * @param oldPassword - the current password (verified against the store).
 * @param newPassword - the replacement password.
 * @returns `true` when the old password matched and the change was applied.
 */
export declare function changePassword(oldPassword: string, newPassword: string): boolean;
/**
 * Get the configured username, if credentials are set.
 * @returns the username, or `undefined` when not registered.
 */
export declare function getUsername(): string | undefined;
/**
 * Get the session HMAC secret.
 * @returns the secret, or `undefined` if not registered.
 */
export declare function getSessionSecret(): string | undefined;
/**
 * Sign a session payload (username + exp) with the stored secret.
 * @param payload - serialized JSON payload to sign.
 * @returns the signature (hex).
 */
export declare function signSession(payload: string): string | undefined;
/**
 * Verify a signed session payload.
 * @param payload - the payload that was signed.
 * @param signature - the signature to verify.
 * @returns `true` if the signature matches.
 */
export declare function verifySession(payload: string, signature: string): boolean;
/** @internal export for testing. */
export declare const internals: {
    credentialFile: typeof credentialFile;
    makeSalt: typeof makeSalt;
    makeSecret: typeof makeSecret;
    hashPassword: typeof hashPassword;
    readCredentials: typeof readCredentials;
    writeCredentials: typeof writeCredentials;
    ensureDir: typeof ensureDir;
};
export {};
