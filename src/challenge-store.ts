/**
 * Generic one-time challenge store.
 *
 * Layer: **state**, shared by every human-verification mechanism (the image
 * captcha and the proof of work). It knows nothing about HTTP, images, or what
 * a payload means — it remembers a payload for a while, hands it back exactly
 * once, and forgets it.
 *
 * Why a store rather than a signed token: the property that matters is
 * *single use*. A stateless HMAC token stays replayable for its whole TTL, so
 * one issued challenge could be answered repeatedly — a record that is deleted
 * on first lookup cannot. There is nothing to forge either: the id is 128 bits
 * of CSPRNG output that never leaves the server except as an opaque handle, so
 * a caller cannot mint one.
 *
 * A factory rather than a module-level map: each mechanism gets its own
 * instance, so payloads stay typed (`createChallengeStore<{ code: string }>()`)
 * and one mechanism's eviction pressure cannot silently drop another's
 * outstanding challenges. Mirrors the shape of the login-failure map in
 * `src/auth.ts`: process-local, memory-only, pruned on write. A restart drops
 * outstanding challenges, which costs a solver one retry and nothing else.
 */

import { randomBytes } from 'node:crypto'

/** One outstanding challenge. */
export interface ChallengeRecord<T> {
  /** What the verifier needs in order to decide. */
  payload: T
  /**
   * The client the challenge was issued to (its socket address). `undefined`
   * when the peer address could not be read: it is treated as its own key, so
   * such a challenge only matches another address-less caller.
   */
  clientKey: string | undefined
  /** Epoch milliseconds after which the record is dead. */
  expiresAt: number
}

/** A bounded, one-time challenge table. */
export interface ChallengeStore<T> {
  /**
   * Remember a payload and return the handle the client must quote back.
   * @param payload - what the verifier will need later.
   * @param clientKey - the issuing client's socket address.
   * @param ttlMs - how long the record stays live.
   * @returns the opaque id (128 bits of hex).
   */
  put(payload: T, clientKey: string | undefined, ttlMs: number): string
  /**
   * Look a challenge up **and consume it**.
   *
   * Consumption is unconditional and happens before any verdict is formed, so
   * a wrong answer costs the caller that challenge and they must fetch a new
   * one — which is what makes replay impossible. Expiry is *not* checked here:
   * the caller decides what an expired record means, and a stale record is
   * still worth consuming.
   * @param id - the handle from the issue step.
   * @returns the record, or `undefined` when the id was never issued or was
   * already consumed.
   */
  take(id: string): ChallengeRecord<T> | undefined
  /**
   * Read a record **without** consuming it.
   *
   * Test-only: a verifier must never use this (looking without taking would
   * break single use), but a test cannot otherwise learn what it just issued.
   * @param id - the handle from the issue step.
   * @returns the record, or `undefined` when it is not live.
   */
  peek(id: string): ChallengeRecord<T> | undefined
  /**
   * Drop every expired record.
   * @param now - the clock to compare against (injectable for tests).
   */
  prune(now?: number): void
  /** How many records are currently live. */
  size(): number
}

/**
 * Upper bound on live records per store.
 *
 * The issuing endpoints are anonymous (the login page calls them before it
 * holds any session), so this is what keeps a caller from growing the map
 * without bound; the oldest records are evicted first. Sizing: 2048 × ~100 B
 * ≈ 200 KB worst case per store.
 */
export const MAX_CHALLENGES = 2048

/**
 * Create an empty challenge store.
 * @returns the store instance.
 */
export function createChallengeStore<T>(): ChallengeStore<T> {
  // Oldest first: Map preserves insertion order.
  const records = new Map<string, ChallengeRecord<T>>()

  const prune = (now = Date.now()): void => {
    for (const [id, record] of records) {
      if (record.expiresAt <= now) records.delete(id)
    }
  }

  return {
    put(payload, clientKey, ttlMs) {
      prune()
      while (records.size >= MAX_CHALLENGES) {
        const oldest = records.keys().next()
        if (oldest.done === true) break
        records.delete(oldest.value)
      }
      const id = randomBytes(16).toString('hex')
      records.set(id, { payload, clientKey, expiresAt: Date.now() + ttlMs })
      return id
    },
    take(id) {
      const record = records.get(id)
      if (record === undefined) return undefined
      records.delete(id)
      return record
    },
    peek(id) {
      return records.get(id)
    },
    prune,
    size() {
      return records.size
    },
  }
}
