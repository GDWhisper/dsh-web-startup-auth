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
import z from '@deepseek-ai/schemastery';
import { createHash, createHmac } from 'node:crypto';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { WEB_STARTUP_SERVICE } from "./startup.js";
import { LOGIN_PAGE_HTML } from "./login-page.js";
import { hasCredentials, registerCredentials, validateCredentials, signSession, verifySession, hardenCredentialFilePermissions, changePassword, changeUsername, getUsername, normalizeUsername, MIN_PASSWORD_LENGTH, } from "./credential-store.js";
/** Stable Cordis plugin name. */
export const name = 'web-auth';
/** Services required before the auth policy can be installed. */
export const inject = ['webServer', 'webStartup'];
export const Config = z.object({});
/** Session cookie name. */
const SESSION_COOKIE = 'dsh_sid';
/** Session lifetime in seconds (14 days). */
const SESSION_MAX_AGE_SEC = 14 * 24 * 60 * 60;
/** Maximum accepted request body, guarding the auth endpoints against memory exhaustion. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Login attempts allowed before a client is temporarily locked out. */
const MAX_LOGIN_FAILURES = 5;
/** How long a client stays locked out after exhausting the attempts. */
const LOCKOUT_MS = 30_000;
/** Rolling window in which failures count towards a lockout. */
const FAILURE_TRACKING_WINDOW_MS = 10 * 60_000;
const loginFailures = new Map();
/**
 * Client socket address for rate limiting and audit logs.
 * Deliberately NOT the `X-Forwarded-For` header, which clients can forge.
 */
function clientIp(req) {
    return req.socket?.remoteAddress;
}
/** Whether this client is currently locked out of the login endpoint. */
function isLockedOut(req) {
    const entry = loginFailures.get(clientIp(req) ?? '');
    return entry?.lockedUntil !== undefined && entry.lockedUntil > Date.now();
}
/** Record a failed login; locks the client out after repeated failures. */
function recordLoginFailure(req) {
    const ip = clientIp(req);
    if (ip === undefined)
        return;
    const now = Date.now();
    const entry = loginFailures.get(ip);
    if (entry === undefined || now - entry.firstAt > FAILURE_TRACKING_WINDOW_MS) {
        loginFailures.set(ip, { count: 1, firstAt: now });
        return;
    }
    entry.count += 1;
    if (entry.count >= MAX_LOGIN_FAILURES) {
        entry.lockedUntil = now + LOCKOUT_MS;
    }
}
/** Clear the failure state after a successful login. */
function recordLoginSuccess(req) {
    const ip = clientIp(req);
    if (ip !== undefined)
        loginFailures.delete(ip);
}
/**
 * Drop stale failure entries so the tracking map cannot grow without bound
 * when attackers spoof socket addresses from many sources.
 */
function pruneLoginFailures(now = Date.now()) {
    if (loginFailures.size < 1024)
        return;
    for (const [ip, entry] of loginFailures) {
        if (now - entry.firstAt > FAILURE_TRACKING_WINDOW_MS) {
            loginFailures.delete(ip);
        }
        else if (entry.lockedUntil !== undefined && entry.lockedUntil < now) {
            loginFailures.delete(ip);
        }
    }
}
/** Cookie header string for a session cookie with 14-day expiry. */
function sessionCookieSet(value) {
    return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`;
}
/** Clear the session cookie. */
const SESSION_CLEAR = `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
/** Parse the session cookie from a request. */
function parseSessionCookie(req) {
    const cookie = req.headers.cookie;
    if (!cookie)
        return undefined;
    // Simple cookie parser (no full RFC compliance needed for a single cookie)
    const start = cookie.indexOf(SESSION_COOKIE + '=');
    if (start === -1)
        return undefined;
    const valueStart = start + SESSION_COOKIE.length + 1;
    const end = cookie.indexOf(';', valueStart);
    return end === -1 ? cookie.slice(valueStart) : cookie.slice(valueStart, end);
}
/** Build a session payload (username + expiry) and sign it. */
function buildSessionCookie(username) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
    const payload = JSON.stringify({ u: username, e: exp });
    const sig = signSession(payload);
    if (sig === undefined)
        return undefined;
    return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}
