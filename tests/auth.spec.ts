import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { PassThrough } from 'node:stream'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, type WebAuthService } from '../src/auth.ts'
import {
  registerCredentials,
  signSession,
  hardenCredentialFilePermissions,
  changePassword,
  changeUsername,
  getSessionSecret,
  getUsername,
  normalizeUsername,
  validateCredentials,
  getRequireLoopbackLogin,
  setRequireLoopbackLogin,
} from '../src/credential-store.ts'

let authFile: string
let authDir: string

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'dsh-web-auth-'))
  authFile = join(authDir, 'web-auth.json')
  process.env.DSH_WEB_AUTH_FILE = authFile
})

afterEach(() => {
  delete process.env.DSH_WEB_AUTH_FILE
  rmSync(authDir, { recursive: true, force: true })
})

/** Fake context that records every registered route for handler-level tests. */
function fakeWebAuthContext(bindHost: string, preRegistered: WebRoute[] = []) {
  const provided = new Map<string, unknown>()
  const routes: WebRoute[] = []
  const webServer = {
    host: bindHost,
    port: 3080,
    exact: new Map<string, WebRoute>(),
    prefixes: new Map<string, WebRoute>(),
    upgrades: new Map<string, { path: string; handler: (req: unknown, socket: unknown, head: unknown) => unknown }>(),
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
}

function jsonResponseCapture() {
  const captured: CapturedResponse = { statusCode: 0, body: '' }
  const res = {
    writeHead: (code: number, headers?: Record<string, string | string[]>) => {
      captured.statusCode = code
      if (headers !== undefined) {
        const value = headers['set-cookie']
        if (Array.isArray(value)) captured.setCookie = value[0]
        else if (typeof value === 'string') captured.setCookie = value
      }
    },
    end: (body?: string) => { captured.body = body ?? '' },
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

// ── requireLoopbackLogin: loopback loses its implicit trust ──────────────────

describe('requireLoopbackLogin trust gating', () => {
  /** A genuine loopback request: loopback peer address and loopback Host. */
  const loopback = { ip: '127.0.0.1', host: '127.0.0.1:3080' }

  it('keeps trusting loopback while the switch is off (default)', () => {
    registerCredentials('admin', 'supersecret1')
    const { auth } = fakeWebAuthContext('127.0.0.1')
    expect(auth.authenticate(requestWithCookie(undefined, loopback))).toBe(true)
  })

  it('requires a session from loopback once enabled', () => {
    // Given: the switch is on. When: a genuine loopback request with no
    // cookie. Then: it is treated like any remote caller.
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(undefined, loopback))).toBe(false)
  })

  it('accepts a valid session cookie from loopback while enabled', () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin'), loopback))).toBe(true)
  })

  it('restores loopback trust after the switch is turned off again', () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    setRequireLoopbackLogin(false)
    const { auth } = fakeWebAuthContext('127.0.0.1')
    expect(auth.authenticate(requestWithCookie(undefined, loopback))).toBe(true)
  })

  it('still lets a sessionless loopback user log in while enabled', async () => {
    // The recovery path behind the no-self-lockout guarantee: with the
    // switch on, a loopback browser without a session is bounced to /login,
    // so the login endpoint itself must keep working and hand out a cookie
    // that authenticates.
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const { routes, auth } = fakeWebAuthContext('127.0.0.1')
    const res = await callEndpoint(routes, '/api/auth/login', { username: 'admin', password: 'supersecret1' }, '127.0.0.1')
    expect(res.statusCode).toBe(200)
    const cookie = res.setCookie?.split(';')[0]
    expect(cookie).toMatch(/^dsh_sid=/)
    expect(auth.authenticate(requestWithCookie(cookie))).toBe(true)
  })

  it('rejects an unauthenticated loopback request on a protected route', async () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
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
    const rejected = jsonResponseCapture()
    await route.handler(httpRequest(loopback), rejected.res)
    expect(rejected.captured.statusCode).toBe(401)
    expect(seenHosts).toEqual([])

    const ok = jsonResponseCapture()
    await route.handler(httpRequest({ ...loopback, cookie: sessionCookie('admin') }), ok.res)
    expect(ok.captured.statusCode).toBe(200)
    // Loopback authority passes through untouched (no Host rewrite needed).
    expect(seenHosts).toEqual(['127.0.0.1:3080'])
  })
})

