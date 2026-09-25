/**
 * Slider-puzzle rendering — pure, no I/O.
 *
 * Layer: **presentation**. Takes a seed and the slot (its anchor and
 * silhouette) and returns two SVG documents: the background (with the slot
 * drawn as a dark cut-out) and the piece (cut from the same texture, cropped
 * to its own outline).
 *
 * Both are generated from one seeded texture, which is the whole trick: the
 * piece carries the pixels that belong in the slot, so a correct drop lines
 * the image up and a wrong one does not. That also means the slot is visible
 * in the background by construction — a human has to see where to drag — and
 * therefore readable by a script. See the module note in `challenge.ts`.
 *
 * The background carries **one decoy** alongside the real slot: a second
 * darkened hole whose silhouette differs (its tab bulges out of another edge,
 * or it has no tab), placed clear of both the slot and the piece's starting
 * corner. It is the picture's joke — the piece only fits one of the holes —
 * and it costs a script one extra silhouette match, nothing more. The decoy
 * follows the slot's rendering rule: fill only, no outline.
 *
 * Two documents rather than one because the page drags the piece with CSS:
 * the piece is a separate `<img>` positioned over the background, which keeps
 * the drag logic to one percentage and works at any display scale.
 */
import { type Decoy, type Slot } from './challenge.ts';
/** Which plate/ink pair to draw for. */
export type SliderTheme = 'light' | 'dark';
/** A rendered puzzle: two self-contained SVG documents. */
export interface RenderedPuzzle {
    /** The scene, with the slot and one decoy cut into it. */
    background: string;
    /** The piece, cropped to its outline, showing the content of the slot. */
    piece: string;
    /** The decoy drawn into the background (for tests; never sent to a client). */
    decoy: Decoy;
}
/**
 * Render a puzzle.
 * @param seed - seeds the shared texture and the decoy (pass something derived
 * from the challenge).
 * @param slot - where the hole sits and which silhouette it wears.
 * @param theme - palette to draw with.
 * @returns the two SVG documents, plus the decoy for tests.
 */
export declare function renderPuzzle(seed: number, slot: Slot, theme?: SliderTheme): RenderedPuzzle;
