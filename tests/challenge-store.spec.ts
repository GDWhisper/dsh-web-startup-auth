import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_CHALLENGES, createChallengeStore } from '../src/challenge-store.ts'

/**
 * The store is the piece both human-verification mechanisms stand on, so its
 * two guarantees — *exactly once* and *bounded* — are tested directly rather
 * than only through the mechanisms that use it.
 */
describe('challenge store', () => {
  let store: ReturnType<typeof createChallengeStore<{ code: string }>>

  beforeEach(() => {
    store = createChallengeStore<{ code: string }>()
  })

  it('hands a challenge out exactly once', () => {
    const id = store.put({ code: '1234' }, '192.0.2.1', 60_000)
    expect(store.take(id)?.payload.code).toBe('1234')
    expect(store.take(id)).toBeUndefined()
  })

  it('misses for an id that was never issued', () => {
    expect(store.take('deadbeef')).toBeUndefined()
  })

  it('issues an opaque 128-bit handle', () => {
    const id = store.put({ code: '1234' }, '192.0.2.1', 60_000)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('records the client and the deadline it was given', () => {
    const before = Date.now()
    const id = store.put({ code: '1234' }, '192.0.2.9', 5_000)
    const record = store.peek(id)
    expect(record?.clientKey).toBe('192.0.2.9')
    expect(record?.expiresAt).toBeGreaterThanOrEqual(before + 5_000)
    expect(record?.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000)
  })

  it('prunes only expired records', () => {
    const now = Date.now()
    store.put({ code: 'a' }, '192.0.2.1', 60_000)
    const stale = store.put({ code: 'b' }, '192.0.2.1', -1)
    expect(store.size()).toBe(2)
    store.prune(now)
    expect(store.size()).toBe(1)
    expect(store.take(stale)).toBeUndefined()
  })

  it('does not check expiry on take', () => {
    // Expiry is the caller's decision: it knows what an expired record means,
    // and a stale record is still worth consuming.
    const id = store.put({ code: 'a' }, '192.0.2.1', -1)
    expect(store.take(id)?.payload.code).toBe('a')
  })

  it('bounds the table by evicting the oldest record', () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_CHALLENGES; i += 1) {
      ids.push(store.put({ code: String(i) }, '192.0.2.1', 60_000))
    }
    expect(store.size()).toBe(MAX_CHALLENGES)
    const overflow = store.put({ code: 'last' }, '192.0.2.1', 60_000)
    expect(store.size()).toBe(MAX_CHALLENGES)
    // The first record is gone, the newest is live.
    expect(store.peek(ids[0] ?? '')).toBeUndefined()
    expect(store.peek(overflow)).toBeDefined()
  })

  it('keeps stores independent', () => {
    const other = createChallengeStore<{ code: string }>()
    const id = store.put({ code: 'a' }, '192.0.2.1', 60_000)
    expect(other.peek(id)).toBeUndefined()
  })
})
