import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { PassThrough } from 'node:stream'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { apply, internals as authInternals, type WebAuthService } from '../src/auth.ts'
import {
  registerCredentials,
  signSession,
  hardenCredentialFilePermissions,
  changePassword,
  changeUsername,
  getSessionSecret,
  getUsername,
  getRequireLoopbackLogin,
  setRequireLoopbackLogin,
  getSlideVerification,
  setSlideVerification,
  getSessionMaxAgeDays,
  setSessionMaxAgeDays,
  normalizeUsername,
  validateCredentials,
  internals,
} from '../src/credential-store.ts'
import { internals as sliderInternals } from '../src/slider/index.ts'
import { MAX_ANSWER_Y, TOLERANCE } from '../src/slider/challenge.ts'

let authFile: string
let authDir: string

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'dsh-web-auth-'))
  authFile = join(authDir, 'web-auth.json')
  process.env.DSH_WEB_AUTH_FILE = authFile
  // The limiters are module-global, so without this every test would inherit
  // the failures of the ones before it — and the aggregate counter would trip
  // somewhere in the middle of the file.
  authInternals.resetLoginFailures()
})

afterEach(() => {
  delete process.env.DSH_WEB_AUTH_FILE
  rmSync(authDir, { recursive: true, force: true })
})

/** Fake context that records every registered route for handler-level tests. */
function fakeWebAuthContext(bindHost: string, preRegistered: WebRoute[] = [], credentials?: unknown, preFallback?: WebRoute['handler']) {
  const provided = new Map<string, unknown>()
  const routes: WebRoute[] = []
  const webServer = {
    host: bindHost,
    port: 3080,
    exact: new Map<string, WebRoute>(),
    prefixes: new Map<string, WebRoute>(),
    upgrades: new Map<string, { path: string; handler: (req: unknown, socket: unknown, head: unknown) => unknown }>(),
    fallback: preFallback,
    register: (route: WebRoute) => {
      routes.push(route)
      const table = route.kind === 'exact' ? webServer.exact : webServer.prefixes
      table.set(route.path, route)
      return () => {}
    },
    registerUpgrade: (route: { path: string; handler: (req: unknown, socket: unknown, head: unknown) => unknown }) => {
      webServer.upgrades.set(route.path, route)
      return () => {}
    },
    registerFallback: (handler: WebRoute['handler']) => {
      webServer.fallback = handler
      return () => { webServer.fallback = undefined }
    },
    tapIndex: () => {},
  }
  // Routes already registered before web-auth activated (a third-party
  // plugin that won the activation race): they live in the route tables and
  // must be wrapped retroactively.
  for (const route of preRegistered) {
    webServer.prefixes.set(route.path, route)
    routes.push(route)
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'webStartup') return { trustedHosts: [] }
      if (key === 'credentials') return credentials
      return undefined
    },
    provide: (key: string, value: unknown) => { provided.set(key, value) },
    effect: (fn: () => void) => { fn() },
    webServer,
    logger: { info: () => {}, warn: () => {} },
  } as unknown as Context
  apply(ctx, {})
  return {
    auth: provided.get('webAuth') as WebAuthService,
    routes,
    webServer,
  }
}

/**
 * A bare request with a session cookie.
 *
 * Defaults to a genuine loopback request (loopback peer address *and*
 * loopback `Host`), which is the case that is implicitly trusted.
 * @param cookie - full `Cookie` header value.
 * @param opts - peer address and `Host` of the caller.
 */
function requestWithCookie(cookie?: string, opts: { ip?: string; host?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? '127.0.0.1:3080' }
  if (cookie !== undefined) headers.cookie = cookie
  return {
    headers,
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** Build a valid signed session cookie (full Cookie header value). */
function sessionCookie(username: string, ttlSec = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = JSON.stringify({ u: username, e: exp })
  const sig = signSession(payload)
  if (sig === undefined) throw new Error('session signing unavailable')
  return `dsh_sid=${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`
}

// ── handler-level helpers ────────────────────────────────────────────────────

function findRoute(routes: WebRoute[], path: string): WebRoute {
  const route = routes.find((r) => r.path === path)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  return route
}

interface CapturedResponse {
  statusCode: number
  body: string
  setCookie?: string
  setCookies?: string[]
  location?: string
  contentType?: string
  retryAfter?: string
}

function jsonResponseCapture() {
  const captured: CapturedResponse = { statusCode: 0, body: '' }
  const res = {
    writeHead: (code: number, headers?: Record<string, string | string[]>) => {
      captured.statusCode = code
      if (headers !== undefined) {
        if (typeof headers.location === 'string') captured.location = headers.location
        if (typeof headers['content-type'] === 'string') captured.contentType = headers['content-type']
        if (typeof headers['retry-after'] === 'string') captured.retryAfter = headers['retry-after']
        const value = headers['set-cookie']
        if (Array.isArray(value)) {
          captured.setCookies = [...value]
          captured.setCookie = value[0]
        } else if (typeof value === 'string') {
          captured.setCookie = value
          captured.setCookies = [value]
        }
      }
    },
    end: (body?: string) => { captured.body = body ?? '' },
    getHeader: (name: string) => {
      if (name === 'set-cookie') return captured.setCookies
      return undefined
    },
    setHeader: () => {},
  } as unknown as ServerResponse
  return { captured, res }
}

/** A request stream with a JSON body and a fixed socket address. */
function jsonRequest(method: string, body: unknown, opts: { ip?: string; host?: string; cookie?: string } = {}): IncomingMessage {
  const req = new PassThrough()
  Object.assign(req, {
    method,
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
    headers: {
      host: opts.host ?? '127.0.0.1:3080',
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      'content-type': 'application/json',
    },
  })
  req.end(Buffer.from(JSON.stringify(body), 'utf8'))
  return req as unknown as IncomingMessage
}

async function callEndpoint(routes: WebRoute[], path: string, body: unknown, ip: string): Promise<CapturedResponse> {
  const { captured, res } = jsonResponseCapture()
  await findRoute(routes, path).handler(jsonRequest('POST', body, { ip }), res)
  return captured
}

// ── username normalization (issue #14) ───────────────────────────────────────

describe('normalizeUsername', () => {
  it('strips C0 control characters and DEL', () => {
    expect(normalizeUsername('draguide\u007F')).toBe('draguide')
    expect(normalizeUsername('\u0001admin\u0002')).toBe('admin')
    expect(normalizeUsername('a\u0000b\rc')).toBe('abc')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeUsername('  admin\t')).toBe('admin')
  })

  it('keeps internal spaces and non-ASCII characters', () => {
    expect(normalizeUsername('管 理 员')).toBe('管 理 员')
    expect(normalizeUsername('a b c')).toBe('a b c')
  })
})

// ── service-level tests (session semantics) ──────────────────────────────────

/** A request from a remote caller (LAN client or reverse-proxied browser). */
const remote = { ip: '192.0.2.70', host: 'dsh.example.com:3080' }

describe('web-auth service', () => {
  it('allows a loopback request without credentials', () => {
    const { auth } = fakeWebAuthContext('127.0.0.1')
    expect(auth.authenticate(requestWithCookie())).toBe(true)
  })

  it('requires a valid session cookie from a remote caller', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(undefined, remote))).toBe(false)
    expect(auth.authenticate(requestWithCookie('dsh_sid=forged.invalid', remote))).toBe(false)
  })

  it('accepts a valid session cookie from a remote caller', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin'), remote))).toBe(true)
  })

  it('rejects an expired session cookie from a remote caller', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    const expired = sessionCookie('admin', -60)
    expect(auth.authenticate(requestWithCookie(expired, remote))).toBe(false)
  })

  it('requires a session cookie from a loopback proxy forwarding a public Host', () => {
    // Reverse-proxy deployment: dsh binds 127.0.0.1, the proxy connects from
    // loopback but forwards its own public authority. Trusting the peer
    // address alone would let every proxy client in unauthenticated.
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('127.0.0.1')
    const proxied = { ip: '127.0.0.1', host: 'dsh.example.com' }
    expect(auth.authenticate(requestWithCookie(undefined, proxied))).toBe(false)
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin'), proxied))).toBe(true)
  })

  it('ignores a forged loopback Host from a remote peer', () => {
    // Host alone must never grant trust: a LAN peer can send any Host header.
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    const forged = { ip: '192.0.2.71', host: '127.0.0.1:3080' }
    expect(auth.authenticate(requestWithCookie(undefined, forged))).toBe(false)
  })
})

