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
  getSessionSecret,
  getUsername,
  validateCredentials,
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

function requestWithCookie(cookie?: string): IncomingMessage {
  return {
    headers: cookie === undefined ? {} : { cookie },
  } as IncomingMessage
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
function jsonRequest(method: string, body: unknown, opts: { ip?: string; cookie?: string } = {}): IncomingMessage {
  const req = new PassThrough()
  Object.assign(req, {
    method,
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
    headers: {
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

// ── service-level tests (session semantics) ──────────────────────────────────

describe('web-auth service', () => {
  it('allows loopback requests without credentials', () => {
    const { auth } = fakeWebAuthContext('127.0.0.1')
    expect(auth.authenticate(requestWithCookie())).toBe(true)
  })

  it('requires a valid session cookie when bound to 0.0.0.0', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie())).toBe(false)
    expect(auth.authenticate(requestWithCookie('dsh_sid=forged.invalid'))).toBe(false)
  })

  it('accepts a valid session cookie on 0.0.0.0', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(sessionCookie('admin')))).toBe(true)
  })

  it('rejects an expired session cookie on 0.0.0.0', () => {
    registerCredentials('admin', 'secret')
    const { auth } = fakeWebAuthContext('0.0.0.0')
    const expired = sessionCookie('admin', -60)
    expect(auth.authenticate(requestWithCookie(expired))).toBe(false)
  })
})

// ── route wrapping coverage (all routes, retroactive + future) ───────────────

/** A plain GET request with configurable Host and session cookie. */
function httpRequest(opts: { host?: string; cookie?: string }): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.host !== undefined) headers.host = opts.host
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  return { headers, method: 'GET' } as IncomingMessage
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

    // Remote (non-loopback) Host + valid session: rewrites Host to loopback.
    const ok = jsonResponseCapture()
    await route.handler(httpRequest({ host: '192.168.5.216:3080', cookie: sessionCookie('admin') }), ok.res)
    expect(ok.captured.statusCode).toBe(200)
    expect(seenHosts).toEqual(['127.0.0.1:3080'])

    // No session: rejected.
    const rejected = jsonResponseCapture()
    await route.handler(httpRequest({ host: '192.168.5.216:3080' }), rejected.res)
    expect(rejected.captured.statusCode).toBe(401)
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
    await route.handler(httpRequest({ host: 'dsh.example.com:3080', cookie: sessionCookie('admin') }), ok.res)
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

    // Remote Host + valid session: rewrites Host to loopback for the fence.
    const socket = { end: () => {} } as unknown as Duplex
    upgradeRoute!.handler(
      httpRequest({ host: 'dsh.example.com:3080', cookie: sessionCookie('admin') }),
      socket,
      Buffer.alloc(0),
    )
    expect(seenHosts).toEqual(['127.0.0.1:3080'])

    // No session: refused.
    seenHosts.length = 0
    upgradeRoute!.handler(httpRequest({ host: 'dsh.example.com:3080' }), socket, Buffer.alloc(0))
    expect(seenHosts).toEqual([])
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
})

// ── change-password endpoint ─────────────────────────────────────────────────

describe('POST /api/auth/change-password', () => {
  it('rejects an unauthenticated caller on 0.0.0.0', async () => {
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
        cookie: oldCookie,
      }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    // Old cookie is invalidated by the secret rotation
    const { auth } = fakeWebAuthContext('0.0.0.0')
    expect(auth.authenticate(requestWithCookie(oldCookie))).toBe(false)
    // The re-issued cookie from the response authenticates the new secret
    const freshCookie = captured.setCookie?.split(';')[0]
    expect(freshCookie).toMatch(/^dsh_sid=/)
    expect(auth.authenticate(requestWithCookie(freshCookie))).toBe(true)
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
