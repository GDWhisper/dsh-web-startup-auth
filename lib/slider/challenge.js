/**
 * Slider-puzzle domain logic — pure, no I/O, no HTTP.
 *
 * Layer: **domain** (bottom). Owns the puzzle's geometry: how big the canvas
 * and the piece are, where the piece may be dropped, what the piece outline
 * looks like, and whether a submitted drop lines up with the slot.
 *
 * The answer is where the slot sits — a point on the canvas plus one of five
 * silhouettes ({@link TabSide}) the hole and its piece are drawn with, redrawn
 * from scratch for every challenge. Only the point travels on the wire; the
 * shape is *visible in the picture* — that is what makes the puzzle solvable
 * by a human at all. Nothing here pretends otherwise: a script that reads the
 * image can read the answer, which is exactly why this mechanism is documented
 * as decorative rather than as a security boundary
 * (`docs/agent/human-verification.md`). What the design *does* bound is
 * blind guessing: one single-use challenge per attempt, a ±{@link TOLERANCE}
 * window on **both** axes, and the login rate limiter on top.
 */
/** Canvas the puzzle is drawn on, in user units (the page scales it to fit). */
export const CANVAS_WIDTH = 300;
export const CANVAS_HEIGHT = 150;
/** Side of the square piece body. */
export const PIECE_SIZE = 44;
/** Radius of the tab bulging out of one edge of the piece body. */
export const TAB_RADIUS = 14;
/**
 * The piece's largest extent: body plus tab.
 *
 * Horizontal tabs make this the width, vertical tabs the height — see
 * {@link outlineSize}.
 */
export const PIECE_WIDTH = PIECE_SIZE + TAB_RADIUS;
/** Leftmost slot offset. Keeps the slot clear of the piece's own start. */
export const MIN_ANSWER_X = 96;
/** Rightmost slot offset, leaving a small margin from the canvas edge. */
export const MAX_ANSWER_X = CANVAS_WIDTH - PIECE_WIDTH - 8;
/**
 * Vertical range the slot's bounding box may occupy.
 *
 * The top end leaves the usual canvas margin for the tallest outline (body
 * plus a top/bottom tab, {@link PIECE_WIDTH} tall). The bottom end
 * deliberately stops short of {@link START_Y} by more than {@link TOLERANCE}:
 * the piece must never begin within a drop of the slot's row, or the puzzle
 * would collapse back into a one-dimensional slide and the vertical work
 * would be free.
 */
export const MIN_ANSWER_Y = 6;
export const MAX_ANSWER_Y = CANVAS_HEIGHT - PIECE_WIDTH - 8;
/**
 * Where the piece starts: the top-left corner of its outline.
 *
 * A row below {@link MAX_ANSWER_Y} on purpose — see above — and low enough
 * that even the tall (top/bottom-tab) outline fits inside the canvas.
 */
export const START_X = 0;
export const START_Y = 90;
/**
 * How far off a drop may be and still count, in user units.
 *
 * The window is deliberately small: at ±4 a blind guess covers 9 of the ~139
 * possible offsets (~6%), which the single-use rule and the rate limiter turn
 * into a non-starter. Widening it to be "friendlier" would trade the only
 * property this mechanism actually has.
 */
export const TOLERANCE = 4;
/**
 * Pick the slot's position and silhouette.
 *
 * Unpredictability matters even for a decorative check: a slot an attacker
 * could have guessed is one they need not look at the picture for. The
 * silhouette is drawn uniformly from {@link ALL_TABS} so no challenge repeats
 * a recognisable shape.
 * @param random - uniform source in [0, 1) (injectable for tests); draws run
 * x, y, then tab.
 * @returns the position (rounded to whole units) and the silhouette.
 */
export function pickAnswer(random = Math.random) {
    const pick = (min, max) => {
        const span = max - min + 1;
        return min + Math.min(span - 1, Math.floor(random() * span));
    };
    const x = pick(MIN_ANSWER_X, MAX_ANSWER_X);
    const y = pick(MIN_ANSWER_Y, MAX_ANSWER_Y);
    const tab = ALL_TABS[Math.min(ALL_TABS.length - 1, Math.floor(random() * ALL_TABS.length))] ?? 'right';
    return { x, y, tab };
}
/**
 * Whether a submitted drop lands inside the slot.
 * @param answer - the slot the server issued.
 * @param submitted - the position the client reported.
 * @returns `true` when both axes are within {@link TOLERANCE}.
 */