// ── route wrapping coverage (all routes, retroactive + future) ───────────────

/** A plain GET request with configurable Host, session cookie and method. */
function httpRequest(opts: {
  url?: string
  host?: string
  cookie?: string
  ip?: string
  accept?: string
  method?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  if (opts.accept !== undefined) headers.accept = opts.accept
  if (opts.headers !== undefined) Object.assign(headers, opts.headers)
  return {
    headers,
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

describe('route wrapping coverage', () => {
  it('retroactively wraps a route registered before web-auth activated', async () => {
    registerCredentials('admin', 'secret1')
    const seenHosts: Array<string | undefined> = []
    const thirdParty: WebRoute = {
      kind: 'prefix',
      path: '/api/third-party',
      handler: async (req, res) => {
        seenHosts.push(req.headers.host)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      },
    }
    const { routes } = fakeWebAuthContext('0.0.0.0', [thirdParty])
    const route = findRoute(routes, '/api/third-party')

    // Remote caller + valid session: forwarded with the Host untouched (no
    // loopback rewriting in 0.1.2).
    const ok = jsonResponseCapture()
    await route.handler(
      httpRequest({ host: '192.168.5.216:3080', ip: '192.168.5.216', cookie: sessionCookie('admin') }),
      ok.res,
    )
    expect(ok.captured.statusCode).toBe(200)
    expect(seenHosts).toEqual(['192.168.5.216:3080'])

    // No session: rejected.
    const rejected = jsonResponseCapture()
    await route.handler(httpRequest({ host: '192.168.5.216:3080', ip: '192.168.5.216' }), rejected.res)
    expect(rejected.captured.statusCode).toBe(401)
  })

  it('leaves a dynamically registered /oauth/callback anonymous', async () => {
    // `@deepseek-ai/dsh-deepseek-account-platform` (base bundle) registers this
    // route with `ctx.effect(...)` for the duration of one DeepSeek-account
    // sign-in attempt. It arrives as a cross-site top-level navigation from the
    // provider: a browser that never held our `dsh_sid` (link opened elsewhere,
    // cookies cleared, another container) would be sent to /login and the
    // authorization code lost with it. It must therefore stay anonymous — the
    // route is already bound to a single-use `state` + PKCE verifier.
    registerCredentials('admin', 'secret1')
    const { webServer } = fakeWebAuthContext('0.0.0.0')
    const callback: WebRoute = {
      kind: 'exact',
      path: '/oauth/callback',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('callback reached')
      },
    }
    webServer.register(callback)

    // Remote caller, no session, no native cookie: still reaches upstream.
    const reached = jsonResponseCapture()
    await callback.handler(
      httpRequest({ host: '192.168.5.216:3080', ip: '192.168.5.216', accept: 'text/html' }),
      reached.res,
    )
    expect(reached.captured.statusCode).toBe(200)
    expect(reached.captured.body).toBe('callback reached')
  })

  it('forwards a reverse-proxied caller with its public Host untouched', async () => {
    // dsh bound to 127.0.0.1 behind a proxy: the request arrives from
    // loopback but carries the public Host. The wrapper forwards it as-is —
    // the native cookie is minted under the public authority so upstream's
    // fence matches it (no Host rewriting in 0.1.2).
    registerCredentials('admin', 'secret1')
    const seenHosts: Array<string | undefined> = []
    const channel: WebRoute = {
      kind: 'prefix',
      path: '/api/third-party',
      handler: async (req, res) => {
        seenHosts.push(req.headers.host)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      },
    }
    const { routes } = fakeWebAuthContext('127.0.0.1', [channel])
    const route = findRoute(routes, '/api/third-party')
    const proxied = { host: 'dsh.example.com', ip: '127.0.0.1' }

    const ok = jsonResponseCapture()
    await route.handler(httpRequest({ ...proxied, cookie: sessionCookie('admin') }), ok.res)
    expect(ok.captured.statusCode).toBe(200)
    expect(seenHosts).toEqual(['dsh.example.com'])

    seenHosts.length = 0
    const rejected = jsonResponseCapture()
    await route.handler(httpRequest(proxied), rejected.res)
    expect(rejected.captured.statusCode).toBe(401)
    expect(seenHosts).toEqual([])
  })

  it('wraps non-/api routes such as /dsh-automation channels', async () => {
    registerCredentials('admin', 'secret1')
    const seenHosts: Array<string | undefined> = []
    const channel: WebRoute = {
      kind: 'prefix',
      path: '/dsh-automation',
      handler: async (req, res) => {
        seenHosts.push(req.headers.host)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      },
    }
    const { routes, webServer } = fakeWebAuthContext('0.0.0.0')
    // Register through the wrapped register (future routes).
    webServer.register(channel)
    const route = findRoute(routes, '/dsh-automation')
    const ok = jsonResponseCapture()
    await route.handler(
      httpRequest({ host: 'dsh.example.com:3080', ip: '192.0.2.72', cookie: sessionCookie('admin') }),
      ok.res,
    )
    expect(ok.captured.statusCode).toBe(200)
    expect(seenHosts).toEqual(['dsh.example.com:3080'])
  })

  it('wraps upgrade routes so WebSocket handshakes still require a session', async () => {
    registerCredentials('admin', 'secret1')
    const seenHosts: Array<string | undefined> = []
    const { webServer } = fakeWebAuthContext('0.0.0.0')
    webServer.registerUpgrade({
      path: '/api/events.mux',
      handler: (req) => {
        seenHosts.push((req as IncomingMessage).headers.host)
      },
    })
    const upgradeRoute = webServer.upgrades.get('/api/events.mux')
    expect(upgradeRoute).toBeDefined()

    // Remote caller + valid session: forwarded with the Host untouched.
    const socket = { end: () => {} } as unknown as Duplex
    upgradeRoute!.handler(
      httpRequest({ host: 'dsh.example.com:3080', ip: '192.0.2.73', cookie: sessionCookie('admin') }),
      socket,
      Buffer.alloc(0),
    )
    expect(seenHosts).toEqual(['dsh.example.com:3080'])

    // No session: refused.
    seenHosts.length = 0
    upgradeRoute!.handler(
      httpRequest({ host: 'dsh.example.com:3080', ip: '192.0.2.73' }),
      socket,
      Buffer.alloc(0),
    )
    expect(seenHosts).toEqual([])
  })
})

// ── native browser-auth cookie bridge (dsh 0.1.2) ───────────────────────────
//
// Upstream signs its own `dsh-auth-<sha256(authority)>` cookie with a secret
// in the credentials service. A caller our session layer trusts (valid
// `dsh_sid` or genuine loopback) but that upstream does not know yet must be
// handed that cookie; the bridge mints it with a 200 bounce document for page
// navigations (a 3xx mint is replayed on every hop until
// ERR_TOO_MANY_REDIRECTS in Safari/Firefox) and hands it out directly in the
// login-family responses.

/** A fixed 32-byte secret for the fake credentials provider. */
const FAKE_BROWSER_SECRET = Buffer.alloc(32, 7).toString('base64url')

/** A fake credentials provider returning a fixed browser-session grant. */
function fakeCredentials(record: unknown = { kind: 'grant', payload: { version: 1, secret: FAKE_BROWSER_SECRET } }) {
  return { readRecord: async () => record }
}

/** Decode and verify a minted native cookie, returning its payload. */
function expectValidNativeCookie(setCookie: string): { authority: string; issuedAt: number; expiresAt: number } {
  const value = setCookie.split(';')[0]!.split('=').slice(1).join('=')
  const [version, body, signature] = value.split('.')
  expect(version).toBe('v1')
  const expected = createHmac('sha256', Buffer.from(FAKE_BROWSER_SECRET, 'base64url'))
    .update(body ?? '')
    .digest('base64url')
  expect(signature).toBe(expected)
  const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'))
  return payload
}

describe('native browser-auth cookie bridge', () => {
  /** A downstream handler echoing success (mimics an authenticated page route). */
  const okPage: WebRoute = {
    kind: 'exact',
    path: '/app',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    },
  }

  it('mints the native cookie with a 200 bounce for an authenticated page navigation', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({
        url: '/app',
        host: '192.168.5.216:3080',
        ip: '192.168.5.216',
        accept: 'text/html',
        cookie: sessionCookie('admin'),
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.location).toBeUndefined()
    expect(captured.contentType).toBe('text/html; charset=utf-8')
    expect(captured.body).toContain('<meta http-equiv="refresh" content="0;url=/app">')
    expect(captured.setCookies).toHaveLength(1)
    const payload = expectValidNativeCookie(captured.setCookie ?? '')
    // The cookie is bound to the caller's own authority, never a loopback one.
    expect(payload.authority).toBe('192.168.5.216:3080')
  })

  it('mints the native cookie with a 200 bounce for a real browser navigation', async () => {
    // Browsers send `Sec-Fetch-Mode: navigate` on page navigations; the
    // Accept-header fallback only covers clients that omit it. Both must
    // land on the 200 bounce, never a 3xx that Safari/Firefox replay into
    // ERR_TOO_MANY_REDIRECTS (issue #30).
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({
        url: '/app',
        host: '192.168.5.216:3080',
        ip: '192.168.5.216',
        cookie: sessionCookie('admin'),
        headers: { 'sec-fetch-mode': 'navigate' },
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.location).toBeUndefined()
    expect(captured.contentType).toBe('text/html; charset=utf-8')
    expect(captured.body).toContain('<meta http-equiv="refresh" content="0;url=/app">')
    // The JS path replaces (no history entry); the meta refresh is its
    // no-JS fallback.
    expect(captured.body).toContain('location.replace("/app")')
    expectValidNativeCookie(captured.setCookie ?? '')
  })

  it('mints the native cookie with a 200 bounce for an iframe navigation', async () => {
    // `nested-navigate` is a real navigation (frame documents) and hits the
    // same redirect-replay trap as a top-level one, so it gets the bounce
    // too: a 303 inside a frame loops to ERR_TOO_MANY_REDIRECTS just the
    // same, reachable whenever a cross-site page embeds this origin.
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({
        url: '/app',
        host: 'dsh.example.com',
        ip: '192.0.2.90',
        cookie: sessionCookie('admin'),
        headers: { 'sec-fetch-mode': 'nested-navigate' },
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.location).toBeUndefined()
    expect(captured.body).toContain('<meta http-equiv="refresh" content="0;url=/app">')
    expectValidNativeCookie(captured.setCookie ?? '')
  })

  it('never bounces to an off-origin target (absolute-form request targets)', async () => {
    // An absolute-form request target (`GET http://evil/...`) or a
    // protocol-relative one (`GET //evil/...`) must not turn the mint into
    // an open redirect: both the bounce and the 303 stay on this origin.
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')

    const navigated = jsonResponseCapture()
    await route.handler(
      httpRequest({
        url: 'http://evil.example/steal',
        host: 'dsh.example.com',
        ip: '192.0.2.90',
        cookie: sessionCookie('admin'),
        headers: { 'sec-fetch-mode': 'navigate' },
      }),
      navigated.res,
    )
    expect(navigated.captured.statusCode).toBe(200)
    expect(navigated.captured.body).toContain('content="0;url=/"')
    expect(navigated.captured.body).not.toContain('evil.example')

    const fetched = jsonResponseCapture()
    await route.handler(
      httpRequest({
        url: '//evil.example/steal',
        host: 'dsh.example.com',
        ip: '192.0.2.90',
        cookie: sessionCookie('admin'),
      }),
      fetched.res,
    )
    expect(fetched.captured.statusCode).toBe(303)
    expect(fetched.captured.location).toBe('/')
    expectValidNativeCookie(fetched.captured.setCookie ?? '')
  })

  it('mints the native cookie for a genuine loopback caller (local browser)', async () => {
    // No credentials registered at all: the loopback caller is implicitly
    // trusted, and the bridge lets its very next request clear upstream.
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({ url: '/app', host: '127.0.0.1:3080', ip: '127.0.0.1', accept: 'text/html' }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toContain('<meta http-equiv="refresh" content="0;url=/app">')
    const payload = expectValidNativeCookie(captured.setCookie ?? '')
    expect(payload.authority).toBe('127.0.0.1:3080')
  })

  it('forwards a caller that already holds the native cookie', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    // The native cookie name derives from the authority: sha256 over the
    // URL-normalized host, base64url, prefixed with dsh-auth-.
    const authority = new URL('http://dsh.example.com').host
    const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
    const native = `${name}=v1.placeholder.sig`
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({
        host: 'dsh.example.com',
        ip: '192.0.2.80',
        accept: 'text/html',
        cookie: `${sessionCookie('admin')}; ${native}`,
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
  })

  it('does not mint while the upstream signing secret is absent', async () => {
    registerCredentials('admin', 'secret1')
    const noSecretProvider = { readRecord: async () => undefined }
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], noSecretProvider)
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({
        host: 'dsh.example.com',
        ip: '192.0.2.81',
        accept: 'text/html',
        cookie: sessionCookie('admin'),
      }),
      res,
    )
    // Secret not ready yet: forwarded as-is; the next request retries.
    expect(captured.statusCode).toBe(200)
  })

  it('forwards non-navigations without a 303 hop (RPC must not become GET)', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    // POST (no accept header, no sec-fetch-mode): forwarded untouched even
    // without the native cookie — a redirect would turn the RPC into a GET.
    await route.handler(
      httpRequest({
        url: '/app',
        host: 'dsh.example.com',
        ip: '192.0.2.82',
        cookie: sessionCookie('admin'),
        method: 'POST',
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
  })

  it('redirects an unauthenticated page navigation to /login', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage])
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({ url: '/app', host: 'dsh.example.com', ip: '192.0.2.83', accept: 'text/html' }),
      res,
    )
    expect(captured.statusCode).toBe(302)
    expect(captured.location).toBe('/login')
  })

  it('rejects an unauthenticated XHR/RPC with 401 instead of a redirect', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage])
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    await route.handler(
      httpRequest({ url: '/app', host: 'dsh.example.com', ip: '192.0.2.84' }),
      res,
    )
    expect(captured.statusCode).toBe(401)
  })

  it('clears the native cookie on logout', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [], fakeCredentials())
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/logout').handler(
      httpRequest({ host: 'dsh.example.com', ip: '192.0.2.85', method: 'POST' }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.setCookies?.[0]).toMatch(/^dsh_sid=; .*Max-Age=0/)
    const nativeClear = captured.setCookies?.find((cookie) => cookie.startsWith('dsh-auth-'))
    expect(nativeClear).toBeDefined()
    expect(nativeClear).toContain('Max-Age=0')
  })

  it('issues both cookies from a successful login response', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [], fakeCredentials())
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/login').handler(
      jsonRequest('POST', { username: 'admin', password: 'secret1' }, {
        ip: '192.0.2.86',
        host: 'dsh.example.com',
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.setCookie).toMatch(/^dsh_sid=/)
    expect(captured.setCookies).toHaveLength(2)
    const native = captured.setCookies?.find((cookie) => cookie.startsWith('dsh-auth-'))
    expect(native).toBeDefined()
    const payload = expectValidNativeCookie(native ?? '')
    expect(payload.authority).toBe('dsh.example.com')
  })
  it('keeps the 3xx mint for non-navigation GETs (fetch-style clients)', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    const { captured, res } = jsonResponseCapture()
    // No `sec-fetch-mode` and no `Accept: text/html`: not a page navigation,
    // so the mint keeps its 3xx shape (a fetch-style client follows it).
    await route.handler(
      httpRequest({
        url: '/app',
        host: 'dsh.example.com',
        ip: '192.0.2.90',
        cookie: sessionCookie('admin'),
      }),
      res,
    )
    expect(captured.statusCode).toBe(303)
    expect(captured.location).toBe('/app')
    expectValidNativeCookie(captured.setCookie ?? '')
  })

  it('cannot be walked into a redirect chain (every mint answer is terminal)', async () => {
    registerCredentials('admin', 'secret1')
    const { routes } = fakeWebAuthContext('0.0.0.0', [okPage], fakeCredentials())
    const route = findRoute(routes, '/app')
    // Ten no-cookie navigations in a row (the caller never picks the cookie
    // up, as a browser that drops redirect-set cookies would): every answer
    // is a terminal 200 + Set-Cookie + meta refresh, so the client can never
    // be bounced into ERR_TOO_MANY_REDIRECTS the way the 303 mint did.
    for (let i = 0; i < 10; i++) {
      const { captured, res } = jsonResponseCapture()
      await route.handler(
        httpRequest({
          url: '/app',
          host: 'dsh.example.com',
          ip: '192.0.2.91',
          accept: 'text/html',
          cookie: sessionCookie('admin'),
        }),
        res,
      )
      expect(captured.statusCode).toBe(200)
      expect(captured.location).toBeUndefined()
      expect(captured.body).toContain('<meta http-equiv="refresh" content="0;url=/app">')
      expectValidNativeCookie(captured.setCookie ?? '')
    }
  })
})