/** Validate a session cookie and return the username if valid. */
function validateSessionCookie(req) {
    const raw = parseSessionCookie(req);
    if (!raw)
        return undefined;
    const dot = raw.indexOf('.');
    if (dot === -1)
        return undefined;
    const payloadBase64 = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    let payload;
    try {
        payload = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    }
    catch {
        return undefined;
    }
    if (!verifySession(payload, sig))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return undefined;
    }
    if (typeof parsed.u !== 'string' || typeof parsed.e !== 'number')
        return undefined;
    // Check expiry
    if (parsed.e < Math.floor(Date.now() / 1000))
        return undefined;
    return parsed.u;
}
/** Parse a JSON body from an incoming request, capped at MAX_BODY_BYTES. */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}
/** True when the parse body rejection was the size cap. */
function isBodyTooLarge(error) {
    return error instanceof Error && error.message === 'request body too large';
}
/** True when registration raced another concurrent registration. */
function isAlreadyRegistered(error) {
    return error instanceof Error && error.message.includes('already registered');
}
/** Send a JSON response. */
function jsonResponse(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
}
/**
 * Check if the request is authorized (a genuine loopback request or a valid
 * session cookie).
 * @param req - the incoming HTTP request.
 * @returns `true` if the request is allowed.
 */
function isAuthorized(req) {
    if (isTrustedOrigin(req))
        return true;
    return validateSessionCookie(req) !== undefined;
}
/** Loopback hostnames (same classification as dsh's own browser-trust fence). */
const LOOPBACK_HOSTNAMES = ['localhost', '[::1]'];
/**
 * Whether a `Host` header authority is a loopback authority.
 * @param host - the raw `Host` header value.
 * @returns `true` for localhost, IPv6 loopback, or 127/8 IPv4.
 */
