import { describe, expect, it, vi, beforeAll } from 'vitest'
import { isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
  canonicalIpv6,
  ensureIpv6BindSupport,
  isIpv6Host,
  lanHosts,
  normalizeBindHost,
  widenHostMember,
} from '../src/ipv6-shim.ts'

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(() => ({
    eth0: [
      { address: 'fd00::1', family: 'IPv6', internal: false },
      { address: 'fe80::1234%eth0', family: 'IPv6', internal: false },
      { address: '10.0.0.5', family: 'IPv4', internal: false },
    ],
    lo: [{ address: '::1', family: 'IPv6', internal: true }],
  })),
}))

/** A webserver-config-shaped schema independent of the imported package. */
function stockLikeSchema() {
  return z.object({
    host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
    port: z.natural().max(65535).required(),
    compression: z.union([z.const('none'), z.const('gzip')]).default('none'),
  })
}

/** Validate a config the way cordis does at fiber start. */
function validate(schema: unknown, config: Record<string, unknown>) {
  return (schema as { '~standard': { validate: (value: unknown) => { issues?: unknown[]; value: Record<string, unknown> } } })['~standard'].validate(config)
}

beforeAll(() => {
  expect(ensureIpv6BindSupport()).toBe(true)
})

describe('widenHostMember', () => {
  it('accepts IPv6 literals while keeping the stock members and other fields', () => {
    const schema = stockLikeSchema()
    expect(widenHostMember(schema)).toBe(true)
    for (const host of ['127.0.0.1', '0.0.0.0', '::', '::1', 'fd00::1']) {
      const result = validate(schema, { host, port: 3000 })
      expect(result.issues, `${host} should validate`).toBeUndefined()
      expect(result.value.host).toBe(host)
    }
    expect(validate(schema, { host: 'example.com', port: 3000 }).issues).toBeDefined()
    expect(validate(schema, { host: '::', port: 'abc' }).issues).toBeDefined()
    // the untouched member keeps its default
    expect(validate(schema, { host: '::', port: 3000 }).value.compression).toBe('none')
  })

  it('keeps the host member required after widening', () => {
    const schema = stockLikeSchema()
    expect(widenHostMember(schema)).toBe(true)
    // a default-less non-required member would let a host-less config
    // validate and bind all interfaces — the stock member is `.required()`
    const result = validate(schema, { port: 3000 })
    expect(result.issues).toBeDefined()
  })

  it('is idempotent per schema instance', () => {
    const schema = stockLikeSchema()
    expect(widenHostMember(schema)).toBe(true)
    expect(widenHostMember(schema)).toBe(true)
    expect(validate(schema, { host: 'fd00::1', port: 3000 }).issues).toBeUndefined()
  })

  it('leaves unrelated schemas alone and reports failure on a foreign shape', () => {
    expect(widenHostMember({})).toBe(false)
    expect(widenHostMember({ dict: { port: z.natural() } })).toBe(false)
  })
})

describe('ensureIpv6BindSupport', () => {
  // dynamic import after `vi.resetModules()`: exercising the module-state
  // boundary (the install flag is process-wide, tests need a fresh one)
  it('reports false when the boot-path instance cannot be resolved', async () => {
    vi.resetModules()
    const fresh = await import('../src/ipv6-shim.ts')
    expect(fresh.ensureIpv6BindSupport('file:///nonexistent-profile-root/')).toBe(false)
  })

  // dynamic import for the same reason: a fresh install flag so the
  // first-attempt semantics are observable
  it('widens the imported instance when no boot base is given', async () => {
    vi.resetModules()
    const fresh = await import('../src/ipv6-shim.ts')
    expect(fresh.ensureIpv6BindSupport()).toBe(true)
    expect(validate(WebServer.Config, { host: '::', port: 3000 }).issues).toBeUndefined()
    expect(validate(WebServer.Config, { host: 'example.com', port: 3000 }).issues).toBeDefined()
    // widening must not drop the stock member's `required`
    expect(validate(WebServer.Config, { port: 3000 }).issues).toBeDefined()
  })

  it('is process-idempotent after the first success', () => {
    expect(ensureIpv6BindSupport()).toBe(true)
    expect(ensureIpv6BindSupport('file:///nonexistent-profile-root/')).toBe(true)
  })
})

describe('canonicalIpv6', () => {
  it('returns the WHATWG-canonical bare literal', () => {
    expect(canonicalIpv6('fd00:0:0:0:0:0:0:1')).toBe('fd00::1')
    expect(canonicalIpv6('FD00::1')).toBe('fd00::1')
    expect(canonicalIpv6('[::1]')).toBe('::1')
    expect(canonicalIpv6('0:0:0:0:0:0:0:0')).toBe('::')
  })

  it('refuses what the WHATWG parser refuses (zones, DNS names, garbage)', () => {
    expect(canonicalIpv6('fe80::1%eth0')).toBeUndefined()
    expect(canonicalIpv6('example.com')).toBeUndefined()
    expect(canonicalIpv6('::g')).toBeUndefined()
    expect(canonicalIpv6('')).toBeUndefined()
  })
})