// The 0.1.2 SPA index is served through the webserver's fallback seat
// (`registerFallback`), OUTSIDE the exact/prefix route tables, so it needs
// the same wrapping or it would bypass the session check entirely.
describe('index fallback seat wrapping', () => {
  /** A stand-in for frontend-static's index handler. */
  const indexFallback: WebRoute['handler'] = async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>index</html>')
  }

  it('wraps a fallback registered before web-auth activated', async () => {
    registerCredentials('admin', 'secret1')
    const { webServer } = fakeWebAuthContext('0.0.0.0', [], fakeCredentials(), indexFallback)
    const fallback = webServer.fallback
    expect(fallback).toBeDefined()

    // Remote caller, no session: redirected to the login page, not served.
    const rejected = jsonResponseCapture()
    await fallback!(
      httpRequest({ host: 'dsh.example.com', ip: '192.0.2.87', accept: 'text/html' }),
      rejected.res,
    )
    expect(rejected.captured.statusCode).toBe(302)
    expect(rejected.captured.location).toBe('/login')

    // Authenticated remote caller without the native cookie: 200 bounce + mint.
    const minted = jsonResponseCapture()
    await fallback!(
      httpRequest({
        host: 'dsh.example.com',
        ip: '192.0.2.88',
        accept: 'text/html',
        cookie: sessionCookie('admin'),
      }),
      minted.res,
    )
    expect(minted.captured.statusCode).toBe(200)
    expect(minted.captured.location).toBeUndefined()
    expect(minted.captured.body).toContain('<meta http-equiv="refresh" content="0;url=/">')
    const payload = expectValidNativeCookie(minted.captured.setCookie ?? '')
    expect(payload.authority).toBe('dsh.example.com')
  })

  it('wraps a fallback registered after web-auth activated', async () => {
    registerCredentials('admin', 'secret1')
    const { webServer } = fakeWebAuthContext('0.0.0.0', [], fakeCredentials())
    // Register through the wrapped registerFallback.
    webServer.registerFallback(indexFallback)
    const fallback = webServer.fallback
    expect(fallback).toBeDefined()

    // Genuine loopback caller: implicitly trusted, and the native cookie is
    // minted so its next request clears upstream's own gate.
    const minted = jsonResponseCapture()
    await fallback!(
      httpRequest({ host: '127.0.0.1:3080', ip: '127.0.0.1', accept: 'text/html' }),
      minted.res,
    )
    expect(minted.captured.statusCode).toBe(200)
    expectValidNativeCookie(minted.captured.setCookie ?? '')
    expect(minted.captured.body).toContain('<meta http-equiv="refresh" content="0;url=/">')

    // The wrapped handler still serves the index once the caller is known.
    const served = jsonResponseCapture()
    const authority = new URL('http://127.0.0.1:3080').host
    const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
    await fallback!(
      httpRequest({
        host: '127.0.0.1:3080',
        ip: '127.0.0.1',
        accept: 'text/html',
        cookie: `${name}=v1.x.y`,
      }),
      served.res,
    )
    expect(served.captured.statusCode).toBe(200)
    expect(served.captured.body).toBe('<html>index</html>')
  })

  it('serves static dist assets anonymously but keeps the index guarded', async () => {
    registerCredentials('admin', 'secret1')
    const staticFallback: WebRoute['handler'] = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end('<svg></svg>')
    }
    const { webServer } = fakeWebAuthContext('0.0.0.0', [], fakeCredentials(), staticFallback)
    const fallback = webServer.fallback
    expect(fallback).toBeDefined()

    // The login page references /favicon.svg; an anonymous 401 there would
    // render a broken image. Static dist assets stay public.
    const served = jsonResponseCapture()
    await fallback!(
      httpRequest({ url: '/favicon.svg', host: 'dsh.example.com', ip: '192.0.2.89' }),
      served.res,
    )
    expect(served.captured.statusCode).toBe(200)
    expect(served.captured.body).toBe('<svg></svg>')

    // The SPA index (both entry paths) is still session-guarded.
    const index = jsonResponseCapture()
    await fallback!(
      httpRequest({ url: '/index.html', host: 'dsh.example.com', ip: '192.0.2.90', accept: 'text/html' }),
      index.res,
    )
    expect(index.captured.statusCode).toBe(302)
    expect(index.captured.location).toBe('/login')
  })
})

