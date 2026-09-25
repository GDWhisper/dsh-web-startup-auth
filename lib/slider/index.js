/**
 * Slider-puzzle orchestration.
 *
 * Layer: **orchestration** (top of the slider module). `src/auth.ts` imports
 * this module and nothing else from `src/slider/`. Below it sit `challenge.ts`
 * (domain) and `render.ts` (presentation).
 *
 * ## What this is, honestly
 *
 * It is a **decorative** bot check. The answer — where the slot sits — is
 * visible in the picture by construction, because a human has to see where to
 * drag. Measured 2026-09-24 on this implementation's prototype: a ~30-line
 * script recovers the slot from the rendered image 100% of the time, by
 * luminance, by edge detection, or (against a noise-hardened variant) by local
 * variance. No amount of rendering trickery changes that: anything a person
 * can solve by looking can be read by code.
 *
 * It is kept because it was explicitly asked for as a curiosity, and because
 * it is still a small speed bump for the dumbest traffic. It is **not** a
 * security boundary, and the login limiter in `src/auth.ts` is what actually
 * bounds a brute force. See `docs/agent/human-verification.md` for the
 * measurements and for what would actually raise the bar.
 *
 * ## Lifecycle
 *
 * Single-use, bound to the client address, short-lived — the same rules the
 * other mechanisms followed, because they are what stop a solved puzzle from
 * being replayed:
 *
 * 1. `issue` stores the slot (its anchor and silhouette) and returns the two
 *    images plus the geometry the page needs to place the piece — the
 *    silhouette is part of the drawing, never part of the wire format.
 * 2. The page drags the piece; on submit it reports the piece's left offset.
 * 3. `verify` takes the record (consuming it either way) and compares the
 *    offset to the slot within `TOLERANCE`.
 */
import { randomBytes } from 'node:crypto';
import { createChallengeStore } from "../challenge-store.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH, START_X, START_Y, TOLERANCE, isWithinTolerance, outlineSize, parseDrop, pickAnswer, } from "./challenge.js";
import { renderPuzzle } from "./render.js";
/** How long an issued puzzle stays valid. */
export const SLIDER_TTL_MS = 5 * 60_000;
/** Live puzzles, keyed by the opaque handle. */
const store = createChallengeStore();
/** Encode an SVG document as an inline data URI. */
function dataUri(svg) {
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
/**
 * Issue a fresh puzzle.
 * @param clientKey - the requesting client's socket address (`undefined` when unreadable).
 * @param theme - palette to render for.
 * @returns the handle, both images, and the geometry the page needs.
 */
export function issueSlider(clientKey, theme = 'light') {
    const slot = pickAnswer();
    // The seed and the slot both come from the same draw, so a challenge cannot
    // be recognised (and its slot pre-computed) from a repeated picture.
    const seed = randomBytes(4).readUInt32BE(0);
    const id = store.put({ answer: slot }, clientKey, SLIDER_TTL_MS);
    const rendered = renderPuzzle(seed, slot, theme);
    const size = outlineSize(slot.tab);
    return {
        id,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        pieceWidth: size.w,
        pieceHeight: size.h,
        startX: START_X,
        startY: START_Y,
        tolerance: TOLERANCE,
        background: dataUri(rendered.background),
        piece: dataUri(rendered.piece),
        expiresInMs: SLIDER_TTL_MS,
    };
}
/**
 * Check a submitted drop and consume the puzzle.
 *
 * Consumed on **every** attempt, right or wrong, so a caller cannot grind one
 * puzzle: each try costs a fresh one *and* one of the login limiter's
 * attempts. That combination — not the puzzle's difficulty — is what keeps
 * blind guessing from paying off.
 * @param clientKey - the submitting client's socket address.
 * @param id - the handle from the issue step.
 * @param answer - the reported piece offset, as sent.
 * @returns `ok`, or the failure reason.
 */
export function verifySlider(clientKey, id, answer) {
    if (id === '' || answer === '')
        return { ok: false, reason: 'missing' };
    const record = store.take(id);
    if (record === undefined)
        return { ok: false, reason: 'unknown' };
    if (record.expiresAt <= Date.now())
        return { ok: false, reason: 'expired' };
    // Same binding as every other mechanism, with the same reverse-proxy caveat
    // (see `clientIp` in src/auth.ts).
    if (record.clientKey !== clientKey)
        return { ok: false, reason: 'ip-mismatch' };
    const submitted = parseDrop(answer);
    if (submitted === undefined)
        return { ok: false, reason: 'malformed' };
    if (!isWithinTolerance(record.payload.answer, submitted))
        return { ok: false, reason: 'misaligned' };
    return { ok: true };
}
/**
 * Read the `theme` presentation hint off a query parameter.
 * @param raw - the raw parameter value (or `null` when absent).
 * @returns the theme to render for; anything unrecognized is `light`.
 */
export function parseSliderTheme(raw) {
    return raw === 'dark' ? 'dark' : 'light';
}
/** @internal export for testing (inspect and drain the store between cases). */
export const internals = { store };
