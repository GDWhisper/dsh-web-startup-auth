/**
 * IPv6 bind support (issue #35): `--host ::` / `::1` / any IPv6 literal.
 *
 * Upstream `@deepseek-ai/dsh-host-webserver` restricts its `host` config to
 * the two IPv4 literals `127.0.0.1` and `0.0.0.0` (a `z.union` of `z.const`
 * members), and the web-app bundle feeds our `--host` string straight into
 * that schema. On a pure-IPv6 network, `0.0.0.0` binds AF_INET only and the
 * GUI is unreachable, while Node itself binds `::` fine (dual-stack on Linux
 * with `bindv6only=0`, covering IPv4-mapped peers as well).
 *
 * This module widens the stock webserver's `host` schema member in place —
 * the only supported surgery: the schema object is shared by every holder
 * (the Service class static, any cordis runtime snapshot), and its `dict`
 * is a plain writable object, so replacing the single `host` member keeps
 * every other field (port, compression, …) validating exactly as declared.
 * `~standard` cannot be wrapped: it is a getter on `Schema.prototype`, and
 * per-access fresh, so instance-level replacement is impossible.
 *
 * **Which instance matters** (learned the hard way, see
 * `docs/agent/ipv6-bind.md`): the `webserver` row resolves the package from
 * the *profile root*, while this plugin — installed as a `link:` into the
 * profile — imports it from the *plugin repo's* node_modules. Those are two
 * module instances with two `WebServer` classes; widening the imported one
 * changes nothing at boot (validation failed with the stock union while
 * unit tests, which see the imported instance, passed). `ensureIpv6BindSupport`
 * therefore resolves the package from the profile root (the boot path's own
 * resolution) and widens THAT instance, falling back to the imported one only
 * when no base URL is given (unit tests).
 *
 * The widening is opportunistic: if a future harness reshapes the schema or
 * the boot instance cannot be reached, the function returns false and the
 * startup plugin rejects an IPv6 `--host` with a human message instead of
 * letting a confusing schema error reach the user — non-IPv6 users are never
 * affected by a failed detection.
 */

import { isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** Service name for {@link lanHosts}, consumed by our cordis patch. */
export const LAN_HOSTS_SERVICE = 'webLanHosts'

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
 * also accepts IPv6 literals. All other members — and every other consumer of
 * the schema — are untouched. Idempotent per schema instance.
 * @param schema - the object schema to widen, in place.
 * @returns whether the schema now accepts IPv6 literals.
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
      z.transform(z.string(), (value, options) => {
        if (!isIPv6(value)) throw new z.ValidationError('expected an IPv6 literal', options)
        return value
      }),
    ]) as unknown as LooseSchema
    // Carry the member's own meta onto the new union — above all `required`:
    // a fresh union's meta is empty, and a default-less non-required member
    // lets a host-less config validate (the object resolver then drops the
    // key, and listen(port, undefined) binds ALL interfaces). The stock host
    // member is `.required()`, so the widened one must stay required.
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
 * Widen the boot-path webserver's `host` schema to accept IPv6 literals.
 * Safe to call repeatedly; never throws. Success is remembered; a failure is
 * not latched, so a later call (with a usable base URL) can still widen.
 * @param baseUrl - the cordis context's base URL; omit in unit tests.
 * @returns whether an IPv6 `--host` will validate at boot.
 */
export function ensureIpv6BindSupport(baseUrl?: string): boolean {
  if (ipv6Supported) return true
  const target = bootWebServer(baseUrl)
  const widened = target?.Config !== undefined ? widenHostMember(target.Config) : false
  if (widened) ipv6Supported = true
  return widened
}

/**
 * Whether `value` is an IPv6 literal (`::`, `::1`, `fd00::1`, …, optionally
 * bracketed as `[::1]`, the form browsers and documentation use).
 * @param value - candidate host.
 */