// ── GET /api/auth/status: the front end redirects on its verdict ─────────────

describe('GET /api/auth/status', () => {
  /** Read the status endpoint as `caller` and return the parsed payload. */
  async function readStatus(bindHost: string, caller: { ip?: string; host?: string; cookie?: string }) {
    const { routes } = fakeWebAuthContext(bindHost)
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/status').handler(httpRequest(caller), res)
    return JSON.parse(captured.body ?? '{}') as {
      registered: boolean
      authenticated: boolean
      session: boolean
      trusted: boolean
      username?: string
    }
  }

  it('reports a local browser as authenticated even before registration', async () => {
    // Regression test for the / -> /login -> / redirect loop: a loopback
    // deployment trusts the local browser, so an unregistered deployment must
    // not send it to a login page that would bounce it straight back.
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: '127.0.0.1:3080' })
    expect(status).toEqual({ registered: false, authenticated: true, session: false, trusted: true })
  })

  it('reports a proxied browser as unauthenticated until it logs in', async () => {
    // dsh bound to loopback behind a proxy: the public Host makes the request
    // remote, so registration and login apply instead of implicit trust.
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: 'dsh.example.com' })
    expect(status).toEqual({ registered: true, authenticated: false, session: false, trusted: false })
  })

  it('reports a LAN caller as unauthenticated until it logs in', async () => {
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('0.0.0.0', remote)
    expect(status).toEqual({ registered: true, authenticated: false, session: false, trusted: false })
  })

  it('names the session user for an authenticated remote caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('0.0.0.0', { ...remote, cookie: sessionCookie('admin') })
    expect(status).toEqual({ registered: true, authenticated: true, session: true, trusted: false, username: 'admin' })
  })

  it('separates "trusted" from "signed in" for a local browser', async () => {
    // The default loopback deployment: no cookie at all, yet the caller is
    // authorized (and stays authorized after /api/auth/logout, which is why
    // the tab must not offer a sign-out button that cannot do anything).
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: '127.0.0.1:3080' })
    expect(status).toEqual({ registered: true, authenticated: true, session: false, trusted: true, username: 'admin' })
  })
})