export function isWithinTolerance(answer, submitted) {
    return Math.abs(answer.x - submitted.x) <= TOLERANCE && Math.abs(answer.y - submitted.y) <= TOLERANCE;
}
/** How a drop travels on the wire: `"<x>,<y>"`. */
export function formatDrop(point) {
    return `${point.x},${point.y}`;
}
/**
 * Parse a submitted drop.
 *
 * The client sends `"x,y"` (see {@link formatDrop}); anything else is junk,
 * and a coordinate outside the draggable range could not have come from the
 * widget. The length cap keeps a hostile value from becoming a parsing
 * exercise.
 * @param value - the candidate, straight off the wire.
 * @returns the position, or `undefined` when it is not a usable pair.
 */
export function parseDrop(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 24)
        return undefined;
    const parts = value.split(',');
    if (parts.length !== 2)
        return undefined;
    // A strict shape rather than bare `Number()`: that would accept "", " 1",
    // "0x10" and "1e9", and an empty part quietly becomes a zero — a coordinate
    // the caller never sent.
    const numeric = /^[0-9]{1,6}(\.[0-9]{1,4})?$/;
    const [rawX, rawY] = parts;
    if (rawX === undefined || rawY === undefined)
        return undefined;
    if (!numeric.test(rawX) || !numeric.test(rawY))
        return undefined;
    const x = Number(rawX);
    const y = Number(rawY);
    // The widest the widget can place a piece: the smallest outline is
    // `PIECE_SIZE` across, so nothing it could legitimately report exceeds this.
    if (x > CANVAS_WIDTH - PIECE_SIZE)
        return undefined;
    if (y > CANVAS_HEIGHT - PIECE_SIZE)
        return undefined;
    return { x, y };
}
/** Rounded corner radius of the piece body. */
const CORNER = 6;
/** Every silhouette a hole can take — the real slot draws from all of them. */
export const ALL_TABS = ['right', 'left', 'top', 'bottom', 'none'];
/** Silhouettes a decoy may take — anything but the real slot's own. */
function decoyTabs(real) {
    return ALL_TABS.filter((tab) => tab !== real);
}
/** Bounding-box size of an outline: the body, plus the tab where it has one. */
export function outlineSize(tab) {
    if (tab === 'left' || tab === 'right')
        return { w: PIECE_WIDTH, h: PIECE_SIZE };
    if (tab === 'top' || tab === 'bottom')
        return { w: PIECE_SIZE, h: PIECE_WIDTH };
    return { w: PIECE_SIZE, h: PIECE_SIZE };
}
/**
 * Where the outline's body sits, given the bounding-box anchor.
 *
 * The page reports (and {@link Slot} stores) the outline's top-left corner;
 * for a left- or top-tabbed outline the body is pushed in by the tab's radius
 * so the bulge still reaches exactly that corner.
 * @param slot - the answer's anchor and silhouette.
 * @returns the body's top-left, in canvas units.
 */
export function bodyAnchor(slot) {
    if (slot.tab === 'left')
        return { x: slot.x + TAB_RADIUS, y: slot.y };
    if (slot.tab === 'top')
        return { x: slot.x, y: slot.y + TAB_RADIUS };
    return { x: slot.x, y: slot.y };
}
/**
 * The piece outline: a rounded square with a semicircular tab bulging out of
 * one edge (or none, for the decoy's plain variant).
 *
 * The same path draws the slot in the background and the clip for the piece,
 * so the two can never disagree about the shape.
 * @param x - left edge of the piece body.
 * @param y - top edge of the piece body.
 * @param tab - which edge carries the tab.
 * @returns an SVG path string.
 */
export function piecePath(x, y, tab) {
    const size = PIECE_SIZE;
    const r = TAB_RADIUS;
    const c = CORNER;
    const mx = x + size / 2;
    const my = y + size / 2;
    const seg = [];
    // A clockwise walk of the outline (top → right → bottom → left). On whichever
    // edge carries the tab, the straight run stops short and a semicircular arc
    // bulges outward (sweep 1, clockwise in SVG's y-down frame).
    seg.push(`M ${x + c} ${y}`);
    if (tab === 'top')
        seg.push(`H ${mx - r}`, `A ${r} ${r} 0 0 1 ${mx + r} ${y}`);
    seg.push(`H ${x + size - c}`);
    seg.push(`Q ${x + size} ${y} ${x + size} ${y + c}`);
    if (tab === 'right')
        seg.push(`V ${my - r}`, `A ${r} ${r} 0 0 1 ${x + size} ${my + r}`);
    seg.push(`V ${y + size - c}`);
    seg.push(`Q ${x + size} ${y + size} ${x + size - c} ${y + size}`);
    if (tab === 'bottom')
        seg.push(`H ${mx + r}`, `A ${r} ${r} 0 0 1 ${mx - r} ${y + size}`);
    seg.push(`H ${x + c}`);
    seg.push(`Q ${x} ${y + size} ${x} ${y + size - c}`);
    if (tab === 'left')
        seg.push(`V ${my + r}`, `A ${r} ${r} 0 0 1 ${x} ${my - r}`);
    seg.push(`V ${y + c}`);
    seg.push(`Q ${x} ${y} ${x + c} ${y}`);
    seg.push('Z');
    return seg.join(' ');
}
/**
 * Bounding box of an outline whose body sits at `(x, y)`, tab bulge included.
 * @param x - left edge of the body.
 * @param y - top edge of the body.
 * @param tab - which edge carries the tab.
 * @returns the box in canvas units.
 */
