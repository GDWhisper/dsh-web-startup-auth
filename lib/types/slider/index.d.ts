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
import { type Slot } from './challenge.ts';
import { type SliderTheme } from './render.ts';
/** How long an issued puzzle stays valid. */
export declare const SLIDER_TTL_MS: number;
/** A puzzle handed to the login page. */
export interface IssuedSlider {
    /** Opaque handle to quote back with the drop offset. */
    id: string;
    /** Canvas and piece geometry, so the page never hardcodes a number. */
    width: number;
    height: number;
    pieceWidth: number;
    pieceHeight: number;
    /** Where the piece starts — deliberately not the slot's row. */
    startX: number;
    startY: number;
    /** How far off a drop may be, for the page's own feedback. */
    tolerance: number;
    /** `data:image/svg+xml;base64,…` — the scene, with the slot visible. */
    background: string;
    /** `data:image/svg+xml;base64,…` — the piece, cropped to its outline. */
    piece: string;
    /** Remaining validity, for the page's own messaging. */
    expiresInMs: number;
}
/** Why a submitted drop was rejected (audit-log detail; the caller sees one message). */
export type SliderFailure = 'missing' | 'unknown' | 'expired' | 'ip-mismatch' | 'malformed' | 'misaligned';
/** The verdict on a submitted drop. */
export type SliderVerdict = {
    ok: true;
} | {
    ok: false;
    reason: SliderFailure;
};
/**
 * Issue a fresh puzzle.
 * @param clientKey - the requesting client's socket address (`undefined` when unreadable).
 * @param theme - palette to render for.
 * @returns the handle, both images, and the geometry the page needs.
 */
export declare function issueSlider(clientKey: string | undefined, theme?: SliderTheme): IssuedSlider;
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
export declare function verifySlider(clientKey: string | undefined, id: string, answer: string): SliderVerdict;
/**
 * Read the `theme` presentation hint off a query parameter.
 * @param raw - the raw parameter value (or `null` when absent).
 * @returns the theme to render for; anything unrecognized is `light`.
 */
export declare function parseSliderTheme(raw: string | null): SliderTheme;
/** @internal export for testing (inspect and drain the store between cases). */
export declare const internals: {
    store: import("../challenge-store.ts").ChallengeStore<{
        answer: Slot;
    }>;
};