// ── credential file protection ───────────────────────────────────────────────

describe('credential file permissions', () => {
  it('writes the credential file owner-only (0600)', () => {
    registerCredentials('admin', 'supersecret1')
    const mode = statSync(authFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('hardenCredentialFilePermissions fixes a legacy broad file', () => {
    writeFileSync(authFile, '{}', 'utf8')
    chmodSync(authFile, 0o644)
    hardenCredentialFilePermissions()
    expect(statSync(authFile).mode & 0o777).toBe(0o600)
  })
})

// ── credential file location ─────────────────────────────────────────────────

describe('credential file location', () => {
  it('lives under $DSH_HOME so a custom home stays self-contained', () => {
    // The harness resolves its data root as `$DSH_HOME` then `~/.dsh`. Reading
    // only the OS home made a custom-`DSH_HOME` deployment (or a second
    // instance used for testing) share — and overwrite — the real `~/.dsh`
    // credentials.
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const previousHome = process.env.DSH_HOME
    delete process.env.DSH_WEB_AUTH_FILE
    process.env.DSH_HOME = home
    try {
      expect(internals.credentialFile()).toBe(join(home, 'web-auth.json'))
      registerCredentials('admin', 'supersecret1')
      expect(existsSync(join(home, 'web-auth.json'))).toBe(true)
      // The file it wrote is the one it reads back.
      expect(internals.readCredentials()?.username).toBe('admin')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats a blank $DSH_HOME as unset', () => {
    // A whitespace-only override must not resolve the file against the current
    // working directory (the harness's own `resolveDshHome` does the same).
    const previousHome = process.env.DSH_HOME
    delete process.env.DSH_WEB_AUTH_FILE
    process.env.DSH_HOME = '   '
    try {
      expect(internals.credentialFile()).toBe(join(homedir(), '.dsh', 'web-auth.json'))
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})

// ── register endpoint ────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('rejects a password below the minimum length', async () => {
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/register', { username: 'admin', password: 'short' }, '192.0.2.10')
    expect(res.statusCode).toBe(400)
  })

  it('rejects a second registration after the admin exists', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/register', { username: 'other', password: 'supersecret1' }, '192.0.2.10')
    expect(res.statusCode).toBe(400)
  })

  it('returns 413 for an oversized body', async () => {
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/register', { username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) }, '192.0.2.10')
    expect(res.statusCode).toBe(413)
  })

  it('strips control characters from the username before storing (issue #14)', async () => {
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/register', { username: 'draguide\u007F', password: 'supersecret1' }, '192.0.2.10')
    expect(res.statusCode).toBe(200)
    expect(getUsername()).toBe('draguide')
  })

  it('rejects a username that strips to empty', async () => {
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/register', { username: '\u0001\u007F', password: 'supersecret1' }, '192.0.2.10')
    expect(res.statusCode).toBe(400)
  })
})

// ── login endpoint: rate limiting and body cap ───────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns 401 for wrong credentials', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'wrong-password' }, '192.0.2.20')
    expect(res.statusCode).toBe(401)
  })

  it('locks out a client after repeated failures, even with the correct password', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.21'
    for (let i = 0; i < 5; i += 1) {
      const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'wrong-password' }, ip)
      expect(res.statusCode).toBe(401)
    }
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, ip)
    expect(res.statusCode).toBe(429)
  })

  it('clears the failure counter on a successful login', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.22'
    for (let i = 0; i < 4; i += 1) {
      await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'wrong-password' }, ip)
    }
    const ok = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, ip)
    expect(ok.statusCode).toBe(200)
    const failed = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'wrong-password' }, ip)
    expect(failed.statusCode).toBe(401)
  })

  it('does not lock out other clients', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    for (let i = 0; i < 5; i += 1) {
      await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'wrong-password' }, `192.0.2.3${i}`)
    }
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '192.0.2.99')
    expect(res.statusCode).toBe(200)
  })

  it('returns 413 for an oversized body', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) }, '192.0.2.20')
    expect(res.statusCode).toBe(413)
  })

  it('normalizes a username carrying control characters', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ok = await callEndpoint(routes, '/api/auth/login', { username: '\u0001admin\u007F', password: 'supersecret1' }, '192.0.2.24')
    expect(ok.statusCode).toBe(200)
  })
})

