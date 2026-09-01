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
 *
 * Trust model:
 *   A request is trusted either by a valid session cookie, or by being a
 *   genuine loopback request — loopback peer address *and* loopback `Host`
 *   (see `isTrustedOrigin`). The bind address alone is not a trust signal:
 *   binding to 127.0.0.1 behind a reverse proxy still serves remote clients,
 *   whose forwarded `Host` names the public domain.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { WEB_STARTUP_SERVICE } from './startup.ts'
import { LOGIN_PAGE_HTML } from './login-page.ts'
import {
  hasCredentials,
  registerCredentials,
  validateCredentials,
  signSession,
  verifySession,
  hardenCredentialFilePermissions,
  changePassword,
  changeUsername,
  getUsername,
  normalizeUsername,
  MIN_PASSWORD_LENGTH,
} from './credential-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webAuth?: WebAuthService
  }
}

/** Stable Cordis plugin name. */
export const name = 'web-auth'

/** Services required before the auth policy can be installed. */
export const inject = ['webServer', 'webStartup']

/** Auth plugin configuration (no static config needed; credentials are stored on disk). */
export interface Config {}

export const Config: z<Config> = z.object({})

/** The auth service provided to transport/tool layers. */
export interface WebAuthService {
  /**
   * True when the request carries a valid session cookie, or when it is a
   * genuine loopback request (loopback peer address *and* loopback `Host`),
   * which is implicitly trusted and needs no session.
   */
  authenticate(request: IncomingMessage): boolean
}

/** Session cookie name. */
const SESSION_COOKIE = 'dsh_sid'

/** Session lifetime in seconds (14 days). */
const SESSION_MAX_AGE_SEC = 14 * 24 * 60 * 60

/** Maximum accepted request body, guarding the auth endpoints against memory exhaustion. */
const MAX_BODY_BYTES = 1024 * 1024

/** Login attempts allowed before a client is temporarily locked out. */
const MAX_LOGIN_FAILURES = 5

/** How long a client stays locked out after exhausting the attempts. */
const LOCKOUT_MS = 30_000

/** Rolling window in which failures count towards a lockout. */
const FAILURE_TRACKING_WINDOW_MS = 10 * 60_000

/** Per-client login failure tracking (memory only; keyed by socket address). */
interface LoginFailure {
  count: number
  firstAt: number
  lockedUntil?: number
}

const loginFailures = new Map<string, LoginFailure>()

/**
 * Client socket address for rate limiting and audit logs.
 * Deliberately NOT the `X-Forwarded-For` header, which clients can forge.
 */
function clientIp(req: IncomingMessage): string | undefined {
  return req.socket?.remoteAddress
}

/** Whether this client is currently locked out of the login endpoint. */
function isLockedOut(req: IncomingMessage): boolean {
  const entry = loginFailures.get(clientIp(req) ?? '')
  return entry?.lockedUntil !== undefined && entry.lockedUntil > Date.now()
}

/** Record a failed login; locks the client out after repeated failures. */
function recordLoginFailure(req: IncomingMessage): void {
  const ip = clientIp(req)
  if (ip === undefined) return
  const now = Date.now()
  const entry = loginFailures.get(ip)
  if (entry === undefined || now - entry.firstAt > FAILURE_TRACKING_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, firstAt: now })
    return
  }
  entry.count += 1
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS
  }
}

/** Clear the failure state after a successful login. */
function recordLoginSuccess(req: IncomingMessage): void {
  const ip = clientIp(req)
  if (ip !== undefined) loginFailures.delete(ip)
}

/**
 * Drop stale failure entries so the tracking map cannot grow without bound
 * when attackers spoof socket addresses from many sources.
 */
function pruneLoginFailures(now = Date.now()): void {
  if (loginFailures.size < 1024) return
  for (const [ip, entry] of loginFailures) {
    if (now - entry.firstAt > FAILURE_TRACKING_WINDOW_MS) {
      loginFailures.delete(ip)
    } else if (entry.lockedUntil !== undefined && entry.lockedUntil < now) {
      loginFailures.delete(ip)
    }
  }
}

