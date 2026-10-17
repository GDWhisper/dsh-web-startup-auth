import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  getSessionSecret,
  getUsername,
} from '../src/credential-store.ts'

// Deterministic interface enumeration for the trustedHosts derivation (the
// LAN authorities appended to --trusted-host values); tmpdir stays real.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: vi.fn(() => ({
    eth0: [
      { address: 'fd00::1', family: 'IPv6', internal: false },
      { address: 'fe80::1234%eth0', family: 'IPv6', internal: false },
      { address: '10.0.0.5', family: 'IPv4', internal: false },
    ],
    lo: [{ address: '::1', family: 'IPv6', internal: true }],
  })),
}))

let authFile: string
let authDir: string
const bootRoots: string[] = []

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  authFile = join(authDir, 'web-auth.json')
  process.env.DSH_WEB_AUTH_FILE = authFile
})

afterEach(() => {
  delete process.env.DSH_WEB_AUTH_FILE
  rmSync(authDir, { recursive: true, force: true })
  for (const root of bootRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A profile-root-shaped fixture whose boot-path webserver declares the
 * 0.2.1-line `tls` member, so the capability probe reports true.
 */
function tlsCapableBootRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-startup-boot-'))
  bootRoots.push(root)
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-host-webserver')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host-webserver', version: '0.0.0', main: 'index.js' }))
  writeFileSync(join(pkg, 'index.js'), 'module.exports = { WebServer: { Config: { dict: { host: {}, tls: {} } } } }\n')
  return pathToFileURL(`${root}/`).href
}

/**
 * The pre-0.2.1 shape: a webserver whose Config declares no `tls` member, so
 * the capability probe reports false. Needed because the installed package is
 * itself the 0.2.1 line — an incapable harness can no longer be expressed by
 * omitting the base URL.
 */
function tlsIncapableBootRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-startup-boot-'))
  bootRoots.push(root)
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-host-webserver')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-host-webserver', version: '0.0.0', main: 'index.js' }))
  writeFileSync(join(pkg, 'index.js'), 'module.exports = { WebServer: { Config: { dict: { host: {} } } } }\n')
  return pathToFileURL(`${root}/`).href
}

