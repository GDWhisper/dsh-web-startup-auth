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
import { randomBytes } from 'node:crypto';
/**
 * Upper bound on live records per store.
 *
 * The issuing endpoints are anonymous (the login page calls them before it
 * holds any session), so this is what keeps a caller from growing the map
 * without bound; the oldest records are evicted first. Sizing: 2048 × ~100 B
 * ≈ 200 KB worst case per store.
 */
export const MAX_CHALLENGES = 2048;
/**
 * Create an empty challenge store.
 * @returns the store instance.
 */
export function createChallengeStore() {
    // Oldest first: Map preserves insertion order.
    const records = new Map();
    const prune = (now = Date.now()) => {
        for (const [id, record] of records) {
            if (record.expiresAt <= now)
                records.delete(id);
        }
    };
    return {
        put(payload, clientKey, ttlMs) {
            prune();
            while (records.size >= MAX_CHALLENGES) {
                const oldest = records.keys().next();
                if (oldest.done === true)
                    break;
                records.delete(oldest.value);
            }
            const id = randomBytes(16).toString('hex');
            records.set(id, { payload, clientKey, expiresAt: Date.now() + ttlMs });
            return id;
        },
        take(id) {
            const record = records.get(id);
            if (record === undefined)
                return undefined;
            records.delete(id);
            return record;
        },
        peek(id) {
            return records.get(id);
        },
        prune,
        size() {
            return records.size;
        },
    };
}
