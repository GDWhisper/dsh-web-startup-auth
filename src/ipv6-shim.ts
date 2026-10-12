/**
 * Bind-host support beyond the stock value domain: the wildcard binds
 * (`0.0.0.0`, `::`) and any concrete IPv4/IPv6 literal as `--host`.
 *
 * Upstream `@deepseek-ai/dsh-host-webserver` moved through two `Config.host`
 * shapes this module widens in place:
 *
 * - 0.2.0 line: `z.union([z.const('127.0.0.1'), z.const('0.0.0.0')])` —
 *   widening adds IPv6 literals and (matching the 0.2.1 CLI value domain)
 *   concrete IPv4 literals.
 * - 0.2.1 line: `z.transform(z.string(), …)` accepting exactly one concrete
 *   IPv4/IPv6 literal while deliberately rejecting wildcards ("binding every
 *   interface would expose remote code execution to the network") — widening
 *   restores the wildcard binds. Pairing a wildcard bind with this bundle's
 *   auth wall is the bundle's whole purpose, so the upstream rejection stays
 *   the stock default while the auth wall covers the exposure here.
 *
 * Why the union rescues a plain-`Error` rejecter: schemastery's `union`
 * catches every error a member throws (`catch (error) { messages.push(error) }`
 * in its `union` extension), so `z.union([stockMember, ourMember])` hands a
 * wildcard to our member even though the 0.2.1 transform throws a plain
 * `Error`, not `z.ValidationError`. Pinned by a test; if a future
 * schemastery copy narrows that catch, wildcard boots fail loudly (E2E).
 *
 * This is the only supported surgery: the schema object is shared by every
 * holder (the Service class static, any cordis runtime snapshot) and its
 * `dict` is a plain writable object, so replacing the single `host` member
 * keeps every other field (port, compression, tls, …) validating exactly as
 * declared. `~standard` cannot be wrapped: it is a getter on
 * `Schema.prototype`, and per-access fresh, so instance-level replacement is
 * impossible.
 *
 * **Which instance matters** (learned the hard way, see
 * `docs/agent/ipv6-bind.md`): the `webserver` row resolves the package from
 * the *profile root*, while this plugin — installed as a `link:` into the
 * profile — imports it from the *plugin repo's* node_modules. Those are two
 * module instances with two `WebServer` classes; widening the imported one
 * changes nothing at boot (validation failed with the stock union while unit
 * tests, which see the imported instance, passed). {@link bootWebServer}
 * therefore resolves the package from the profile root (the boot path's own
 * resolution) and both the widen and the `tls` capability probe
 * ({@link supportsTlsConfig}) target THAT instance, falling back to the
 * imported one only when no base URL is given (unit tests).
 *
 * The widening is opportunistic: if a future harness reshapes the schema or
 * the boot instance cannot be reached, {@link ensureIpv6BindSupport} returns
 * false and the startup plugin rejects every extended `--host` value with a
 * human message instead of letting a confusing schema error reach the user —
 * stock-host users are never affected by a failed detection.
 */

import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Package whose webserver schema the boot path validates against. */
const WEBSERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'

/** Marks a `host` schema member as already widened (idempotency per schema). */
const WIDENED = Symbol('ipv6-widened-host')

/** Install outcome; `true` is sticky (success). Failures retry on the next call. */
let ipv6Supported = false

/** Minimal structural view of a schemastery object schema. */
interface LooseObjectSchema {
  dict?: Record<string, unknown>
}

/** Minimal structural view of the webserver module's main export. */
interface LooseWebServer {
  Config?: LooseObjectSchema
}

/** A schemastery schema: a callable object carrying `dict`, `meta`, …. */
type LooseSchema = ((value: unknown) => unknown) & Record<string, unknown>

/**
 * Whether a schema member already carries the IPv6 widening.
 * @param value - candidate schema member.
 */
function isWidenedMember(value: unknown): boolean {
  if (typeof value !== 'function') return false
  return Reflect.get(value, WIDENED) === true
}

/**
 * Replace the `host` member of a schemastery object schema with a union that
 * also accepts IPv4/IPv6 literals — including the wildcards the 0.2.1 stock
 * member rejects. All other members — and every other consumer of the schema
 * — are untouched. Idempotent per schema instance.
 * @param schema - the object schema to widen, in place.
 * @returns whether the schema now accepts the extended host domain.
 */
export function widenHostMember(schema: LooseObjectSchema): boolean {
  const dict = schema.dict
  const host = dict?.host
  if (isWidenedMember(host)) return true
  if (
    dict === undefined ||
    typeof host !== 'function' ||
    typeof z.union !== 'function' ||
    typeof z.transform !== 'function' ||
    typeof z.ValidationError !== 'function'
  ) {
    return false
  }
  try {
    const widened = z.union([
      host as unknown as LooseSchema,
      // Loose on purpose: `isIPv6` also admits zone and mapped spellings.
      // The CLI (`normalizeBindHost`) is the value gate, and boot validation
      // only ever sees CLI-normalized values.
      z.transform(z.string(), (value, options) => {
        if (!isIPv4(value) && !isIPv6(value)) throw new z.ValidationError('expected an IPv4 or IPv6 literal', options)
        return value
      }),
    ]) as unknown as LooseSchema
    // Carry the member's own meta onto the new union — above all `required`:
    // a fresh union's meta is empty, and a default-less non-required member
    // lets a host-less config validate (the object resolver then drops the
    // key, and listen(port, undefined) binds ALL interfaces). The stock host
    // member is `.required()` on both eras, so the widened one must stay
    // required.
    const meta = Reflect.get(host, 'meta')
    Reflect.set(widened, 'meta', meta !== null && typeof meta === 'object' ? { ...meta } : {})
    Reflect.set(widened, WIDENED, true)
    dict.host = widened
    return true
  } catch {
    return false
  }
}

