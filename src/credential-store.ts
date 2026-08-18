/**
 * File-based credential store for the auth plugin.
 *
 * Stores username, password hash, and session HMAC secret in
 * `~/.dsh/web-auth.json`. Created on first registration; read on every
 * authentication and session-verification.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync, createHmac } from 'node:crypto'

/** Minimum password length for registration and the CLI password reset. */
export const MIN_PASSWORD_LENGTH = 8

/** The persisted credential file (overridable via DSH_WEB_AUTH_FILE for tests). */
const CREDENTIAL_DIR = join(homedir(), '.dsh')
function credentialFile(): string {
  return process.env.DSH_WEB_AUTH_FILE ?? join(CREDENTIAL_DIR, 'web-auth.json')
}

/** In-memory snapshot of the credential file (re-read on every auth). */
interface CredentialFile {
  /** The configured username. */
  username: string
  /** `salt:hash` where hash = scryptSync(password, salt, 64)` */
  passwordHash: string
  /** Random hex used to sign session cookies. */
  secret: string
}

/** Hash a password with a salt using scrypt. */
function hashPassword(password: string, salt: string): string {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Generate a random salt (16 bytes hex). */
function makeSalt(): string {
  return randomBytes(16).toString('hex')
}

/** Generate a random session secret (32 bytes hex). */
function makeSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Read the credential file if it exists.
 * @returns the stored credentials, or `undefined` if not registered.
 */
function readCredentials(): CredentialFile | undefined {
  if (!existsSync(credentialFile())) return undefined
  try {
    return JSON.parse(readFileSync(credentialFile(), 'utf8')) as CredentialFile
  } catch {
    return undefined
  }
}

/** Ensure the credential directory exists (owner-only access). */
function ensureDir(): void {
  if (!existsSync(CREDENTIAL_DIR)) {
    mkdirSync(CREDENTIAL_DIR, { recursive: true, mode: 0o700 })
  }
}

/**
 * Write the credential file (creates the directory if needed).
 *
 * The file is written owner-only (0o600): it holds the scrypt password hash
 * and the session HMAC secret, so group/other readers could crack the
 * password offline or forge session cookies outright.
 * @param data - the credentials to persist.
 */
function writeCredentials(data: CredentialFile): void {
  ensureDir()
  writeFileSync(credentialFile(), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Restrict an existing credential file to owner-only access.
 *
 * Fixes files created by earlier versions that followed the process umask
 * (commonly 0o644), which would let other local users read the session
 * signing secret and forge cookies. No-op when the file does not exist yet.
 */
export function hardenCredentialFilePermissions(): void {
  if (existsSync(credentialFile())) {
    chmodSync(credentialFile(), 0o600)
  }
}

/** Whether a username/password has been registered. */
export function hasCredentials(): boolean {
  return readCredentials() !== undefined
}

/**
 * Register a new username/password. Throws if credentials already exist.
 * @param username - the username.
 * @param password - the password.
 * @returns the newly created secret (for session signing).
 */
export function registerCredentials(username: string, password: string): string {
  if (hasCredentials()) {
    throw new Error('web-auth: credentials already registered')
  }
  const salt = makeSalt()
  const secret = makeSecret()
  const passwordHash = hashPassword(password, salt)
  writeCredentials({ username, passwordHash, secret })
  return secret
}

/**
 * Validate a username/password against the stored credentials.
 * @param username - the candidate username.
 * @param password - the candidate password.
 * @returns `true` if the credentials match.
 */
export function validateCredentials(username: string, password: string): boolean {
  const creds = readCredentials()
  if (creds === undefined) return false
  if (creds.username !== username) return false
  const [salt, storedHash] = creds.passwordHash.split(':')
  const candidateHash = hashPassword(password, salt)
  return candidateHash === creds.passwordHash
}

/**
 * Replace the stored password (keeps the username).
 *
 * Also rotates the session signing secret, which invalidates every already
 * issued session cookie — resetting a forgotten password therefore signs the
 * previous administrator out everywhere at once.
 * @param newPassword - the replacement password.
 * @throws when no credentials exist yet.
 */
export function resetPassword(newPassword: string): void {
  const creds = readCredentials()
  if (creds === undefined) {
    throw new Error('web-auth: no credentials to reset')
  }
  const salt = makeSalt()
  const secret = makeSecret()
  writeCredentials({
    username: creds.username,
    passwordHash: hashPassword(newPassword, salt),
    secret,
  })
}

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
export function changePassword(oldPassword: string, newPassword: string): boolean {
  const creds = readCredentials()
  if (creds === undefined) return false
  if (!validateCredentials(creds.username, oldPassword)) return false
  resetPassword(newPassword)
  return true
}

/**
 * Get the configured username, if credentials are set.
 * @returns the username, or `undefined` when not registered.
 */
export function getUsername(): string | undefined {
  return readCredentials()?.username
}

/**
 * Get the session HMAC secret.
 * @returns the secret, or `undefined` if not registered.
 */
export function getSessionSecret(): string | undefined {
  const creds = readCredentials()
  return creds?.secret
}

/**
 * Sign a session payload (username + exp) with the stored secret.
 * @param payload - serialized JSON payload to sign.
 * @returns the signature (hex).
 */
export function signSession(payload: string): string | undefined {
  const secret = getSessionSecret()
  if (secret === undefined) return undefined
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Verify a signed session payload.
 * @param payload - the payload that was signed.
 * @param signature - the signature to verify.
 * @returns `true` if the signature matches.
 */
export function verifySession(payload: string, signature: string): boolean {
  const expected = signSession(payload)
  if (expected === undefined) return false
  // Constant-time comparison
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/** @internal export for testing. */
export const internals = {
  credentialFile,
  makeSalt,
  makeSecret,
  hashPassword,
  readCredentials,
  writeCredentials,
  ensureDir,
}