// ── route wrapping coverage (all routes, retroactive + future) ───────────────

/** A plain GET request with configurable Host and session cookie. */
function httpRequest(opts: { host?: string; cookie?: string; ip?: string }): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  return {
    headers,
    method: 'GET',
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

    // Remote caller + valid session: rewrites Host to loopback.
    const ok = jsonResponseCapture()
    await route.handler(
      httpRequest({ host: '192.168.5.216:3080', ip: '192.168.5.216', cookie: sessionCookie('admin') }),
      ok.res,
    )
    expect(ok.captured.statusCode).toBe(200)
    expect(seenHosts).toEqual(['127.0.0.1:3080'])

    // No session: rejected.
    const rejected = jsonResponseCapture()
    await route.handler(httpRequest({ host: '192.168.5.216:3080', ip: '192.168.5.216' }), rejected.res)
    expect(rejected.captured.statusCode).toBe(401)
  })

  it('rewrites the authority for a reverse-proxied caller on a loopback bind', async () => {
    // dsh bound to 127.0.0.1 behind a proxy: the request arrives from loopback
    // but carries the public Host, so it needs a session and the same
    // loopback rewrite to clear dsh's privileged-method fence.
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
    expect(seenHosts).toEqual(['127.0.0.1:3080'])

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
    expect(seenHosts).toEqual(['127.0.0.1:3080'])
  })

  it('wraps upgrade routes so WebSocket handshakes pass the trust fence', async () => {
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

    // Remote caller + valid session: rewrites Host to loopback for the fence.
    const socket = { end: () => {} } as unknown as Duplex
    upgradeRoute!.handler(
      httpRequest({ host: 'dsh.example.com:3080', ip: '192.0.2.73', cookie: sessionCookie('admin') }),
      socket,
      Buffer.alloc(0),
    )
    expect(seenHosts).toEqual(['127.0.0.1:3080'])

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
      username?: string
    }
  }

  it('reports a local browser as authenticated even before registration', async () => {
    // Regression test for the / -> /login -> / redirect loop: a loopback
    // deployment trusts the local browser, so an unregistered deployment must
    // not send it to a login page that would bounce it straight back.
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: '127.0.0.1:3080' })
    expect(status).toEqual({ registered: false, authenticated: true })
  })

  it('reports a proxied browser as unauthenticated until it logs in', async () => {
    // dsh bound to loopback behind a proxy: the public Host makes the request
    // remote, so registration and login apply instead of implicit trust.
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: 'dsh.example.com' })
    expect(status).toEqual({ registered: true, authenticated: false })
  })

  it('reports a LAN caller as unauthenticated until it logs in', async () => {
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('0.0.0.0', remote)
    expect(status).toEqual({ registered: true, authenticated: false })
  })

  it('names the session user for an authenticated remote caller', async () => {
    registerCredentials('admin', 'supersecret1')
    const status = await readStatus('0.0.0.0', { ...remote, cookie: sessionCookie('admin') })
    expect(status).toEqual({ registered: true, authenticated: true, username: 'admin' })
  })

  it('reports a loopback browser as unauthenticated once the switch is on', async () => {
    // Given: requireLoopbackLogin is enabled. When: a genuine loopback
    // browser asks for status without a session. Then: the SPA's redirect
    // script sees authenticated=false and sends it to /login.
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const status = await readStatus('127.0.0.1', { ip: '127.0.0.1', host: '127.0.0.1:3080' })
    expect(status).toEqual({ registered: true, authenticated: false })
  })

  it('names the session user for a logged-in loopback browser while enabled', async () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const status = await readStatus('127.0.0.1', {
      ip: '127.0.0.1',
      host: '127.0.0.1:3080',
      cookie: sessionCookie('admin'),
    })
    expect(status).toEqual({ registered: true, authenticated: true, username: 'admin' })
  })
})

// ── auth policy store: requireLoopbackLogin ──────────────────────────────────