/**
 * The webserver module instance the boot path validates configs against.
 *
 * A profile root URL resolves the package exactly the way the `webserver`
 * row does (the plugin loader resolves rows from the same base), so the
 * required module is the row's instance. Without a base URL the imported
 * instance is returned — the unit-test path.
 * @param baseUrl - the cordis context's base URL (profile root at boot).
 */
function bootWebServer(baseUrl: string | undefined): LooseWebServer | undefined {
  if (baseUrl === undefined) return WebServer
  try {
    const require = createRequire(new URL('node_modules/.host-schema.cjs', baseUrl))
    const entry = require.resolve(WEBSERVER_PACKAGE)
    const loaded = require(entry) as { WebServer?: LooseWebServer }
    return loaded?.WebServer
  } catch {
    return undefined
  }
}

/**
 * Widen the boot-path webserver's `host` schema to accept wildcards and
 * IPv4/IPv6 literals. Safe to call repeatedly; never throws. Success is
 * remembered; a failure is not latched, so a later call (with a usable base
 * URL) can still widen.
 * @param baseUrl - the cordis context's base URL; omit in unit tests.
 * @returns whether an extended `--host` value will validate at boot.
 */
export function ensureIpv6BindSupport(baseUrl?: string): boolean {
  if (ipv6Supported) return true
  const target = bootWebServer(baseUrl)
  const widened = target?.Config !== undefined ? widenHostMember(target.Config) : false
  if (widened) ipv6Supported = true
  return widened
}

/**
 * Whether the boot-path webserver supports the 0.2.1-line TLS listener
 * config. TLS and `--public-url` shipped in the same upstream line, so this
 * one probe gates both: on an older harness the flags would otherwise be
 * accepted and silently ignored — a TLS flag under a plain-HTTP listener is
 * a security surprise, not a cosmetic one.
 * @param baseUrl - the cordis context's base URL; omit in unit tests.
 * @returns whether the boot-path `Config` declares a `tls` member.
 */
export function supportsTlsConfig(baseUrl?: string): boolean {
  const dict = bootWebServer(baseUrl)?.Config?.dict
  return dict !== undefined && 'tls' in dict
}

/**
 * Canonical bare IPv6 literal for `value` (WHATWG IPv6 normalization —
 * lowercase, longest-run compression), or `undefined` when the value is not
 * an IPv6 literal the WHATWG parser accepts.
 *
 * Canonicalization is load-bearing, not cosmetic: the trust fence validates
 * every `trustedHosts` entry at load (`assertTrustedAuthority` in
 * `dsh-client-connection` — each entry must survive WHATWG parsing
 * unchanged, case aside) and compares both sides through WHATWG
 * normalization. A verbatim-bracketed non-canonical spelling
 * (`[fd00:0:0:0:0:0:0:1]`, `[::ffff:1.2.3.4]`) makes the `connection` row
 * THROW at activation — the whole tree dies — instead of merely not
 * matching. Zone suffixes (`%eth0`) are rejected here: `isIPv6` accepts
 * them but WHATWG parsing throws on them.
 * @param value - candidate IPv6 literal, bare or bracketed.
 * @returns the canonical bare literal (no brackets), or `undefined`.
 */
