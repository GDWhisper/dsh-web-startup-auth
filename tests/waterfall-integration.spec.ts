import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/auth.ts'
import { registerCredentials, signSession } from '../src/credential-store.ts'

/**
 * Integration tests for the shared-API session gate on the REAL cordis events
 * bus. The unit tests in auth.spec.ts call the listener function directly;
 * these prove the two properties that only a real bus can show: a listener
 * registered on the plugin's own context receives the `connection/request`
 * waterfall a foreign context dispatches (one shared EventsService per tree),
 * and a veto (no `next()` call) really stops the chain tail — the bridge —
 * from running.
 */

interface Harness {
  ctx: Context
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  bridged: () => boolean
}

function harness(): Harness {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const webServer = {
    host: '0.0.0.0',
    port: 3080,
    exact: new Map<string, WebRoute>(),
    prefixes: new Map<string, WebRoute>(),
    upgrades: new Map<string, unknown>(),
    fallback: undefined as WebRoute['handler'] | undefined,
    register: (route: WebRoute) => {
      routes.push(route)
      const table = route.kind === 'exact' ? webServer.exact : webServer.prefixes
      table.set(route.path, route)
      return () => {}
    },
    registerUpgrade: () => () => {},
    registerFallback: () => () => {},
    tapIndex: () => {},
  }
  ;(ctx as unknown as { provide: (key: string, value: unknown) => void }).provide('webServer', webServer)
  apply(ctx, {})

  let bridged = false
  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    bridged = false
    await (ctx as unknown as {
      waterfall: (name: string, ...args: unknown[]) => Promise<unknown>
    }).waterfall('connection/request', req, res, async () => { bridged = true })
  }
  return { ctx, dispatch, bridged: () => bridged }
}

function request(opts: { ip?: string; host?: string; cookie?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = { host: opts.host ?? '192.168.5.216:3080' }
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  return {
    headers,
    method: 'POST',
    url: '/api/rpc',
    socket: { remoteAddress: opts.ip ?? '192.168.5.216' },
  } as unknown as IncomingMessage
}

function responseCapture() {
  const captured: { statusCode: number; body: string } = { statusCode: 0, body: '' }
  const res = {
    writeHead: (code: number) => { captured.statusCode = code },
    end: (body?: string) => { captured.body = body ?? '' },
  } as unknown as ServerResponse
  return { captured, res }
}

function sessionCookie(username: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = JSON.stringify({ u: username, e: exp })
  const sig = signSession(payload)
  if (sig === undefined) throw new Error('session signing unavailable')
  return `dsh_sid=${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`
}

let authDir: string

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'dsh-web-auth-int-'))
  process.env.DSH_WEB_AUTH_FILE = join(authDir, 'web-auth.json')
})

afterEach(() => {
  delete process.env.DSH_WEB_AUTH_FILE
  rmSync(authDir, { recursive: true, force: true })
})

describe('connection/request waterfall on the real events bus', () => {
  it('vetoes a session-less request so the bridge never runs', async () => {
    const h = harness()
    const { captured, res } = responseCapture()
    await h.dispatch(request(), res)
    expect(h.bridged()).toBe(false)
    expect(captured.statusCode).toBe(401)
    expect(JSON.parse(captured.body)).toEqual({ error: 'unauthorized' })
  })

  it('reaches the bridge with a live session', async () => {
    registerCredentials('admin', 'secret1')
    const h = harness()
    const { captured, res } = responseCapture()
    await h.dispatch(request({ cookie: sessionCookie('admin') }), res)
    expect(h.bridged()).toBe(true)
    expect(captured.statusCode).toBe(0)
  })

  it('reaches the bridge from a genuine loopback caller', async () => {
    const h = harness()
    const { captured, res } = responseCapture()
    await h.dispatch(request({ ip: '127.0.0.1', host: '127.0.0.1:3080' }), res)
    expect(h.bridged()).toBe(true)
    expect(captured.statusCode).toBe(0)
  })
})
