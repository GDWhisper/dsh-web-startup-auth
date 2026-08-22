import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  WEB_STARTUP_SERVICE,
  runAuthReset,
  type WebStartupValues,
} from '../src/startup.ts'
import {
  registerCredentials,
  validateCredentials,
  signSession,
  verifySession,
} from '../src/credential-store.ts'

let authFile: string
let authDir: string

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  authFile = join(authDir, 'web-auth.json')
  process.env.DSH_WEB_AUTH_FILE = authFile
})

afterEach(() => {
  delete process.env.DSH_WEB_AUTH_FILE
  rmSync(authDir, { recursive: true, force: true })
})

function makeFakeContext() {
  const provided = new Map<string, unknown>()
  const exitCodes: number[] = []
  const ctx = {
    provide: (key: string, value: unknown) => { provided.set(key, value) },
    get: (key: string) => provided.get(key),
    provided,
    exitCodes,
  } as unknown as Context & { provided: Map<string, unknown>; exitCodes: number[] }
  return ctx
}

function runStartup(ctx: ReturnType<typeof makeFakeContext>, args: string[]) {
  const originalGet = ctx.get.bind(ctx)
  ;(ctx as unknown as { get: (key: string) => unknown }).get = (key: string) => {
    if (key === 'cmdlineArgs') return { get: () => args }
    if (key === 'appExit') return (code: number) => { ctx.exitCodes.push(code) }
    return originalGet(key)
  }
  try {
    apply(ctx)
  } catch (error) {
    return { error }
  }
  return {}
}

/** Run the full `auth-reset` subcommand through commander and wait for its action. */
async function runAuthResetCli(args: string[]): Promise<ReturnType<typeof makeFakeContext>> {
  const ctx = makeFakeContext()
  const originalGet = ctx.get.bind(ctx)
  ;(ctx as unknown as { get: (key: string) => unknown }).get = (key: string) => {
    if (key === 'cmdlineArgs') return { get: () => args }
    if (key === 'appExit') return (code: number) => { ctx.exitCodes.push(code) }
    return originalGet(key)
  }
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = () => true
  process.stderr.write = () => true
  try {
    apply(ctx)
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  return ctx
}

/** Build a signed session cookie issued under the current secret. */
function sessionCookie(username: string, ttlSec = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = JSON.stringify({ u: username, e: exp })
  const sig = signSession(payload)
  if (sig === undefined) throw new Error('session signing unavailable')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`
}

describe('remote web-startup', () => {
  it('accepts --host 0.0.0.0 and provides webStartup', () => {
    const ctx = makeFakeContext()
    const result = runStartup(ctx, ['--host', '0.0.0.0', '--port', '8080'])
    expect(result.error).toBeUndefined()
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    expect(values).toEqual({ host: '0.0.0.0', port: 8080, trustedHosts: [], openBrowser: true })
  })

  it('keeps trusted-host parsing', () => {
    const ctx = makeFakeContext()
    runStartup(ctx, ['--host', '127.0.0.1', '--trusted-host', 'lab.internal', '10.0.0.8'])
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    expect(values).toEqual({
      host: '127.0.0.1',
      trustedHosts: ['lab.internal', '10.0.0.8'],
      openBrowser: true,
    })
  })

  it('accepts --no-open and flips openBrowser to false', () => {
    const ctx = makeFakeContext()
    const result = runStartup(ctx, ['--host', '0.0.0.0', '--no-open'])
    expect(result.error).toBeUndefined()
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    expect(values).toEqual({ host: '0.0.0.0', trustedHosts: [], openBrowser: false })
  })

  it('does not provide webStartup when the auth-reset subcommand is invoked', async () => {
    const ctx = await runAuthResetCli(['auth-reset', '--password', 'supersecret2'])
    expect(ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })
})

describe('runAuthReset', () => {
  it('replaces the password and keeps the username', async () => {
    registerCredentials('admin', 'supersecret1')
    expect(validateCredentials('admin', 'supersecret1')).toBe(true)

    await runAuthReset({ password: 'supersecret2' })

    expect(validateCredentials('admin', 'supersecret2')).toBe(true)
    expect(validateCredentials('admin', 'supersecret1')).toBe(false)
  })

  it('rotates the session secret, invalidating previously issued cookies', async () => {
    registerCredentials('admin', 'supersecret1')
    const oldCookie = sessionCookie('admin')
    const oldPayload = oldCookie.slice(0, oldCookie.indexOf('.'))
    const oldSig = oldCookie.slice(oldCookie.indexOf('.') + 1)

    await runAuthReset({ password: 'supersecret2' })

    expect(verifySession(oldPayload, oldSig)).toBe(false)
  })

  it('throws when no credentials exist yet', async () => {
    await expect(runAuthReset({ password: 'supersecret2' })).rejects.toThrow('尚未注册管理员账号')
  })

  it('rejects a password below the minimum length', async () => {
    registerCredentials('admin', 'supersecret1')
    await expect(runAuthReset({ password: 'short' })).rejects.toThrow('密码至少')
  })
})

describe('dsh --profile web auth-reset (commander integration)', () => {
  it('resets the password and exits 0', async () => {
    registerCredentials('admin', 'supersecret1')
    const ctx = await runAuthResetCli(['auth-reset', '--password', 'supersecret2'])
    expect(ctx.exitCodes).toEqual([0])
    expect(validateCredentials('admin', 'supersecret2')).toBe(true)
    expect(validateCredentials('admin', 'supersecret1')).toBe(false)
  })

  it('exits 1 with an error message on failure', async () => {
    const ctx = await runAuthResetCli(['auth-reset', '--password', 'supersecret2'])
    expect(ctx.exitCodes).toEqual([1])
  })
})