export function isIpv6Host(value: string): boolean {
  const literal = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return isIPv6(literal)
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
 * Accepted: the two stock IPv4 literals (`127.0.0.1`, `0.0.0.0`) and any
 * IPv6 literal the WHATWG parser accepts, bracketed or bare — returned in
 * canonical spelling (so `fd00:0:0:0:0:0:0:1` becomes `fd00::1` and
 * `0:0:0:0:0:0:0:0` becomes `::`, keeping the wildcard-bind and fence-entry
 * invariants exact). Rejected: DNS names (stock value domain), zone
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
  const canonical = canonicalIpv6(host)
  if (canonical !== undefined && !isIpv4Mapped(canonical)) return canonical
  if (canonical !== undefined) {
    throw new Error(
      `--host 不支持 IPv4-mapped IPv6 地址（如 ::ffff:192.168.1.5）：它按 IPv4 绑定，客户端的 Host 是 IPv4 形式、围栏条目对不上；请改用 --host 0.0.0.0，收到 ${JSON.stringify(value)}`,
    )
  }
  throw new Error(
    `--host 必须是 127.0.0.1、0.0.0.0 或不带 zone 的 IPv6 地址（如 :: 或 ::1），收到 ${JSON.stringify(value)}`,
  )
}

/**
 * LAN authorities the trust fence needs but the stock derivation cannot
 * produce. Stock `resolveLanTrust` (dsh-web-app) enumerates non-internal
 * **IPv4** interface addresses, and only for the `0.0.0.0` bind — so an IPv6
 * bind gets nothing, and a browser-trust-fence request (`connection` 403s any
 * non-loopback `Host` not listed) never reaches the login page.
 *
 * The list mirrors the surface the socket actually serves, so it can never be
 * broader than the bind:
 * - `::` (all-interfaces, dual-stack on Linux): every non-internal interface
 *   address — IPv6 bracketed, IPv4 plain. Both families because the dual-stack
 *   socket answers both (IPv4 clients send an IPv4 `Host`, which stock never
 *   derives for a `::` bind — verified 403 in E2E before this rule existed).
 * - any other IPv6 literal (`::1`, `fd00::5`): that one bracketed address.
 * - non-IPv6 binds: `[]` — stock already derives the IPv4 LAN authorities for
 *   `0.0.0.0`, and loopback binds serve nothing remote.
 *
 * Entries are emitted in canonical WHATWG spelling and bracketed — the form
 * the fence's `parseAuthority` produces, and the form its load-time
 * `assertTrustedAuthority` demands (a non-canonical entry kills the
 * `connection` row at activation, see {@link canonicalIpv6}). Entries are
 * port-less so they match any port (`isTrustedAuthority`). Zone suffixes
 * (`%eth0`) are stripped before canonicalizing. The CLI refuses IPv4-mapped
 * binds ({@link normalizeBindHost}), so the mapped literal a direct caller
 * could still pass only yields a mapped-form entry here — canonical, so the
 * fence loads, but matching a plain-IPv4 `Host` is then the caller's
 * problem.
 * @param bindHost - the webserver's configured bind host.
 * @returns fence authorities to append; `[]` when stock already covers the bind.
 */
export function lanHosts(bindHost: string | undefined): string[] {
  if (bindHost === undefined) return []
  const bare = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost
  const canonical = canonicalIpv6(bare.split('%')[0])
  if (canonical === undefined) return []
  if (canonical !== '::') return [`[${canonical}]`]
  try {
    const hosts: string[] = []
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const iface of interfaces ?? []) {
        if (iface.internal) continue
        const address = canonicalIpv6(iface.address.split('%')[0])
        if (address !== undefined) hosts.push(`[${address}]`)
        else if (iface.family === 'IPv4') hosts.push(iface.address)
      }
    }
    return hosts
  } catch {
    // An interface-enumeration failure must not propagate into the
    // connection row's activation (the expression spreads this list):
    // shrinking the trust list is fail-closed, killing the tree is not.
    return []
  }
}