export function canonicalIpv6(value: string): string | undefined {
  const literal = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (!isIPv6(literal)) return undefined
  try {
    return new URL(`http://[${literal}]`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

/**
 * Whether a canonical IPv6 literal is IPv4-mapped (`::ffff:a.b.c.d`,
 * `::ffff:c0a8:101`, …). Node binds such a literal as AF_INET on the mapped
 * IPv4 address, so clients arrive with a plain IPv4 `Host` that a bracketed
 * mapped-form fence entry can never match — the CLI refuses these instead.
 * @param canonical - a canonical bare IPv6 literal.
 */
function isIpv4Mapped(canonical: string): boolean {
  return canonical.startsWith('::ffff:')
}

/**
 * Normalize and validate a `--host` value.
 *
 * Accepted: the two stock wildcard/loopback IPv4 literals (`127.0.0.1`,
 * `0.0.0.0`), any concrete IPv4 literal, and any IPv6 literal the WHATWG
 * parser accepts, bracketed or bare — IPv6 returned in canonical spelling
 * (so `fd00:0:0:0:0:0:0:1` becomes `fd00::1` and `0:0:0:0:0:0:0:0` becomes
 * `::`, keeping the wildcard-bind and fence-entry invariants exact).
 * Rejected: DNS names (both stock eras bind IP literals only), zone
 * suffixes, and IPv4-mapped literals (see {@link canonicalIpv6} — a mapped
 * bind serves IPv4 peers under a plain IPv4 `Host`, which no bracketed
 * entry can match).
 * @param value - the raw `--host` argument.
 * @returns the bare canonical host the webserver should bind.
 * @throws when the value is not a supported binding host.
 */
export function normalizeBindHost(value: string): string {
  const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  if (host === '127.0.0.1' || host === '0.0.0.0') return host
  if (isIPv4(host)) return host
  const canonical = canonicalIpv6(host)
  if (canonical !== undefined && !isIpv4Mapped(canonical)) return canonical
  if (canonical !== undefined) {
    throw new Error(
      `--host 不支持 IPv4-mapped IPv6 地址（如 ::ffff:192.168.1.5）：它按 IPv4 绑定，客户端的 Host 是 IPv4 形式、围栏条目对不上；请改用等价的 IPv4 字面量（如 192.168.1.5），收到 ${JSON.stringify(value)}`,
    )
  }
  throw new Error(
    `--host 必须是 IP 字面量：127.0.0.1、0.0.0.0、具体 IPv4 地址（如 192.168.1.5）或不带 zone 的 IPv6 地址（如 :: 或 ::1），收到 ${JSON.stringify(value)}`,
  )
}

/**
 * Fence authorities the stock trust derivation cannot produce for
 * `bindHost`. `startup.ts` concatenates this into the provided
 * `webStartup.trustedHosts`, which the `connection` row consumes through
 * the official `!!js ctx.webStartup.trustedHosts` expression — the 0.2.1
 * adaptation folded the former `webLanHosts` cordis service into this path.
 *
 * The list mirrors the surface the socket actually serves, so it can never
 * be broader than the bind:
 * - `0.0.0.0`: every non-internal IPv4 interface address, plain — byte-for-
 *   byte what the 0.2.0-line `resolveLanTrust` derived for this bind
 *   (upstream deleted that derivation in 0.2.1, so this module owns it now).
 * - `::` (all-interfaces, dual-stack on Linux): every non-internal interface
 *   address — IPv6 bracketed, IPv4 plain. Both families because the
 *   dual-stack socket answers both (IPv4 clients send an IPv4 `Host`, which
 *   neither era's stock trusts for a `::` bind — verified 403 in E2E before
 *   this rule existed, issue #35).
 * - any other concrete literal: that one authority (IPv4 plain, IPv6
 *   bracketed). Needed on the 0.2.0-line fence, which trusts loopback plus
 *   `trustedHosts` only; the 0.2.1 fence also auto-trusts the listener's own
 *   bind IP (`isBindAddressAuthority`, port-ignoring), where this entry is a
 *   harmless duplicate.
 * - `127.0.0.1`, `undefined`, non-literals: `[]` — loopback needs no entry
 *   on either fence, and a non-literal never binds.
 *
 * Entries are emitted in canonical WHATWG spelling (IPv6 bracketed) — the
 * form the fence's `parseAuthority` produces and its load-time
 * `assertTrustedAuthority` demands (a non-canonical entry kills the
 * `connection` row at activation, see {@link canonicalIpv6}). Entries are
 * port-less so they match any port (`isTrustedAuthority`). Zone suffixes
 * (`%eth0`) are stripped before canonicalizing. The CLI refuses IPv4-mapped
 * binds ({@link normalizeBindHost}), so the mapped literal a direct caller
 * could still pass only yields a mapped-form entry here — canonical, so the
 * fence loads, but matching a plain-IPv4 `Host` is then the caller's
 * problem.
 * @param bindHost - the webserver's configured bind host.
 * @returns fence authorities to append; `[]` when the bind needs none.
 */
export function lanHosts(bindHost: string | undefined): string[] {
  if (bindHost === undefined) return []
  const bare = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost
  if (bare === '127.0.0.1') return []
  if (isIPv4(bare)) {
    if (bare !== '0.0.0.0') return [bare]
    return interfaceHosts(false)
  }
  const canonical = canonicalIpv6(bare.split('%')[0])
  if (canonical === undefined) return []
  if (canonical !== '::') return [`[${canonical}]`]
  return interfaceHosts(true)
}

/**
 * Non-internal interface addresses of this host, in enumeration order.
 * @param includeIpv6 - collect IPv6 addresses (bracketed canonical) too.
 */
function interfaceHosts(includeIpv6: boolean): string[] {
  try {
    const hosts: string[] = []
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const iface of interfaces ?? []) {
        if (iface.internal) continue
        if (includeIpv6) {
          const address = canonicalIpv6(iface.address.split('%')[0])
          if (address !== undefined) {
            hosts.push(`[${address}]`)
            continue
          }
        }
        if (iface.family === 'IPv4') hosts.push(iface.address)
      }
    }
    return hosts
  } catch {
    // An interface-enumeration failure must not propagate into the
    // connection row's activation (the trustedHosts list is read there):
    // shrinking the trust list is fail-closed, killing the tree is not.
    return []
  }
}