// ── change-password endpoint ─────────────────────────────────────────────────

describe('POST /api/auth/change-password', () => {
  it('rejects an unauthenticated remote caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/change-password', { oldPassword: 'supersecret1', newPassword: 'newsecret1' }, '192.0.2.40')
    expect(res.statusCode).toBe(401)
  })

  it('rejects a wrong old password for an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/change-password').handler(
      jsonRequest('POST', { oldPassword: 'wrong-password', newPassword: 'newsecret1' }, {
        ip: '192.0.2.41',
        host: 'dsh.example.com',
        cookie: sessionCookie('admin'),
      }),
      res,
    )
    expect(captured.statusCode).toBe(401)
  })

  it('rejects a too-short new password', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/change-password').handler(
      jsonRequest('POST', { oldPassword: 'supersecret1', newPassword: 'short' }, {
        ip: '192.0.2.42',
        host: 'dsh.example.com',
        cookie: sessionCookie('admin'),
      }),
      res,
    )
    expect(captured.statusCode).toBe(400)
  })

  it('rotates the signing secret and re-issues a session for the caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const oldCookie = sessionCookie('admin')
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/change-password').handler(
      jsonRequest('POST', { oldPassword: 'supersecret1', newPassword: 'newsecret1' }, {
        ip: '192.0.2.43',
        host: 'dsh.example.com',
        cookie: oldCookie,
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    // Old cookie is invalidated by the secret rotation
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(oldCookie, remote))).toBe(false)
    // The re-issued cookie from the response authenticates the new secret
    const freshCookie = captured.setCookie?.split(';')[0]
    expect(freshCookie).toMatch(/^dsh_sid=/)
    expect(auth.authenticate(requestWithCookie(freshCookie, remote))).toBe(true)
    // New credentials validate
    expect(validateCredentials('admin', 'newsecret1')).toBe(true)
  })

  it('allows a loopback caller without a session cookie', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const res = await callEndpoint(routes, '/api/auth/change-password', { oldPassword: 'supersecret1', newPassword: 'newsecret1' }, '127.0.0.1')
    expect(res.statusCode).toBe(200)
    expect(validateCredentials('admin', 'newsecret1')).toBe(true)
  })
})

// ── change-username endpoint ─────────────────────────────────────────────────

describe('POST /api/auth/change-username', () => {
  /** POST to change-username as the given caller. */
  async function callChangeUsername(
    routes: WebRoute[],
    body: unknown,
    opts: { ip: string; cookie?: string; loopback?: boolean },
  ): Promise<CapturedResponse> {
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/change-username').handler(
      jsonRequest('POST', body, {
        ip: opts.ip,
        host: opts.loopback === true ? '127.0.0.1:3080' : 'dsh.example.com',
        ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      }),
      res,
    )
    return captured
  }

  it('rejects an unauthenticated remote caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = await callChangeUsername(routes, { newUsername: 'alice', currentPassword: 'supersecret1' }, { ip: '192.0.2.50' })
    expect(captured.statusCode).toBe(401)
  })

  it('rejects a wrong current password for an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = await callChangeUsername(
      routes,
      { newUsername: 'alice', currentPassword: 'wrong-password' },
      { ip: '192.0.2.51', cookie: sessionCookie('admin') },
    )
    expect(captured.statusCode).toBe(401)
    expect(getUsername()).toBe('admin')
  })

  it('locks out a client after repeated wrong-password attempts', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.52'
    for (let i = 0; i < 5; i += 1) {
      const captured = await callChangeUsername(
        routes,
        { newUsername: 'alice', currentPassword: 'wrong-password' },
        { ip, cookie: sessionCookie('admin') },
      )
      expect(captured.statusCode).toBe(401)
    }
    const captured = await callChangeUsername(
      routes,
      { newUsername: 'alice', currentPassword: 'supersecret1' },
      { ip, cookie: sessionCookie('admin') },
    )
    expect(captured.statusCode).toBe(429)
  })

  it('rejects a username that strips to empty', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = await callChangeUsername(
      routes,
      { newUsername: '\u007F', currentPassword: 'supersecret1' },
      { ip: '192.0.2.53', cookie: sessionCookie('admin') },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('treats an unchanged username as a no-op without rotating the secret', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const before = getSessionSecret()
    const captured = await callChangeUsername(
      routes,
      { newUsername: '\u0001admin\u007F', currentPassword: 'supersecret1' },
      { ip: '192.0.2.54', cookie: sessionCookie('admin') },
    )
    expect(captured.statusCode).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ ok: true, username: 'admin' })
    expect(getSessionSecret()).toBe(before)
  })

  it('rotates the secret, re-issues a session, and stores the new username', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const oldCookie = sessionCookie('admin')
    const captured = await callChangeUsername(
      routes,
      { newUsername: 'alice', currentPassword: 'supersecret1' },
      { ip: '192.0.2.55', cookie: oldCookie },
    )
    expect(captured.statusCode).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ ok: true, username: 'alice' })
    // Old cookie is invalidated by the secret rotation
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(oldCookie, remote))).toBe(false)
    // The re-issued cookie from the response authenticates the new secret
    const freshCookie = captured.setCookie?.split(';')[0]
    expect(freshCookie).toMatch(/^dsh_sid=/)
    expect(auth.authenticate(requestWithCookie(freshCookie, remote))).toBe(true)
    // The username changed; the password is untouched
    expect(getUsername()).toBe('alice')
    expect(validateCredentials('alice', 'supersecret1')).toBe(true)
    expect(validateCredentials('admin', 'supersecret1')).toBe(false)
  })

  it('allows a loopback caller without a session cookie', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const captured = await callChangeUsername(
      routes,
      { newUsername: 'alice', currentPassword: 'supersecret1' },
      { ip: '127.0.0.1', loopback: true },
    )
    expect(captured.statusCode).toBe(200)
    expect(getUsername()).toBe('alice')
  })
})

// ── credential-store changePassword ──────────────────────────────────────────

describe('credential-store changePassword', () => {
  it('returns false when credentials are not set', () => {
    expect(changePassword('whatever', 'whatever1')).toBe(false)
  })

  it('returns false when the old password does not match', () => {
    registerCredentials('admin', 'supersecret1')
    expect(changePassword('wrong-password', 'newsecret1')).toBe(false)
    expect(validateCredentials('admin', 'supersecret1')).toBe(true)
  })

  it('replaces the password and rotates the secret on success', () => {
    registerCredentials('admin', 'supersecret1')
    const before = getSessionSecret()
    expect(changePassword('supersecret1', 'newsecret1')).toBe(true)
    expect(validateCredentials('admin', 'newsecret1')).toBe(true)
    expect(validateCredentials('admin', 'supersecret1')).toBe(false)
    expect(getSessionSecret()).not.toBe(before)
    expect(getUsername()).toBe('admin')
  })
})