/** Cookie header string for a session cookie with 14-day expiry. */
function sessionCookieSet(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`
}

/** Clear the session cookie. */
const SESSION_CLEAR = `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`

/** Parse the session cookie from a request. */
function parseSessionCookie(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie
  if (!cookie) return undefined
  // Simple cookie parser (no full RFC compliance needed for a single cookie)
  const start = cookie.indexOf(SESSION_COOKIE + '=')
  if (start === -1) return undefined
  const valueStart = start + SESSION_COOKIE.length + 1
  const end = cookie.indexOf(';', valueStart)
  return end === -1 ? cookie.slice(valueStart) : cookie.slice(valueStart, end)
}

/** Build a session payload (username + expiry) and sign it. */
function buildSessionCookie(username: string): string | undefined {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC
  const payload = JSON.stringify({ u: username, e: exp })
  const sig = signSession(payload)
  if (sig === undefined) return undefined
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`
}

/** Validate a session cookie and return the username if valid. */
function validateSessionCookie(req: IncomingMessage): string | undefined {
  const raw = parseSessionCookie(req)
  if (!raw) return undefined
  const dot = raw.indexOf('.')
  if (dot === -1) return undefined
  const payloadBase64 = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  let payload: string
  try {
    payload = Buffer.from(payloadBase64, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
  if (!verifySession(payload, sig)) return undefined
  let parsed: { u?: string; e?: number }
  try {
    parsed = JSON.parse(payload) as { u?: string; e?: number }
  } catch {
    return undefined
  }
  if (typeof parsed.u !== 'string' || typeof parsed.e !== 'number') return undefined
  // Check expiry
  if (parsed.e < Math.floor(Date.now() / 1000)) return undefined
  return parsed.u
}

/** Parse a JSON body from an incoming request, capped at MAX_BODY_BYTES. */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** True when the parse body rejection was the size cap. */
function isBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === 'request body too large'
}

/** True when registration raced another concurrent registration. */
function isAlreadyRegistered(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already registered')
}

/** Send a JSON response. */
function jsonResponse(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

/**
 * Check if the request is authorized (a genuine loopback request or a valid
 * session cookie).
 * @param req - the incoming HTTP request.
 * @returns `true` if the request is allowed.
 */
function isAuthorized(req: IncomingMessage): boolean {
  if (isTrustedOrigin(req)) return true
  return validateSessionCookie(req) !== undefined
}

/** Loopback hostnames (same classification as dsh's own browser-trust fence). */
const LOOPBACK_HOSTNAMES = ['localhost', '[::1]']

/**
 * Whether a `Host` header authority is a loopback authority.
 * @param host - the raw `Host` header value.
 * @returns `true` for localhost, IPv6 loopback, or 127/8 IPv4.
 */
function isLoopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
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
function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  // Node reports IPv4 peers on a dual-stack socket as `::ffff:127.0.0.1`.
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (normalized === '::1') return true
  const parts = normalized.split('.')
  return parts.length === 4 && parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
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
function isTrustedOrigin(req: IncomingMessage): boolean {
  return isLoopbackRemoteAddress(req.socket?.remoteAddress) &&
    isLoopbackAuthority(req.headers.host)
}

/**
 * Install the auth policy after the web server has bound.
 * @param ctx - plugin context with `webServer` and `webStartup`.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, _config: Config): void {
  const webServer: WebServer = ctx.webServer
  const bindHost = webServer.host

  // Restrict an existing credential file (created by an earlier version that
  // followed the umask) to owner-only access before serving any traffic.
  hardenCredentialFilePermissions()

  // ── 1. Register the login page route ──────────────────────────────────────
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/login',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(LOGIN_PAGE_HTML)
    },
  }), 'web-auth: /login route')

  // ── 2. Register auth API endpoints ────────────────────────────────────────
  const authEndpoints: WebRoute[] = [
    {
      kind: 'exact',
      path: '/api/auth/status',
      handler: async (req, res) => {
        const registered = hasCredentials()
        const authenticated = isAuthorized(req)
        // Username is only exposed once authenticated: a trusted (loopback)
        // origin gets the stored username, a remote caller only its own session.
        const username = authenticated
          ? (isTrustedOrigin(req) ? getUsername() : validateSessionCookie(req))
          : undefined
        jsonResponse(res, 200, { registered, authenticated, username })
      },
    },
    {
      kind: 'exact',
      path: '/api/auth/register',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          const body = await parseBody(req)
          const username = typeof body.username === 'string' ? normalizeUsername(body.username) : ''
          const password = typeof body.password === 'string' ? body.password : ''
          if (!username || !password) {
            jsonResponse(res, 400, { error: '请输入用户名和密码' })
            return
          }
          if (password.length < MIN_PASSWORD_LENGTH) {
            jsonResponse(res, 400, { error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` })
            return
          }
          if (hasCredentials()) {
            jsonResponse(res, 400, { error: '管理员账号已设置，不能重复注册' })
            return
          }
          registerCredentials(username, password)
          ctx.logger.info('web-auth: administrator registered (%s)', username)
          // Create a session cookie for the newly registered user
          const cookie = buildSessionCookie(username)
          if (cookie === undefined) {
            jsonResponse(res, 500, { error: '服务器内部错误' })
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookieSet(cookie) })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          if (isBodyTooLarge(error)) {
            jsonResponse(res, 413, { error: '请求体过大' })
            return
          }
          if (isAlreadyRegistered(error)) {
            // Raced another concurrent registration that won
            jsonResponse(res, 409, { error: '管理员账号已设置，不能重复注册' })
            return
          }
          ctx.logger.warn('web-auth: register failed: %s', error instanceof Error ? error.message : String(error))
          jsonResponse(res, 500, { error: '服务器内部错误' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/auth/login',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          pruneLoginFailures()
          if (isLockedOut(req)) {
            ctx.logger.warn('web-auth: login rate-limited (from %s)', clientIp(req) ?? 'unknown')
            jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' })
            return
          }
          const body = await parseBody(req)
          const username = typeof body.username === 'string' ? normalizeUsername(body.username) : ''
          const password = typeof body.password === 'string' ? body.password : ''
          if (!username || !password) {
            jsonResponse(res, 400, { error: '请输入用户名和密码' })
            return
          }
          if (!validateCredentials(username, password)) {
            recordLoginFailure(req)
            ctx.logger.warn('web-auth: login failed (from %s)', clientIp(req) ?? 'unknown')
            jsonResponse(res, 401, { error: '用户名或密码错误' })
            return
          }
          recordLoginSuccess(req)
          ctx.logger.info('web-auth: login ok (%s, from %s)', username, clientIp(req) ?? 'unknown')
          const cookie = buildSessionCookie(username)
          if (cookie === undefined) {
            jsonResponse(res, 500, { error: '服务器内部错误' })
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookieSet(cookie) })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          if (isBodyTooLarge(error)) {
            jsonResponse(res, 413, { error: '请求体过大' })
            return
          }
          ctx.logger.warn('web-auth: login failed: %s', error instanceof Error ? error.message : String(error))
          jsonResponse(res, 500, { error: '服务器内部错误' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/auth/logout',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': SESSION_CLEAR })
        res.end(JSON.stringify({ ok: true }))
      },
    },
    {
      kind: 'exact',
      path: '/api/auth/change-password',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        // Change-password requires an authenticated caller: a session cookie
        // for a remote caller, or the implicit trust granted to a genuine
        // loopback request. Rate limiting mirrors the login endpoint.
        try {
          pruneLoginFailures()
          if (!isAuthorized(req)) {
            jsonResponse(res, 401, { error: '未登录或会话已过期' })
            return
          }
          if (isLockedOut(req)) {
            jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' })
            return
          }
          const body = await parseBody(req)
          const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
          const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
          if (!oldPassword || !newPassword) {
            jsonResponse(res, 400, { error: '请输入旧密码和新密码' })
            return
          }
          if (newPassword.length < MIN_PASSWORD_LENGTH) {
            jsonResponse(res, 400, { error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` })
            return
          }
          // Capture the identity BEFORE changePassword: it rotates the signing
          // secret, after which the old session cookie no longer verifies.
          const username = isTrustedOrigin(req)
            ? getUsername()
            : validateSessionCookie(req)
          if (username === undefined) {
            jsonResponse(res, 401, { error: '未登录或会话已过期' })
            return
          }
          if (!changePassword(oldPassword, newPassword)) {
            recordLoginFailure(req)
            ctx.logger.warn('web-auth: change-password failed (from %s)', clientIp(req) ?? 'unknown')
            jsonResponse(res, 401, { error: '旧密码错误' })
            return
          }
          recordLoginSuccess(req)
          ctx.logger.info('web-auth: password changed (from %s)', clientIp(req) ?? 'unknown')
          // changePassword rotates the signing secret, invalidating every
          // previously issued session cookie — re-issue one for this caller.
          const cookie = buildSessionCookie(username)
          if (cookie === undefined) {
            jsonResponse(res, 500, { error: '服务器内部错误' })
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookieSet(cookie) })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          if (isBodyTooLarge(error)) {
            jsonResponse(res, 413, { error: '请求体过大' })
            return
          }
          ctx.logger.warn('web-auth: change-password failed: %s', error instanceof Error ? error.message : String(error))
          jsonResponse(res, 500, { error: '服务器内部错误' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/auth/change-username',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        // Same contract as change-password: an authenticated caller (session
        // cookie for a remote caller, or genuine loopback trust) plus the
        // current password. Rate limiting mirrors the login endpoint.
        try {
          pruneLoginFailures()
          if (!isAuthorized(req)) {
            jsonResponse(res, 401, { error: '未登录或会话已过期' })
            return
          }
          if (isLockedOut(req)) {
            jsonResponse(res, 429, { error: '尝试次数过多，请稍后再试' })
            return
          }
          const body = await parseBody(req)
          const newUsername = typeof body.newUsername === 'string' ? normalizeUsername(body.newUsername) : ''
          const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
          if (!newUsername || !currentPassword) {
            jsonResponse(res, 400, { error: '请输入新用户名和当前密码' })
            return
          }
          // Capture the identity BEFORE changeUsername: it rotates the signing
          // secret, after which the old session cookie no longer verifies.
          const username = isTrustedOrigin(req)
            ? getUsername()
            : validateSessionCookie(req)
          if (username === undefined) {
            jsonResponse(res, 401, { error: '未登录或会话已过期' })
            return
          }
          if (newUsername === username) {
            // No-op: nothing to rotate, so leave every session (including
            // this caller's) untouched.
            jsonResponse(res, 200, { ok: true, username })
            return
          }
          if (!changeUsername(newUsername, currentPassword)) {
            recordLoginFailure(req)
            ctx.logger.warn('web-auth: change-username failed (from %s)', clientIp(req) ?? 'unknown')
            jsonResponse(res, 401, { error: '当前密码错误' })
            return
          }
          recordLoginSuccess(req)
          ctx.logger.info('web-auth: username changed %s -> %s (from %s)', username, newUsername, clientIp(req) ?? 'unknown')
          // changeUsername rotates the signing secret, invalidating every
          // previously issued session cookie — re-issue one for this caller.
          const cookie = buildSessionCookie(newUsername)
          if (cookie === undefined) {
            jsonResponse(res, 500, { error: '服务器内部错误' })
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookieSet(cookie) })
          res.end(JSON.stringify({ ok: true, username: newUsername }))
        } catch (error) {
          if (isBodyTooLarge(error)) {
            jsonResponse(res, 413, { error: '请求体过大' })
            return
          }
          ctx.logger.warn('web-auth: change-username failed: %s', error instanceof Error ? error.message : String(error))
          jsonResponse(res, 500, { error: '服务器内部错误' })
        }
      },
    },
  ]

  for (const route of authEndpoints) {
    ctx.effect(() => webServer.register(route), `web-auth: ${route.path} route`)
  }

  // ── 3. Inject a redirect check into the SPA index ─────────────────────────
  // When the SPA boots without a valid session, send it to the login page.
  // Static assets still load without auth; the SPA shell redirects early.
  webServer.tapIndex((html) => {
    const script = `<script>
;(function () {
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
  // DSH's browser half treats the address-bar hostname as the trust source
  // (connection.isLoopback): a remote browser (LAN IP / domain) is
  // 'non-loopback', so ui-settings builds its describe mirror in memory mode
  // and every settingsScope.bind() freezes its scope in memory mode - those
  // scopes never derive, so plugin-configuration cards render nothing. The
  // node half already treats a valid session as loopback-equivalent (see the
  // Host/Origin rewriting below), so align the browser side here. The
  // override must land BEFORE the mirror is constructed and any scope binds,
  // which cannot be guaranteed by our own client plugin's activation order
  // (bundle loads finish out of order). Instead, wrap the module loader so
  // that the connection plugin's apply - the earliest service in the boot
  // graph - flips isLoopback to true the moment it returns, before cordis
  // notifies any dependent fiber.
  function installIsLoopbackOverride() {
    var loader = window.__ModuleLoader__
    if (!loader || loader.__authIsLoopbackHooked) return false
    // The HTML-installed facade starts in "queue" mode and only becomes
    // "live" once ClientModuleSystem.create() replaces load() with the
    // registering function. Hook that live load; wrapping the queue-mode
    // load would be discarded by the replacement.
    if (loader.mode !== 'live') return false
    loader.__authIsLoopbackHooked = true
    var origLoad = loader.load.bind(loader)
    loader.load = function (handoff) {
      var factory = handoff && handoff.factory
      if (typeof factory === 'function') {
        handoff.factory = function (require) {
          var exports = factory(require)
          var apply = exports && exports.apply
          if (typeof apply === 'function') {
            exports.apply = function (ctx) {
              var result = apply(ctx)
              try {
                var connection = ctx && ctx.get && ctx.get('connection')
                if (connection) {
                  Object.defineProperty(connection, 'isLoopback', {
                    configurable: true,
                    get: function () { return true }
                  })
                }
              } catch (error) {}
              return result
            }
          }
          return exports
        }
      }
      return origLoad(handoff)
    }
    return true
  }
  // Keep retrying: the boot entry may load asynchronously, so the module
  // loader can appear after this inline script runs.
  function tryInstallIsLoopbackOverride() {
    if (!installIsLoopbackOverride()) setTimeout(tryInstallIsLoopbackOverride, 0)
  }
  tryInstallIsLoopbackOverride()
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
</script>`
    return html.replace('</head>', `${script}</head>`)
  })

  // ── 4. Wrap webServer.register / registerUpgrade to protect every route,
  //       presenting authenticated remote requests as loopback ─────────────
  // dsh's client-connection gates its privileged /api domains
  // (settings.*, credentials.*, agentPreset.*, llm.discoverModels, …) and
  // third-party `authority: "loopback"` RPC channels (/dsh-automation, skill
  // managers, …) to loopback-origin requests, because the stock deployment
  // has no authentication layer. A valid session IS that layer, so present
  // authenticated remote requests as loopback: rewrite the authority headers
  // for the duration of the downstream handler. Loopback requests pass
  // through untouched.
  //
  // The rewrite is keyed off the requested authority, not the bind host: an
  // authenticated request also reaches us through a reverse proxy that binds
  // dsh to loopback and forwards its own public Host, and that caller needs
  // the same rewrite to clear `PRIVILEGED_METHODS` (which gates on loopback
  // Host with an empty trustedHosts list).
  //
  // The wrapper must cover routes registered BEFORE this plugin activated:
  // cordis activation order is not the bundle/tree order (dynamic imports
  // finish out of order), so third-party plugins can register their routes
  // before web-auth runs. Their route objects live in the webserver's route
  // tables, so wrap them retroactively here.
  const originalRegister = webServer.register.bind(webServer)
  const originalRegisterUpgrade = webServer.registerUpgrade.bind(webServer)
  // Loopback authority for this server (host:port), used to present
  // authenticated remote requests as loopback to dsh's own trust fences.
  const loopbackAuthority = () => `127.0.0.1:${webServer.port}`
  const wrappedHandlers = new WeakSet<WebRoute>()
  const wrappedUpgrades = new WeakSet<WebUpgradeRoute>()
  /** Routes that must stay anonymous: the login page and our own auth API. */
  const isPublicRoute = (path: string): boolean =>
    path === '/login' || path.startsWith('/api/auth/')

  const wrapHandler = (route: WebRoute): void => {
    if (wrappedHandlers.has(route) || isPublicRoute(route.path)) return
    wrappedHandlers.add(route)
    const originalHandler = route.handler
    route.handler = async (req, res) => {
      if (!isAuthorized(req)) {
        jsonResponse(res, 401, { error: 'unauthorized' })
        return
      }
      if (!isLoopbackAuthority(req.headers.host)) {
        const originalHost = req.headers.host
        const originalOrigin = req.headers.origin
        req.headers.host = loopbackAuthority()
        if (originalOrigin !== undefined) {
          req.headers.origin = `http://${loopbackAuthority()}`
        }
        try {
          await originalHandler(req, res)
        } finally {
          req.headers.host = originalHost
          if (originalOrigin !== undefined) {
            req.headers.origin = originalOrigin
          } else {
            delete req.headers.origin
          }
        }
        return
      }
      await originalHandler(req, res)
    }
  }

  const wrapUpgradeHandler = (route: WebUpgradeRoute): void => {
    if (wrappedUpgrades.has(route) || isPublicRoute(route.path)) return
    wrappedUpgrades.add(route)
    const originalHandler = route.handler
    route.handler = (req, socket, head) => {
      if (!isAuthorized(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      if (!isLoopbackAuthority(req.headers.host)) {
        const originalHost = req.headers.host
        const originalOrigin = req.headers.origin
        req.headers.host = loopbackAuthority()
        if (originalOrigin !== undefined) {
          req.headers.origin = `http://${loopbackAuthority()}`
        }
        try {
          return originalHandler(req, socket, head)
        } finally {
          req.headers.host = originalHost
          if (originalOrigin !== undefined) {
            req.headers.origin = originalOrigin
          } else {
            delete req.headers.origin
          }
        }
      }
      return originalHandler(req, socket, head)
    }
  }

  // Retroactively wrap routes that were already registered before this
  // plugin activated (third-party plugins may have won the activation race).
  const tables = webServer as unknown as {
    exact?: Map<string, WebRoute>
    prefixes?: Map<string, WebRoute>
    upgrades?: Map<string, WebUpgradeRoute>
  }
  for (const route of tables.exact?.values() ?? []) wrapHandler(route)
  for (const route of tables.prefixes?.values() ?? []) wrapHandler(route)
  for (const route of tables.upgrades?.values() ?? []) wrapUpgradeHandler(route)

  // Wrap routes registered from now on.
  webServer.register = (route: WebRoute) => {
    wrapHandler(route)
    return originalRegister(route)
  }
  webServer.registerUpgrade = (route: WebUpgradeRoute) => {
    wrapUpgradeHandler(route)
    return originalRegisterUpgrade(route)
  }

  // ── 5. Provide the auth service ───────────────────────────────────────────
  const service: WebAuthService = {
    authenticate(request) {
      return isAuthorized(request)
    },
  }

  ctx.provide('webAuth', service)
  ctx.logger.info('web-auth: active (bind host %s, credentials: %s)',
    bindHost, hasCredentials() ? 'set' : 'not set')
  void ctx.get(WEB_STARTUP_SERVICE) // ensure injection is satisfied
}