function makeFakeContext(baseUrl?: string) {
  const provided = new Map<string, unknown>()
  const exitCodes: number[] = []
  const ctx = {
    provide: (key: string, value: unknown) => { provided.set(key, value) },
    get: (key: string) => provided.get(key),
    provided,
    exitCodes,
    ...baseUrl !== undefined && { baseUrl },
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
  // program.error prints through the cmdline output before routing the
  // CommanderError to appExit; keep the expected usage-error chatter out of
  // the test log.
  const stderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = () => true
  try {
    apply(ctx)
  } catch (error) {
    return { error }
  } finally {
    process.stderr.write = stderr
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
  it('accepts --host 0.0.0.0 and provides webStartup with the LAN trust list', () => {
    const ctx = makeFakeContext()
    const result = runStartup(ctx, ['--host', '0.0.0.0', '--port', '8080'])
    expect(result.error).toBeUndefined()
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    // The 0.0.0.0 bind serves every IPv4 interface address, so those are
    // trusted — mirroring the stock resolveLanTrust of the 0.2.0 line.
    expect(values).toEqual({ host: '0.0.0.0', port: 8080, trustedHosts: ['10.0.0.5'], openBrowser: true })
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
    expect(values).toEqual({ host: '0.0.0.0', trustedHosts: ['10.0.0.5'], openBrowser: false })
  })

  it('does not provide webStartup when the auth-reset subcommand is invoked', async () => {
    const ctx = await runAuthResetCli(['auth-reset', '--password', 'supersecret2'])
    expect(ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })

  it('accepts --host :: and normalizes the bracketed form', () => {
    const ctx = makeFakeContext()
    expect(runStartup(ctx, ['--host', '::', '--port', '8080']).error).toBeUndefined()
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    expect(values?.host).toBe('::')

    const bracketed = makeFakeContext()
    expect(runStartup(bracketed, ['--host', '[::1]']).error).toBeUndefined()
    expect((bracketed.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined)?.host).toBe('::1')

    // non-canonical spellings reach the webserver config canonically
    const expanded = makeFakeContext()
    expect(runStartup(expanded, ['--host', 'fd00:0:0:0:0:0:0:1']).error).toBeUndefined()
    expect((expanded.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined)?.host).toBe('fd00::1')
  })

  it('enriches trustedHosts with the bind-derived LAN authorities', () => {
    const ctx = makeFakeContext()
    runStartup(ctx, ['--host', '::', '--trusted-host', 'lab.internal'])
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    // Explicit --trusted-host values in argument order, then the dual-stack
    // surface of `::`: both interface families, IPv6 bracketed canonically
    // (the form the fence's load-time authority assert demands).
    expect(values?.trustedHosts).toEqual(['lab.internal', '[fd00::1]', '[fe80::1234]', '10.0.0.5'])
  })

  it('trusts exactly the bound address for a concrete IPv4 host', () => {
    const ctx = makeFakeContext()
    expect(runStartup(ctx, ['--host', '192.168.1.5']).error).toBeUndefined()
    const values = ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined
    // The 0.2.0-line fence has no bind-address auto-trust, so the entry is
    // load-bearing there; on the 0.2.1 fence it is a harmless duplicate.
    expect(values).toEqual({ host: '192.168.1.5', trustedHosts: ['192.168.1.5'], openBrowser: true })
  })

  it('passes --public-url and --tls-cert/--tls-key through on a TLS-capable harness', () => {
    const urlCtx = makeFakeContext(tlsCapableBootRoot())
    expect(runStartup(urlCtx, ['--host', '127.0.0.1', '--public-url', 'https://app.example/ui/']).error).toBeUndefined()
    expect(urlCtx.exitCodes).toEqual([])
    expect((urlCtx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined)?.publicUrl).toBe('https://app.example/ui/')

    const tlsCtx = makeFakeContext(tlsCapableBootRoot())
    expect(runStartup(tlsCtx, ['--host', '127.0.0.1', '--tls-cert', '/tmp/chain.pem', '--tls-key', '/tmp/key.pem']).error).toBeUndefined()
    expect(tlsCtx.exitCodes).toEqual([])
    expect((tlsCtx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined)?.tls).toEqual({
      certFile: '/tmp/chain.pem',
      keyFile: '/tmp/key.pem',
    })
  })

  it('rejects a lone --tls-cert/--tls-key with the pairing error', () => {
    const ctx = makeFakeContext(tlsCapableBootRoot())
    const result = runStartup(ctx, ['--host', '127.0.0.1', '--tls-cert', '/tmp/chain.pem'])
    expect(result.error).toBeUndefined()
    expect(ctx.exitCodes).toEqual([1])
    expect(ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })

  it('rejects TLS / --public-url on a harness without those capabilities', () => {
    // The pre-0.2.1 webserver Config has no `tls` member: the probe must fail
    // the flags loudly instead of letting the rows ignore them. The incapable
    // shape is pinned by an explicit fixture — the installed package is itself
    // the 0.2.1 line, so it cannot stand in for the old harness.
    const tlsCtx = makeFakeContext(tlsIncapableBootRoot())
    runStartup(tlsCtx, ['--host', '127.0.0.1', '--tls-cert', '/tmp/chain.pem', '--tls-key', '/tmp/key.pem'])
    expect(tlsCtx.exitCodes).toEqual([1])
    expect(tlsCtx.get(WEB_STARTUP_SERVICE)).toBeUndefined()

    const urlCtx = makeFakeContext(tlsIncapableBootRoot())
    runStartup(urlCtx, ['--host', '127.0.0.1', '--public-url', 'https://app.example/'])
    expect(urlCtx.exitCodes).toEqual([1])
    expect(urlCtx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })

  it('rejects a malformed --public-url before the capability gate', () => {
    // TLS-capable harness, so exit 1 can only come from the URL validator.
    const ctx = makeFakeContext(tlsCapableBootRoot())
    runStartup(ctx, ['--host', '127.0.0.1', '--public-url', 'app.example'])
    expect(ctx.exitCodes).toEqual([1])
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

  it('replaces only the username when --username is given without --password', async () => {
    registerCredentials('admin', 'supersecret1')
    const oldCookie = sessionCookie('admin')
    const oldPayload = oldCookie.slice(0, oldCookie.indexOf('.'))
    const oldSig = oldCookie.slice(oldCookie.indexOf('.') + 1)

    await runAuthReset({ username: 'alice' })

    expect(getUsername()).toBe('alice')
    // The password is untouched
    expect(validateCredentials('alice', 'supersecret1')).toBe(true)
    // The secret rotated, so previously issued cookies are invalid
    expect(verifySession(oldPayload, oldSig)).toBe(false)
  })

  it('replaces both username and password together', async () => {
    registerCredentials('admin', 'supersecret1')
    await runAuthReset({ username: 'alice', password: 'supersecret2' })
    expect(getUsername()).toBe('alice')
    expect(validateCredentials('alice', 'supersecret2')).toBe(true)
    expect(validateCredentials('alice', 'supersecret1')).toBe(false)
  })

  it('normalizes control characters out of --username', async () => {
    registerCredentials('admin', 'supersecret1')
    await runAuthReset({ username: 'draguide\u007F' })
    expect(getUsername()).toBe('draguide')
  })

  it('rejects a username that strips to empty', async () => {
    registerCredentials('admin', 'supersecret1')
    await expect(runAuthReset({ username: '\u0001\u007F' })).rejects.toThrow('用户名不能为空')
    expect(getUsername()).toBe('admin')
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

  it('changes the username and exits 0', async () => {
    registerCredentials('admin', 'supersecret1')
    const ctx = await runAuthResetCli(['auth-reset', '--username', 'alice'])
    expect(ctx.exitCodes).toEqual([0])
    expect(getUsername()).toBe('alice')
    expect(validateCredentials('alice', 'supersecret1')).toBe(true)
  })
})