// ── credential-store changeUsername ──────────────────────────────────────────

describe('credential-store changeUsername', () => {
  it('returns false when credentials are not set', () => {
    expect(changeUsername('alice', 'whatever')).toBe(false)
  })

  it('returns false when the current password does not match', () => {
    registerCredentials('admin', 'supersecret1')
    expect(changeUsername('alice', 'wrong-password')).toBe(false)
    expect(getUsername()).toBe('admin')
  })

  it('replaces the username and rotates the secret on success', () => {
    registerCredentials('admin', 'supersecret1')
    const before = getSessionSecret()
    expect(changeUsername('alice', 'supersecret1')).toBe(true)
    expect(getUsername()).toBe('alice')
    expect(validateCredentials('alice', 'supersecret1')).toBe(true)
    expect(validateCredentials('admin', 'supersecret1')).toBe(false)
    expect(getSessionSecret()).not.toBe(before)
  })
})

// ── loopback-login requirement (PR #17) ───────────────────────────────────────

describe('requireLoopbackLogin', () => {
  it('trusts loopback by default (flag off)', () => {
    const { auth } = fakeWebAuthContext('127.0.0.1')
    expect(auth.authenticate(requestWithCookie())).toBe(true)
  })

  it('requires a session from loopback once the flag is on', () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const { auth } = fakeWebAuthContext('127.0.0.1')
    // No cookie: loopback is no longer implicitly trusted.
    expect(auth.authenticate(requestWithCookie())).toBe(false)
    // With a valid session cookie: allowed.
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin')))).toBe(true)
  })

  it('GET /api/auth/policy reports the current flag', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    let captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.91', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(JSON.parse(captured.captured.body)).toEqual({ requireLoopbackLogin: false })

    setRequireLoopbackLogin(true)
    captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.92', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(JSON.parse(captured.captured.body)).toEqual({ requireLoopbackLogin: true })
  })

  it('rejects an unauthenticated caller flipping the flag', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/policy', { requireLoopbackLogin: true }, '192.0.2.93')
    expect(res.statusCode).toBe(401)
  })

  it('flips the flag for an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      jsonRequest('POST', { requireLoopbackLogin: true }, { ip: '192.0.2.94', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(getRequireLoopbackLogin()).toBe(true)
  })

  it('rejects a non-boolean payload', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      jsonRequest('POST', { requireLoopbackLogin: 'yes' }, { ip: '192.0.2.95', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(400)
  })

  it('refuses to enable before any admin is registered', async () => {
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      jsonRequest('POST', { requireLoopbackLogin: true }, { ip: '127.0.0.1', host: '127.0.0.1:3080' }),
      captured.res,
    )
    // No credentials: the loopback caller is trusted, but enabling with no
    // account to log into must be rejected.
    expect(captured.captured.statusCode).toBe(400)
  })

  it('preserves the flag across a password change', () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    changePassword('supersecret1', 'newsecret1')
    expect(getRequireLoopbackLogin()).toBe(true)
  })
})

// ── slider puzzle (settings-tab "人机验证") ──────────────────────────────────

/** Reads the challenge endpoint the way the login page does. */
async function fetchChallenge(routes: WebRoute[], ip: string, query = ''): Promise<Record<string, unknown>> {
  const { captured, res } = jsonResponseCapture()
  await findRoute(routes, '/api/auth/challenge').handler(
    httpRequest({ method: 'GET', ip, host: 'dsh.example.com', url: `/api/auth/challenge${query}` }),
    res,
  )
  return JSON.parse(captured.body) as Record<string, unknown>
}

/** A solved puzzle: the handle plus the drop only the store knows. */
async function solvePuzzle(routes: WebRoute[], ip: string): Promise<{ id: string; answer: string }> {
  const body = await fetchChallenge(routes, ip)
  const id = typeof body.id === 'string' ? body.id : ''
  const answer = sliderInternals.store.peek(id)?.payload.answer ?? { x: -1, y: -1 }
  return { id, answer: `${answer.x},${answer.y}` }
}

describe('slider policy', () => {
  it('is off by default, before and after registration', () => {
    expect(getSlideVerification()).toBe(false)
    registerCredentials('admin', 'supersecret1')
    expect(getSlideVerification()).toBe(false)
  })

  it('refuses to enable before any admin is registered, writing nothing', () => {
    expect(() => setSlideVerification(true)).toThrow()
    // The credential file's *existence* is what `hasCredentials()` reads as
    // "registered", so a file created just to hold this switch would close the
    // registration form permanently.
    expect(existsSync(authFile)).toBe(false)
    // Disabling is always a no-op, never an error.
    expect(() => setSlideVerification(false)).not.toThrow()
    expect(existsSync(authFile)).toBe(false)
  })

  it('GET /api/auth/challenge-policy reports the current flag', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    let captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/challenge-policy').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.110', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(JSON.parse(captured.captured.body)).toEqual({ slideVerification: false })

    setSlideVerification(true)
    captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/challenge-policy').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.111', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(JSON.parse(captured.captured.body)).toEqual({ slideVerification: true })
  })

  it('rejects an unauthenticated caller flipping the switch', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/challenge-policy', { slideVerification: true }, '192.0.2.112')
    expect(res.statusCode).toBe(401)
    expect(getSlideVerification()).toBe(false)
  })

  it('flips the switch for an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/challenge-policy').handler(
      jsonRequest('POST', { slideVerification: true }, { ip: '192.0.2.113', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(getSlideVerification()).toBe(true)
  })

  it('rejects a non-boolean payload', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/challenge-policy').handler(
      jsonRequest('POST', { slideVerification: 'yes' }, { ip: '192.0.2.114', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(400)
    expect(getSlideVerification()).toBe(false)
  })

  it('preserves the flag across a password change', () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    changePassword('supersecret1', 'newsecret1')
    expect(getSlideVerification()).toBe(true)
  })
})

describe('GET /api/auth/challenge', () => {
  it('answers enabled:false while the switch is off', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    // No cookie: the login page calls this before it has any session.
    expect(await fetchChallenge(routes, '192.0.2.115')).toEqual({ enabled: false })
  })

  it('issues an anonymous puzzle bound to the caller', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const body = await fetchChallenge(routes, '192.0.2.116')
    expect(body.enabled).toBe(true)
    expect(String(body.id)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(body.background).startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(String(body.piece).startsWith('data:image/svg+xml;base64,')).toBe(true)
    // Geometry travels with the puzzle so the page hardcodes nothing.
    expect(body.width).toBe(300)
    expect(body.height).toBe(150)
    expect(typeof body.pieceWidth).toBe('number')
    expect(typeof body.pieceHeight).toBe('number')
    expect(typeof body.startX).toBe('number')
    expect(typeof body.startY).toBe('number')
    expect(typeof body.tolerance).toBe('number')
    // The piece never starts within a drop of the slot's row: lining it up is
    // real work on both axes.
    expect(Number(body.startY) - MAX_ANSWER_Y).toBeGreaterThan(TOLERANCE)
    expect(Number(body.startX)).toBeLessThan(96)
    expect(sliderInternals.store.peek(String(body.id))?.clientKey).toBe('192.0.2.116')
  })

  it('renders for the theme the page asks for', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const body = await fetchChallenge(routes, '192.0.2.117', '?theme=dark')
    const svg = Buffer.from(String(body.background).split(',')[1] ?? '', 'base64').toString('utf8')
    expect(svg).toContain('#42557d')
  })

  it('rejects anything but GET', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/challenge').handler(
      httpRequest({ method: 'POST', ip: '192.0.2.118', host: 'dsh.example.com' }),
      res,
    )
    expect(captured.statusCode).toBe(405)
  })
})