describe('normalizeBindHost', () => {
  it('passes the stock literals through', () => {
    expect(normalizeBindHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeBindHost('0.0.0.0')).toBe('0.0.0.0')
  })

  it('accepts IPv6 literals, strips the URL bracket form, and canonicalizes', () => {
    expect(normalizeBindHost('::')).toBe('::')
    expect(normalizeBindHost('::1')).toBe('::1')
    expect(normalizeBindHost('[::1]')).toBe('::1')
    expect(normalizeBindHost('fd00::1')).toBe('fd00::1')
    // canonical spelling is load-bearing: the fence's load-time entry assert
    // and wildcard-bind detection (`::`) both compare canonical forms
    expect(normalizeBindHost('FD00::1')).toBe('fd00::1')
    expect(normalizeBindHost('fd00:0:0:0:0:0:0:1')).toBe('fd00::1')
    expect(normalizeBindHost('0:0:0:0:0:0:0:0')).toBe('::')
  })

  it('rejects DNS names, malformed literals, and zone suffixes', () => {
    for (const value of ['example.com', 'localhost', '::g', '12345::', 'fd00::1::2', '0.0.0.256', '999.1.1.1', '', 'fe80::1%eth0']) {
      expect(() => normalizeBindHost(value), value).toThrow('IPv6')
    }
  })

  it('rejects IPv4-mapped literals (their clients arrive under a plain IPv4 Host)', () => {
    for (const value of ['::ffff:1.2.3.4', '::ffff:c0a8:101', '[::ffff:192.168.1.5]']) {
      expect(() => normalizeBindHost(value), value).toThrow('IPv4-mapped')
    }
  })
})

describe('isIpv6Host', () => {
  it('treats bracketed literals as IPv6', () => {
    expect(isIpv6Host('::')).toBe(true)
    expect(isIpv6Host('[fd00::1]')).toBe(true)
    expect(isIpv6Host('0.0.0.0')).toBe(false)
    expect(isIpv6Host('example.com')).toBe(false)
  })
})

/** The fence's load-time entry rule: survive WHATWG parsing unchanged (case aside). */
function expectFenceCanonical(entries: string[]) {
  for (const entry of entries) {
    expect(new URL(`http://${entry}`).hostname, entry).toBe(entry.toLowerCase())
  }
}

describe('lanHosts', () => {
  it('returns nothing for non-IPv6 binds, whatever the interfaces', () => {
    expect(lanHosts(undefined)).toEqual([])
    expect(lanHosts('127.0.0.1')).toEqual([])
    expect(lanHosts('0.0.0.0')).toEqual([])
    expect(lanHosts('example.com')).toEqual([])
    expect(lanHosts('::g')).toEqual([])
  })

  it('trusts both interface families on the dual-stack wildcard bind', () => {
    const hosts = lanHosts('::')
    expect(hosts).toEqual(['[fd00::1]', '[fe80::1234]', '10.0.0.5'])
    expectFenceCanonical(hosts)
  })

  it('treats the expanded spelling of the wildcard as the wildcard', () => {
    expect(lanHosts('0:0:0:0:0:0:0:0')).toEqual(lanHosts('::'))
    expect(lanHosts('[0:0:0:0:0:0:0:0]')).toEqual(lanHosts('::'))
  })

  it('trusts exactly the bound address for a specific IPv6 bind, canonically', () => {
    expect(lanHosts('fd00::5')).toEqual(['[fd00::5]'])
    expect(lanHosts('::1')).toEqual(['[::1]'])
    // non-canonical spellings must come out canonical: a verbatim-bracketed
    // entry makes the connection row throw at activation
    expect(lanHosts('fd00:0:0:0:0:0:0:1')).toEqual(['[fd00::1]'])
    expect(lanHosts('FD00::5')).toEqual(['[fd00::5]'])
    // zone suffixes are stripped like on interface addresses
    expect(lanHosts('fe80::1%eth0')).toEqual(['[fe80::1]'])
    expectFenceCanonical([...lanHosts('fd00:0:0:0:0:0:0:1'), ...lanHosts('fe80::1%eth0')])
  })

  it('never propagates an interface-enumeration failure into the fence config', () => {
    vi.mocked(networkInterfaces).mockImplementationOnce(() => {
      throw new Error('enumeration boom')
    })
    expect(lanHosts('::')).toEqual([])
  })
})