export function outlineBox(x, y, tab) {
    const r = TAB_RADIUS;
    let bx = x;
    let by = y;
    let w = PIECE_SIZE;
    let h = PIECE_SIZE;
    if (tab === 'left') {
        bx -= r;
        w += r;
    }
    if (tab === 'right') {
        w += r;
    }
    if (tab === 'top') {
        by -= r;
        h += r;
    }
    if (tab === 'bottom') {
        h += r;
    }
    return { x: bx, y: by, w, h };
}
/**
 * The decoy's full bounding box, tab bulge included.
 * @param decoy - the decoy.
 * @returns its box in canvas units.
 */
export function decoyBox(decoy) {
    return outlineBox(decoy.x, decoy.y, decoy.tab);
}
/**
 * Bounding box of the real slot: the outline a correct drop lands in.
 * @param slot - the answer.
 * @returns its box in canvas units.
 */
export function slotBox(slot) {
    const body = bodyAnchor(slot);
    return outlineBox(body.x, body.y, slot.tab);
}
/** Whether two boxes keep at least `gap` of clear air between them. */
function clearOf(a, b, gap) {
    return (a.x + a.w + gap <= b.x ||
        b.x + b.w + gap <= a.x ||
        a.y + a.h + gap <= b.y ||
        b.y + b.h + gap <= a.y);
}
/** Canvas margin the decoy keeps from the edge. */
const DECOY_MARGIN = 6;
/** Clear air the decoy keeps from the real slot and from the piece's start. */
const DECOY_GAP = 12;
/**
 * Pick the decoy slot's silhouette and position.
 *
 * The decoy is the puzzle's joke: a second hole in the picture that the piece
 * does not fit. Its silhouette is never the real slot's own, so the piece's
 * own shape identifies the real slot at a glance — which is also the honest
 * answer to "does this stop scripts?" (it does not; see the module note
 * above). What it must not do is spoil the puzzle, so the decoy keeps clear
 * air from the real slot and from the corner the piece starts in, and by
 * construction sits outside the acceptance window.
 * @param slot - the real slot (a constraint, not a target).
 * @param random - uniform source in [0, 1) (injectable for tests).
 * @returns the decoy.
 */
export function pickDecoy(slot, random = Math.random) {
    const real = slotBox(slot);
    // The piece waits at the start in the same silhouette it will be judged by.
    const size = outlineSize(slot.tab);
    const start = { x: START_X, y: START_Y, w: size.w, h: size.h };
    const pool = decoyTabs(slot.tab);
    const pickInt = (min, max) => {
        const span = max - min + 1;
        return min + Math.min(span - 1, Math.floor(random() * span));
    };
    for (let tries = 0; tries < 64; tries += 1) {
        const tab = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'none';
        // Keep the tab bulge itself inside the canvas — whichever edge it picks,
        // now that the pool can be any silhouette but the real slot's own.
        const xMin = DECOY_MARGIN + (tab === 'left' ? TAB_RADIUS : 0);
        const xMax = CANVAS_WIDTH - DECOY_MARGIN - PIECE_SIZE - (tab === 'right' ? TAB_RADIUS : 0);
        const yMin = DECOY_MARGIN + (tab === 'top' ? TAB_RADIUS : 0);
        const yMax = CANVAS_HEIGHT - DECOY_MARGIN - PIECE_SIZE - (tab === 'bottom' ? TAB_RADIUS : 0);
        const decoy = { x: pickInt(xMin, xMax), y: pickInt(yMin, yMax), tab };
        const box = decoyBox(decoy);
        if (clearOf(box, real, DECOY_GAP) && clearOf(box, start, DECOY_GAP))
            return decoy;
    }
    // Deterministic last resort, valid for every answer: left of `MIN_ANSWER_X`
    // (so clear of the real slot on the x axis — even a right/left-tabbed box
    // ending at 84 still keeps the 12-unit gap) and above `START_Y` (so clear of
    // the piece's start on the y axis). The silhouette is the pool's first
    // entry, which is never the real slot's own.
    return { x: 26, y: 22, tab: pool[0] ?? 'none' };
}