describe('login with the slider puzzle on', () => {
  it('refuses a login that carries no puzzle', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '192.0.2.130')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ challengeExpired: true })
    // The right password bought nothing, and no session was minted.
    expect(res.setCookie).toBeUndefined()
  })

  it('accepts a login that solves the puzzle', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.131'
    const solved = await solvePuzzle(routes, ip)
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: solved.answer }, ip)
    expect(res.statusCode).toBe(200)
    expect(res.setCookie?.startsWith('dsh_sid=')).toBe(true)
  })

  it('refuses a drop that misses the slot', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.132'
    const body = await fetchChallenge(routes, ip)
    const answer = sliderInternals.store.peek(String(body.id))?.payload.answer ?? { x: 0, y: 0 }
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: body.id, challengeAnswer: `${answer.x + 60},${answer.y}` }, ip)
    expect(res.statusCode).toBe(400)
    expect(res.setCookie).toBeUndefined()
  })

  it('refuses a drop reported from another address', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const solved = await solvePuzzle(routes, '192.0.2.133')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: solved.answer }, '192.0.2.134')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ challengeExpired: true })
  })

  it('burns the puzzle, so one solve buys one attempt', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.135'
    const solved = await solvePuzzle(routes, ip)
    const first = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: solved.answer }, ip)
    expect(first.statusCode).toBe(200)
    // Same (valid) drop again: the puzzle is gone.
    const replay = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: solved.answer }, ip)
    expect(replay.statusCode).toBe(400)
    expect(replay.setCookie).toBeUndefined()
  })

  it('counts a missed drop against the login lockout', async () => {
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const ip = '192.0.2.136'
    for (let i = 0; i < 5; i += 1) {
      const solved = await solvePuzzle(routes, ip)
      const missed = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: '0,0' }, ip)
      expect(missed.statusCode).toBe(400)
    }
    // Five missed puzzles is five failures: the correct password is locked out.
    const solved = await solvePuzzle(routes, ip)
    const locked = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1', challengeId: solved.id, challengeAnswer: solved.answer }, ip)
    expect(locked.statusCode).toBe(429)
  })

  it('gates a loopback caller too', async () => {
    // The switch is about the credential check, not the peer address: an
    // attacker running on the host is exactly who a loopback exemption would
    // let through.
    registerCredentials('admin', 'supersecret1')
    setSlideVerification(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '127.0.0.1')
    expect(res.statusCode).toBe(400)
  })

  it('leaves the login endpoint alone while the switch is off', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '192.0.2.137')
    expect(res.statusCode).toBe(200)
  })
})

// ── session lifetime (settings-tab "会话有效期") ─────────────────────────────

describe('session max age', () => {
  it('defaults to 14 days before and after registration', () => {
    expect(getSessionMaxAgeDays()).toBe(14)
    registerCredentials('admin', 'supersecret1')
    expect(getSessionMaxAgeDays()).toBe(14)
  })

  it('GET /api/auth/session-max-age reports the configured days', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    let captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/session-max-age').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.96', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(JSON.parse(captured.captured.body)).toEqual({ days: 14 })

    setSessionMaxAgeDays(90)
    captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/session-max-age').handler(
      httpRequest({ method: 'GET', ip: '192.0.2.97', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(JSON.parse(captured.captured.body)).toEqual({ days: 90 })
  })

  it('persists the selected days for an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/session-max-age').handler(
      jsonRequest('POST', { days: 30 }, { ip: '192.0.2.98', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
      captured.res,
    )
    expect(captured.captured.statusCode).toBe(200)
    expect(JSON.parse(captured.captured.body)).toEqual({ ok: true, days: 30 })
    expect(getSessionMaxAgeDays()).toBe(30)
  })

  it('is a no-op when the value is unchanged', () => {
    registerCredentials('admin', 'supersecret1')
    const before = getSessionSecret()
    setSessionMaxAgeDays(14)
    expect(getSessionMaxAgeDays()).toBe(14)
    // Unchanged value must not rewrite the file (and never rotates the secret).
    expect(getSessionSecret()).toBe(before)
  })

  it('rejects a value outside the selectable choices', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    for (const days of [10, -1, 0, '30', 30.5]) {
      const captured = jsonResponseCapture()
      await findRoute(routes, '/api/auth/session-max-age').handler(
        jsonRequest('POST', { days }, { ip: '192.0.2.99', host: 'dsh.example.com', cookie: sessionCookie('admin') }),
        captured.res,
      )
      expect(captured.captured.statusCode).toBe(400)
    }
    expect(getSessionMaxAgeDays()).toBe(14)
  })

  it('rejects an unauthenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callEndpoint(routes, '/api/auth/session-max-age', { days: 30 }, '192.0.2.100')
    expect(res.statusCode).toBe(401)
    expect(getSessionMaxAgeDays()).toBe(14)
  })

  it('refuses to change before any admin is registered', async () => {
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const captured = jsonResponseCapture()
    await findRoute(routes, '/api/auth/session-max-age').handler(
      jsonRequest('POST', { days: 30 }, { ip: '127.0.0.1', host: '127.0.0.1:3080' }),
      captured.res,
    )
    // No credentials: the loopback caller is trusted, but there is no session
    // store yet to attach a lifetime to.
    expect(captured.captured.statusCode).toBe(400)
  })

  it('never rotates the session secret (existing sessions keep their lifetime)', () => {
    registerCredentials('admin', 'supersecret1')
    const before = getSessionSecret()
    setSessionMaxAgeDays(180)
    expect(getSessionSecret()).toBe(before)
  })

  it('preserves the value across a password change', () => {
    registerCredentials('admin', 'supersecret1')
    setSessionMaxAgeDays(60)
    changePassword('supersecret1', 'newsecret1')
    expect(getSessionMaxAgeDays()).toBe(60)
  })

  it('issues login cookies whose Max-Age reflects the configured days', async () => {
    registerCredentials('admin', 'supersecret1')
    setSessionMaxAgeDays(3)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const captured = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '192.0.2.101')
    expect(captured.statusCode).toBe(200)
    const sessionCookieHeader = captured.setCookies?.find((value) => value.startsWith('dsh_sid='))
    expect(sessionCookieHeader).toBeDefined()
    // 3 days = 259200 seconds.
    expect(sessionCookieHeader).toContain('Max-Age=259200')
  })
})