function isLoopbackAuthority(host) {
    if (host === undefined)
        return false;
    let hostname;
    try {
        hostname = new URL(`http://${host}`).hostname;
    }
    catch {
        return false;
    }
    if (LOOPBACK_HOSTNAMES.includes(hostname))
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' &&
        parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
 * Whether a TCP peer address is a loopback address.
 *
 * Only the socket's own peer address counts. `X-Forwarded-For` and friends are
 * client-supplied headers and are never consulted: a reverse proxy that wants
 * its clients treated as remote has to forward the real `Host`, which is the
 * signal the loopback check below reads.
 * @param address - `req.socket.remoteAddress`, if any.
 * @returns `true` for 127/8 IPv4 (including IPv4-mapped IPv6) and IPv6 loopback.
 */
function isLoopbackRemoteAddress(address) {
    if (address === undefined)
        return false;
    // Node reports IPv4 peers on a dual-stack socket as `::ffff:127.0.0.1`.
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (normalized === '::1')
        return true;
    const parts = normalized.split('.');
    return parts.length === 4 && parts[0] === '127' &&
        parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
 * Whether the request itself is a loopback request, and therefore implicitly
 * trusted without a session.
 *
 * Both halves are required, because each one alone is forgeable or
 * insufficient:
 * - The `Host` header alone is forgeable: an attacker reaching the server over
 *   the LAN can send `Host: 127.0.0.1`. The socket's peer address cannot be
 *   forged by anyone who is not already on the loopback interface.
 * - The peer address alone misses reverse proxies: a proxy on the same host
 *   connects from 127.0.0.1 while its client is remote, so the forwarded
 *   `Host` (the external domain) is what distinguishes that case from a
 *   genuine local browser.
 *
 * A host-local caller that reaches the server over loopback *and* claims a
 * loopback authority is already a local user, so implicit trust is safe.
 * @param req - the incoming HTTP request.
 * @returns `true` when the request needs no session cookie.
 */
function isTrustedOrigin(req) {
    return isLoopbackRemoteAddress(req.socket?.remoteAddress) &&
        isLoopbackAuthority(req.headers.host);
}
const BROWSER_COOKIE_PREFIX = 'dsh-auth-';
const BROWSER_COOKIE_VERSION = 1;
const BROWSER_SECRET_BYTES = 32;
/** Aligns with upstream `cookieMaxAgeDays` default (30 days). */
const BROWSER_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const BROWSER_AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session');
/** Credential provider lookup, installed by `apply`; absent in unit tests. */
let lookupCredentials;
/**
 * Cached native signing secrets, keyed by the credentials service instance:
 * a fresh provider (including every test double) re-reads its own record,
 * so rotating or replacing the service never serves a stale key.
 */
const browserSecretCache = new WeakMap();
/**
 * Canonical request authority, exactly as upstream computes it
 * (`browser-auth.ts` `requestAuthority`): the `URL`-normalized host, which
 * lowercases and strips default ports. The cookie name is derived from this
 * value, so any mismatch would produce a cookie upstream never looks for.
 */
function requestAuthority(headers) {
    const host = headers.host;
    if (host === undefined)
        return undefined;
    try {
        return new URL(`http://${host}`).host;
    }
    catch {
        return undefined;
    }
}
/** Native cookie name for an authority (`dsh-auth-` + base64url(sha256)). */
function browserCookieName(authority) {
    const digest = createHash('sha256').update(authority).digest();
    return BROWSER_COOKIE_PREFIX + digest.toString('base64url');
}
/** Read the exact generated native cookie without general Cookie decoding. */
function readBrowserCookie(headers, authority) {
    const raw = headers.cookie;
    if (raw === undefined)
        return undefined;
    const name = browserCookieName(authority);
    for (const segment of raw.split(';')) {
        const at = segment.indexOf('=');
        if (at === -1 || segment.slice(0, at).trim() !== name)
            continue;
        return segment.slice(at + 1).trim();
    }
    return undefined;
}
/**
 * Load (and cache) the native signing secret from the credentials service.
 * Returns undefined while the record does not exist yet — the caller skips
 * minting this request and retries on the next one. The record is never
 * created here: the key belongs to the connection plugin.
 */
async function browserAuthSecret() {
    const credentials = lookupCredentials?.();
    if (credentials === undefined)
        return undefined;
    const cached = browserSecretCache.get(credentials);
    if (cached !== undefined)
        return cached;
    try {
        const record = await credentials.readRecord(BROWSER_AUTH_RECORD_KEY);
        if (record === undefined || record === null)
            return undefined;
        if (record.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') {
            return undefined;
        }
        const payload = record.payload;
        if (payload.version !== BROWSER_COOKIE_VERSION || typeof payload.secret !== 'string') {
            return undefined;
        }
        const secret = Buffer.from(payload.secret, 'base64url');
        if (secret.length !== BROWSER_SECRET_BYTES)
            return undefined;
        browserSecretCache.set(credentials, secret);
        return secret;
    }
    catch {
        return undefined;
    }
}
/**
 * Serialize the native cookie value: `v1.<base64url(payload)>.<base64url(hmac)>`
 * where the HMAC covers the base64url payload string itself — byte-for-byte
 * the format upstream `decodeCookie` expects.
 */
function encodeBrowserCookie(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', secret).update(body).digest().toString('base64url');
    return `v1.${body}.${signature}`;
}
/** Cookie attributes copied from upstream `sessionCookie`. */
function browserCookieAttributes(expiresAt) {
    return `; Max-Age=${String(BROWSER_COOKIE_MAX_AGE_SEC)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
}
/**
 * Mint a `Set-Cookie` value for the native browser-auth cookie, bound to the
 * request's own authority. Returns undefined when the authority is missing
 * or the signing secret is not available yet (retry on the next request).
 */
async function mintBrowserCookie(req) {
    const secret = await browserAuthSecret();
    if (secret === undefined)
        return undefined;
    const authority = requestAuthority(req.headers);
    if (authority === undefined)
        return undefined;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + BROWSER_COOKIE_MAX_AGE_SEC * 1000;
    const value = encodeBrowserCookie({ version: BROWSER_COOKIE_VERSION, authority, issuedAt, expiresAt }, secret);
    return `${browserCookieName(authority)}=${value}${browserCookieAttributes(expiresAt)}`;
}
/**
 * Clear the native cookie for the request's authority. The name is derivable
 * without the secret, so logout can always emit this.
 */
function clearBrowserCookie(req) {
    const authority = requestAuthority(req.headers);
    if (authority === undefined)
        return undefined;
    return `${browserCookieName(authority)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
}
/** True when the request looks like a page navigation (vs an XHR/fetch). */
function isPageNavigation(req) {
    const mode = req.headers['sec-fetch-mode'];
    if (typeof mode === 'string' && mode !== 'navigate')
        return false;
    if (mode === undefined) {
        const accept = req.headers.accept;
        return typeof accept === 'string' && accept.includes('text/html');
    }
    return true;
}
/**
 * Install the auth policy after the web server has bound.
 * @param ctx - plugin context with `webServer` and `webStartup`.
 * @param config - resolved plugin config.
 */
export function apply(ctx, _config) {
    const webServer = ctx.webServer;
    const bindHost = webServer.host;
    // The credentials service is owned by the credentials plugin; look it up
    // lazily (it may activate after web-auth) instead of declaring an inject,
    // so a missing service degrades to "no native cookie minting" rather than
    // taking the auth layer down.
    lookupCredentials = () => ctx.get('credentials');
    // Restrict an existing credential file (created by an earlier version that
    // followed the umask) to owner-only access before serving any traffic.
    hardenCredentialFilePermissions();
    // ── 1. Register the login page route ──────────────────────────────────────
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/login',
        handler: (req, res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(LOGIN_PAGE_HTML);
        },
    }), 'web-auth: /login route');
    // ── 2. Register auth API endpoints ────────────────────────────────────────
    const authEndpoints = [
        {
            kind: 'exact',
            path: '/api/auth/status',
            handler: async (req, res) => {
                const registered = hasCredentials();
                const authenticated = isAuthorized(req);
                // Username is only exposed once authenticated: a trusted (loopback)
                // origin gets the stored username, a remote caller only its own session.
                const username = authenticated
                    ? (isTrustedOrigin(req) ? getUsername() : validateSessionCookie(req))
                    : undefined;
                jsonResponse(res, 200, { registered, authenticated, username });
            },
        },
        {
            kind: 'exact',
            path: '/api/auth/register',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                try {
                    const body = await parseBody(req);
                    const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
                    const password = typeof body.password === 'string' ? body.password : '';
                    if (!username || !password) {
                        jsonResponse(res, 400, { error: '请输入用户名和密码' });
                        return;
                    }
                    if (password.length < MIN_PASSWORD_LENGTH) {
                        jsonResponse(res, 400, { error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` });
                        return;
                    }
                    if (hasCredentials()) {
                        jsonResponse(res, 400, { error: '管理员账号已设置，不能重复注册' });
                        return;
                    }
                    registerCredentials(username, password);
                    ctx.logger.info('web-auth: administrator registered (%s)', username);
                    // Create a session cookie for the newly registered user
                    const cookie = buildSessionCookie(username);
                    if (cookie === undefined) {
                        jsonResponse(res, 500, { error: '服务器内部错误' });
                        return;
                    }
                    const cookies = [sessionCookieSet(cookie)];
                    const native = await mintBrowserCookie(req);
                    if (native !== undefined)
                        cookies.push(native);
                    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (error) {
                    if (isBodyTooLarge(error)) {
                        jsonResponse(res, 413, { error: '请求体过大' });
                        return;
                    }
                    if (isAlreadyRegistered(error)) {
                        // Raced another concurrent registration that won
                        jsonResponse(res, 409, { error: '管理员账号已设置，不能重复注册' });
                        return;
                    }
                    ctx.logger.warn('web-auth: register failed: %s', error instanceof Error ? error.message : String(error));
                    jsonResponse(res, 500, { error: '服务器内部错误' });
                }
            },
        },
        {
            kind: 'exact',
            path: '/api/auth/login',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                try {
                    pruneLoginFailures();
                    if (isLockedOut(req)) {
                        ctx.logger.warn('web-auth: login rate-limited (from %s)', clientIp(req) ?? 'unknown');
                        jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' });
                        return;
                    }
                    const body = await parseBody(req);
                    const username = typeof body.username === 'string' ? normalizeUsername(body.username) : '';
                    const password = typeof body.password === 'string' ? body.password : '';
                    if (!username || !password) {
                        jsonResponse(res, 400, { error: '请输入用户名和密码' });
                        return;
                    }
                    if (!validateCredentials(username, password)) {
                        recordLoginFailure(req);
                        ctx.logger.warn('web-auth: login failed (from %s)', clientIp(req) ?? 'unknown');
                        jsonResponse(res, 401, { error: '用户名或密码错误' });
                        return;
                    }
                    recordLoginSuccess(req);
                    ctx.logger.info('web-auth: login ok (%s, from %s)', username, clientIp(req) ?? 'unknown');
                    const cookie = buildSessionCookie(username);
                    if (cookie === undefined) {
                        jsonResponse(res, 500, { error: '服务器内部错误' });
                        return;
                    }
                    const cookies = [sessionCookieSet(cookie)];
                    const native = await mintBrowserCookie(req);
                    if (native !== undefined)
                        cookies.push(native);
                    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (error) {
                    if (isBodyTooLarge(error)) {
                        jsonResponse(res, 413, { error: '请求体过大' });
                        return;
                    }
                    ctx.logger.warn('web-auth: login failed: %s', error instanceof Error ? error.message : String(error));
                    jsonResponse(res, 500, { error: '服务器内部错误' });
                }
            },
        },
        {
            kind: 'exact',
            path: '/api/auth/logout',
            handler: async (req, res) => {
                // Clear our session cookie, and the native browser-auth cookie for
                // this authority (its name is derivable without the secret). The
                // native cookie alone cannot restore access — our wrapper rejects
                // any request without a valid `dsh_sid` — but clearing it keeps the
                // browser consistent with the signed-out state.
                const cookies = [SESSION_CLEAR];
                const nativeClear = clearBrowserCookie(req);
                if (nativeClear !== undefined)
                    cookies.push(nativeClear);
                res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
                res.end(JSON.stringify({ ok: true }));
            },
        },
        {
            kind: 'exact',
            path: '/api/auth/change-password',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                // Change-password requires an authenticated caller: a session cookie
                // for a remote caller, or the implicit trust granted to a genuine
                // loopback request. Rate limiting mirrors the login endpoint.
                try {
                    pruneLoginFailures();
                    if (!isAuthorized(req)) {
                        jsonResponse(res, 401, { error: '未登录或会话已过期' });
                        return;
                    }
                    if (isLockedOut(req)) {
                        jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' });
                        return;
                    }
                    const body = await parseBody(req);
                    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
                    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
                    if (!oldPassword || !newPassword) {
                        jsonResponse(res, 400, { error: '请输入旧密码和新密码' });
                        return;
                    }
                    if (newPassword.length < MIN_PASSWORD_LENGTH) {
                        jsonResponse(res, 400, { error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` });
                        return;
                    }
                    // Capture the identity BEFORE changePassword: it rotates the signing
                    // secret, after which the old session cookie no longer verifies.
                    const username = isTrustedOrigin(req)
                        ? getUsername()
                        : validateSessionCookie(req);
                    if (username === undefined) {
                        jsonResponse(res, 401, { error: '未登录或会话已过期' });
                        return;
                    }
                    if (!changePassword(oldPassword, newPassword)) {
                        recordLoginFailure(req);
                        ctx.logger.warn('web-auth: change-password failed (from %s)', clientIp(req) ?? 'unknown');
                        jsonResponse(res, 401, { error: '旧密码错误' });
                        return;
                    }
                    recordLoginSuccess(req);
                    ctx.logger.info('web-auth: password changed (from %s)', clientIp(req) ?? 'unknown');
                    // changePassword rotates the signing secret, invalidating every
                    // previously issued session cookie — re-issue one for this caller.
                    const cookie = buildSessionCookie(username);
                    if (cookie === undefined) {
                        jsonResponse(res, 500, { error: '服务器内部错误' });
                        return;
                    }
                    const cookies = [sessionCookieSet(cookie)];
                    const native = await mintBrowserCookie(req);
                    if (native !== undefined)
                        cookies.push(native);
                    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (error) {
                    if (isBodyTooLarge(error)) {
                        jsonResponse(res, 413, { error: '请求体过大' });
                        return;
                    }
                    ctx.logger.warn('web-auth: change-password failed: %s', error instanceof Error ? error.message : String(error));
                    jsonResponse(res, 500, { error: '服务器内部错误' });
                }
            },
        },
        {
            kind: 'exact',
            path: '/api/auth/change-username',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                // Same contract as change-password: an authenticated caller (session
                // cookie for a remote caller, or genuine loopback trust) plus the
                // current password. Rate limiting mirrors the login endpoint.
                try {
                    pruneLoginFailures();
                    if (!isAuthorized(req)) {
                        jsonResponse(res, 401, { error: '未登录或会话已过期' });
                        return;
                    }
                    if (isLockedOut(req)) {
                        jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' });
                        return;
                    }
                    const body = await parseBody(req);
                    const newUsername = typeof body.newUsername === 'string' ? normalizeUsername(body.newUsername) : '';
                    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
                    if (!newUsername || !currentPassword) {
                        jsonResponse(res, 400, { error: '请输入新用户名和当前密码' });
                        return;
                    }
                    // Capture the identity BEFORE changeUsername: it rotates the signing
                    // secret, after which the old session cookie no longer verifies.
                    const username = isTrustedOrigin(req)
                        ? getUsername()
                        : validateSessionCookie(req);
                    if (username === undefined) {
                        jsonResponse(res, 401, { error: '未登录或会话已过期' });
                        return;
                    }
                    if (newUsername === username) {
                        // No-op: nothing to rotate, so leave every session (including
                        // this caller's) untouched.
                        jsonResponse(res, 200, { ok: true, username });
                        return;
                    }
                    if (!changeUsername(newUsername, currentPassword)) {
                        recordLoginFailure(req);
                        ctx.logger.warn('web-auth: change-username failed (from %s)', clientIp(req) ?? 'unknown');
                        jsonResponse(res, 401, { error: '当前密码错误' });
                        return;
                    }
                    recordLoginSuccess(req);
                    ctx.logger.info('web-auth: username changed %s -> %s (from %s)', username, newUsername, clientIp(req) ?? 'unknown');
                    // changeUsername rotates the signing secret, invalidating every
                    // previously issued session cookie — re-issue one for this caller.
                    const cookie = buildSessionCookie(newUsername);
                    if (cookie === undefined) {
                        jsonResponse(res, 500, { error: '服务器内部错误' });
                        return;
                    }
                    const cookies = [sessionCookieSet(cookie)];
                    const native = await mintBrowserCookie(req);
                    if (native !== undefined)
                        cookies.push(native);
                    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookies });
                    res.end(JSON.stringify({ ok: true, username: newUsername }));
                }
                catch (error) {
                    if (isBodyTooLarge(error)) {
                        jsonResponse(res, 413, { error: '请求体过大' });
                        return;
                    }
                    ctx.logger.warn('web-auth: change-username failed: %s', error instanceof Error ? error.message : String(error));
                    jsonResponse(res, 500, { error: '服务器内部错误' });
                }
            },
        },
    ];
    for (const route of authEndpoints) {
        ctx.effect(() => webServer.register(route), `web-auth: ${route.path} route`);
    }
    // ── 3. Inject a redirect check into the SPA index ─────────────────────────
    // When the SPA boots without a valid session, send it to the login page.
    // Static assets still load without auth; the SPA shell redirects early.
    webServer.tapIndex((html) => {
        const script = `<script>
;(function () {
  // Remote (LAN) browsers must look loopback to ui-settings or its settings
  // mirror falls back to a process-local 'memory' mode that never reads the
  // host — the Models section then fails with "settings are unavailable in
  // this browser". ui-settings derives its persistence from
  // ctx.remote.$host.isLoopback, which follows connection.isLoopback;
  // the connection client (rc.1) computes that as "ownsHost || loopback
  // hostname". Declaring the transport hook with ownsHost=true flips the
  // value without rewriting the cordis service (the rc.8-0.1.1 approach that
  // 0.1.2's A/B showed breaking the web boot). The hook object must also be
  // tolerated by the connection client's other reads: api falls back to the
  // built-in WebApiClient when createApiClient is absent and the rpc fetch
  // defaults to globalThis.fetch, so an ownsHost-only stub is safe.
  window.__DSH_TRANSPORT__ = window.__DSH_TRANSPORT__ || { ownsHost: true };
  // Plain-HTTP LAN access (--host 0.0.0.0) is a non-secure context, where the
  // Web Crypto randomUUID member is unavailable. The web client's RPC layer
  // mints a request id with crypto.randomUUID on every unary call, so
  // without this polyfill every /api RPC (including the web-runtime
  // connection's readiness probe) throws TypeError: crypto.randomUUID is not
  // a function and the page's live connection never establishes. Polyfill it
  // from crypto.getRandomValues (available in non-secure contexts) before
  // any client bundle runs.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
    crypto.randomUUID = function () {
      var b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      var h = ''
      for (var i = 0; i < 16; i++) {
        if (i === 4 || i === 6 || i === 8 || i === 10) h += '-'
        var hex = b[i].toString(16)
        if (hex.length < 2) hex = '0' + hex
        h += hex
      }
      return h
    }
  }
  // Note (0.1.2): the browser-side connection.isLoopback override shipped
  // for rc.8-0.1.1 is GONE. In 0.1.2 upstream authenticates for real (native
  // cookie, no loopback exemption) and every remote-browser settings surface
  // (models, plugin cards, ...) works without forcing isLoopback=true - the
  // forced override actually broke the web boot (26 entries pending, A/B
  // verified 2026-09-03) because 0.1.2 code gates loopback-only paths on the
  // flag. The randomUUID polyfill below remains the only browser-side shim.
})()
;(async function () {
  try {
    var res = await fetch('/api/auth/status')
    var data = await res.json()
    // Redirect only when this very request is unauthorized. The
    // authenticated flag already accounts for loopback trust, so a local
    // browser (which needs no credentials at all) and an unregistered
    // deployment reached over the LAN must not both be sent to /login: gating
    // on "registered" as well used to bounce /login and / into each other.
    if (window.location.pathname !== '/login' && !data.authenticated) {
      window.location.replace('/login')
      return
    }
  } catch (error) {}
})()
</script>`;
        return html.replace('</head>', `${script}</head>`);
    });
    // ── 4. Wrap webServer.register / registerUpgrade to protect every route ──
    // dsh 0.1.2 gates `/api` behind `requestRejection = trust fence (403) +
    // native-cookie check (401)` and `index.html` behind `authorizeIndex`, with
    // NO loopback exemption. This wrapper is the session boundary: every
    // request must carry a valid `dsh_sid` (or be a genuine loopback request).
    // A valid native cookie alone is NOT accepted here — that cookie is
    // stateless, lives 30 days, and cannot be revoked, so logout / password
    // change / auth-reset only revoke `dsh_sid`; the wrapper is what keeps
    // those operations meaningful.
    //
    // Callers that pass this fence but lack the native cookie get it minted:
    // page navigations (GET/HEAD) receive a single 303 carrying the Set-Cookie
    // and bouncing to the same path — the same pattern as upstream's own
    // token-exchange redirect — so the very next request clears the native
    // fence. Non-navigations (RPC) are forwarded untouched: the browser
    // already holds the cookie from the page hop, and a 303 would turn an RPC
    // POST into a GET. While the upstream signing secret has not appeared yet
    // (the connection plugin creates it in its own apply), minting is skipped
    // and the next request retries.
    //
    // The wrapper must cover routes registered BEFORE this plugin activated:
    // cordis activation order is not the bundle/tree order (dynamic imports
    // finish out of order), so third-party plugins can register their routes
    // before web-auth runs. Their route objects live in the webserver's route
    // tables, so wrap them retroactively here.
    const originalRegister = webServer.register.bind(webServer);
    const originalRegisterUpgrade = webServer.registerUpgrade.bind(webServer);
    const originalRegisterFallback = webServer.registerFallback.bind(webServer);
    const wrappedHandlers = new WeakSet();
    const wrappedUpgrades = new WeakSet();
    const wrappedFallbacks = new WeakSet();
    /** Routes that must stay anonymous: the login page and our own auth API. */
    const isPublicRoute = (path) => path === '/login' || path.startsWith('/api/auth/');
    /** Wrap a protected request handler with the session check + minting hop. */
    const protect = (handler) => async (req, res) => {
        if (!isAuthorized(req)) {
            // Send page navigations to the login page; upstream's own
            // unauthenticated index answer is a bare-text 401.
            if ((req.method === 'GET' || req.method === 'HEAD') && isPageNavigation(req)) {
                res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
                res.end();
                return;
            }
            jsonResponse(res, 401, { error: 'unauthorized' });
            return;
        }
        const authority = requestAuthority(req.headers);
        if (authority !== undefined && readBrowserCookie(req.headers, authority) === undefined &&
            (req.method === 'GET' || req.method === 'HEAD')) {
            const minted = await mintBrowserCookie(req);
            if (minted !== undefined) {
                res.writeHead(303, {
                    location: req.url ?? '/',
                    'cache-control': 'no-store',
                    'set-cookie': minted,
                });
                res.end();
                return;
            }
        }
        await handler(req, res);
    };
    const wrapFallback = (handler) => {
        if (wrappedFallbacks.has(handler))
            return handler;
        wrappedFallbacks.add(handler);
        return protect(handler);
    };
    const wrapHandler = (route) => {
        if (wrappedHandlers.has(route) || isPublicRoute(route.path))
            return;
        wrappedHandlers.add(route);
        route.handler = protect(route.handler);
    };
    const wrapUpgradeHandler = (route) => {
        if (wrappedUpgrades.has(route) || isPublicRoute(route.path))
            return;
        wrappedUpgrades.add(route);
        const originalHandler = route.handler;
        route.handler = (req, socket, head) => {
            if (!isAuthorized(req)) {
                socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
                return;
            }
            // Upgrade responses cannot carry a Set-Cookie mid-handshake; the
            // browser issues the WS request after the page (and its minting hop)
            // completed, so the native cookie is already in place.
            return originalHandler(req, socket, head);
        };
    };
    // Retroactively wrap routes that were already registered before this
    // plugin activated (third-party plugins may have won the activation race).
    // The index fallback seat is wrapped too: in 0.1.2 the SPA index is served
    // through `webServer.registerFallback` (frontend-static), which sits
    // OUTSIDE the exact/prefix route tables and would otherwise answer every
    // unauthenticated index request with upstream's bare-text 401.
    const tables = webServer;
    for (const route of tables.exact?.values() ?? [])
        wrapHandler(route);
    for (const route of tables.prefixes?.values() ?? [])
        wrapHandler(route);
    for (const route of tables.upgrades?.values() ?? [])
        wrapUpgradeHandler(route);
    if (tables.fallback !== undefined)
        tables.fallback = wrapFallback(tables.fallback);
    // Wrap routes registered from now on.
    webServer.register = (route) => {
        wrapHandler(route);
        return originalRegister(route);
    };
    webServer.registerUpgrade = (route) => {
        wrapUpgradeHandler(route);
        return originalRegisterUpgrade(route);
    };
    webServer.registerFallback = (handler) => {
        return originalRegisterFallback(wrapFallback(handler));
    };
    // ── 5. Provide the auth service ───────────────────────────────────────────
    const service = {
        authenticate(request) {
            return isAuthorized(request);
        },
    };
    ctx.provide('webAuth', service);
    ctx.logger.info('web-auth: active (bind host %s, credentials: %s)', bindHost, hasCredentials() ? 'set' : 'not set');
    void ctx.get(WEB_STARTUP_SERVICE); // ensure injection is satisfied
}
