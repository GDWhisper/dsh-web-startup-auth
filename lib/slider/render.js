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
import { CANVAS_HEIGHT, CANVAS_WIDTH, bodyAnchor, outlineSize, piecePath, pickDecoy, } from "./challenge.js";
const PALETTES = {
    light: {
        from: '#dce6f7',
        to: '#a9bcdd',
        blobs: ['#4d6bfe', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#2d9cdb'],
        speck: '#1f2937',
        slotFill: 'rgba(17, 24, 39, 0.45)',
        pieceStroke: 'rgba(255, 255, 255, 0.85)',
    },
    // Mid-tone on purpose, not near-black: the slot is a *darkened* cut-out, so
    // on a very dark picture neither the slot nor the piece waiting at the left
    // edge is visible (caught by looking at the dark rendering, 2026-09-24). A
    // puzzle that fits the dark UI perfectly is a puzzle nobody can solve.
    dark: {
        from: '#42557d',
        to: '#243350',
        blobs: ['#7f97ff', '#eda05a', '#3fb573', '#e26d64', '#a97cf8', '#4fb0e8'],
        speck: '#eef1f6',
        slotFill: 'rgba(0, 0, 0, 0.5)',
        pieceStroke: 'rgba(255, 255, 255, 0.85)',
    },
};
/**
 * A small deterministic PRNG (LCG).
 *
 * Seeded from the challenge so the background and the piece are cut from the
 * *same* picture, and so a test can reproduce a rendering exactly.
 */
function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
/** One decimal is plenty at this size and keeps the markup small. */
function r1(value) {
    return String(Math.round(value * 10) / 10);
}
/**
 * Build the shared texture.
 *
 * Random blobs, streaks and specks give the picture enough local detail for a
 * human to judge alignment — a flat gradient would make the puzzle unsolvable
 * even for the person it is meant for.
 * @param random - the seeded source.
 * @param palette - colours to draw with.
 * @returns SVG markup for the texture, in canvas coordinates.
 */
function textureMarkup(random, palette) {
    const parts = [];
    for (let i = 0; i < 7; i += 1) {
        const colour = palette.blobs[Math.floor(random() * palette.blobs.length)] ?? palette.blobs[0];
        parts.push(`<circle cx="${r1(random() * CANVAS_WIDTH)}" cy="${r1(random() * CANVAS_HEIGHT)}"` +
            ` r="${r1(24 + random() * 46)}" fill="${colour}" opacity="0.32"/>`);
    }
    for (let i = 0; i < 14; i += 1) {
        const x = random() * CANVAS_WIDTH;
        const y = random() * CANVAS_HEIGHT;
        const length = 30 + random() * 90;
        const angle = random() * 180;
        parts.push(`<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + length)}" y2="${r1(y)}"` +
            ` stroke="${palette.speck}" stroke-width="${r1(2 + random() * 6)}" opacity="0.18"` +
            ` transform="rotate(${r1(angle)} ${r1(x)} ${r1(y)})"/>`);
    }
    for (let i = 0; i < 80; i += 1) {
        parts.push(`<circle cx="${r1(random() * CANVAS_WIDTH)}" cy="${r1(random() * CANVAS_HEIGHT)}"` +
            ` r="${r1(0.5 + random() * 1.4)}" fill="${palette.speck}" opacity="0.3"/>`);
    }
    return parts.join('');
}
/** The gradient both documents share (ids are scoped per document). */
function gradientDefs(palette) {
    return (`<defs><linearGradient id="dsh-slider-bg" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/>` +
        `</linearGradient></defs>`);
}
/** The full-canvas base fill. */
function baseMarkup() {
    return `<rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="url(#dsh-slider-bg)"/>`;
}
/**
 * Render a puzzle.
 * @param seed - seeds the shared texture and the decoy (pass something derived
 * from the challenge).
 * @param slot - where the hole sits and which silhouette it wears.
 * @param theme - palette to draw with.
 * @returns the two SVG documents, plus the decoy for tests.
 */
export function renderPuzzle(seed, slot, theme = 'light') {
    const palette = PALETTES[theme];
    // One stream, consumed in order: texture first, then the decoy. Same seed,
    // same picture, same decoy — every time.
    const random = makeRandom(seed);
    const texture = textureMarkup(random, palette);
    const decoy = pickDecoy(slot, random);
    const body = bodyAnchor(slot);
    const path = piecePath(body.x, body.y, slot.tab);
    const size = outlineSize(slot.tab);
    const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"` +
        ` viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" role="img" aria-label="slider puzzle">` +
        gradientDefs(palette) +
        baseMarkup() +
        texture +
        // The decoy goes down first so the real slot always paints last (on top):
        // same fill-only silhouette treatment, no outline, for the same reason.
        `<path d="${piecePath(decoy.x, decoy.y, decoy.tab)}" fill="${palette.slotFill}"/>` +
        // The cut-out: the whole point of the puzzle is that a human can see it.
        // Fill only, no outline — an outlined slot reads as a drawn box rather than
        // a hole, and the outline doubles as a machine-readable edge to lock onto.
        `<path d="${path}" fill="${palette.slotFill}"/>` +
        `</svg>`;
    const piece = 
    // The viewBox is the outline's bounding box, in canvas coordinates — so
    // the element's top-left in page coordinates *is* the drop offset, for
    // every silhouette (a left/top tab pushes the body inward, never the box).
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}"` +
        ` viewBox="${slot.x} ${slot.y} ${size.w} ${size.h}">` +
        gradientDefs(palette) +
        `<defs><clipPath id="dsh-slider-piece"><path d="${path}"/></clipPath></defs>` +
        // *Everything* is clipped, base fill included. Clipping only the texture
        // leaves the base painting the rest of the box, so the piece arrives as an
        // opaque rectangle with the outline floating inside it (caught by looking
        // at the rendering, 2026-09-24).
        `<g clip-path="url(#dsh-slider-piece)">` +
        baseMarkup() +
        texture +
        // Clipped too, so only the inner half of the outline shows and the piece
        // reads as a cut edge rather than a sticker.
        `<path d="${path}" fill="none" stroke="${palette.pieceStroke}" stroke-width="2"/>` +
        `</g>` +
        `</svg>`;
    return { background, piece, decoy };
}