describe('auth policy store', () => {
  it('defaults to false before registration', () => {
    // Given: no credential file. When: reading the policy.
    // Then: loopback exemption stays on (previous behavior).
    expect(getRequireLoopbackLogin()).toBe(false)
  })

  it('persists the flag next to the credentials', () => {
    // Given: a registered admin. When: enabling the switch.
    // Then: the value survives a re-read from disk.
    registerCredentials('admin', 'supersecret1')
    expect(getRequireLoopbackLogin()).toBe(false)
    setRequireLoopbackLogin(true)
    expect(getRequireLoopbackLogin()).toBe(true)
    setRequireLoopbackLogin(false)
    expect(getRequireLoopbackLogin()).toBe(false)
  })

  it('keeps the flag across password and username changes', () => {
    // Given: the switch is on. When: rotating password/username.
    // Then: the policy is preserved by the single-write credential updates.
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    changePassword('supersecret1', 'newsecret1')
    expect(getRequireLoopbackLogin()).toBe(true)
    changeUsername('alice', 'newsecret1')
    expect(getRequireLoopbackLogin()).toBe(true)
  })

  it('refuses to enable before any admin is registered', () => {
    // Given: no credentials exist. When: enabling the switch.
    // Then: rejected — with no account to log into, every caller
    // (loopback included) would be locked out of the server entirely.
    expect(() => setRequireLoopbackLogin(true)).toThrow()
    expect(getRequireLoopbackLogin()).toBe(false)
  })
})

// ── GET/POST /api/auth/policy: the switch endpoint ───────────────────────────

describe('GET/POST /api/auth/policy', () => {
  /** Call the policy endpoint and capture the response. */
  async function callPolicy(
    routes: WebRoute[],
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    opts: { ip?: string; host?: string; cookie?: string } = {},
  ): Promise<CapturedResponse> {
    const { captured, res } = jsonResponseCapture()
    const req = method === 'GET'
      ? httpRequest(opts)
      : jsonRequest(method, body ?? {}, opts)
    await findRoute(routes, '/api/auth/policy').handler(req, res)
    return captured
  }

  it('rejects an unauthenticated remote caller for reads and writes', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('0.0.0.0')
    expect((await callPolicy(routes, 'GET', undefined, remote)).statusCode).toBe(401)
    expect((await callPolicy(routes, 'POST', { requireLoopbackLogin: true }, remote)).statusCode).toBe(401)
    expect(getRequireLoopbackLogin()).toBe(false)
  })

  it('reports the current flag to an authenticated caller', async () => {
    registerCredentials('admin', 'supersecret1')
    setRequireLoopbackLogin(true)
    const { routes } = fakeWebAuthContext('0.0.0.0')
    const res = await callPolicy(routes, 'GET', undefined, { ...remote, cookie: sessionCookie('admin') })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ requireLoopbackLogin: true })
  })

  it('rejects a non-boolean value', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('127.0.0.1')
    expect((await callPolicy(routes, 'POST', { requireLoopbackLogin: 'yes' })).statusCode).toBe(400)
    expect((await callPolicy(routes, 'POST', {})).statusCode).toBe(400)
    expect(getRequireLoopbackLogin()).toBe(false)
  })

  it('refuses to enable before an admin is registered', async () => {
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const res = await callPolicy(routes, 'POST', { requireLoopbackLogin: true })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBeTruthy()
    expect(getRequireLoopbackLogin()).toBe(false)
  })

  it('applies the new value immediately after a successful write', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes, auth } = fakeWebAuthContext('127.0.0.1')
    const res = await callPolicy(routes, 'POST', { requireLoopbackLogin: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, requireLoopbackLogin: true })
    // The very next loopback request without a session is now rejected.
    expect(auth.authenticate(requestWithCookie())).toBe(false)
    // ...and the loopback caller still holding a session stays in.
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin')))).toBe(true)
  })

  it('answers 405 for other methods', async () => {
    registerCredentials('admin', 'supersecret1')
    const { routes } = fakeWebAuthContext('127.0.0.1')
    const { captured, res } = jsonResponseCapture()
    await findRoute(routes, '/api/auth/policy').handler(
      jsonRequest('DELETE', {}, { ip: '127.0.0.1' }),
      res,
    )
    expect(captured.statusCode).toBe(405)
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
