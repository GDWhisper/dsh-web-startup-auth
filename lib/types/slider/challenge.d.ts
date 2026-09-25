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
export declare const CANVAS_WIDTH = 300;
export declare const CANVAS_HEIGHT = 150;
/** Side of the square piece body. */
export declare const PIECE_SIZE = 44;
/** Radius of the tab bulging out of one edge of the piece body. */
export declare const TAB_RADIUS = 14;
/**
 * The piece's largest extent: body plus tab.
 *
 * Horizontal tabs make this the width, vertical tabs the height — see
 * {@link outlineSize}.
 */
export declare const PIECE_WIDTH: number;
/** Leftmost slot offset. Keeps the slot clear of the piece's own start. */
export declare const MIN_ANSWER_X = 96;
/** Rightmost slot offset, leaving a small margin from the canvas edge. */
export declare const MAX_ANSWER_X: number;
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
export declare const MIN_ANSWER_Y = 6;
export declare const MAX_ANSWER_Y: number;
/**
 * Where the piece starts: the top-left corner of its outline.
 *
 * A row below {@link MAX_ANSWER_Y} on purpose — see above — and low enough
 * that even the tall (top/bottom-tab) outline fits inside the canvas.
 */
export declare const START_X = 0;
export declare const START_Y = 90;
/**
 * How far off a drop may be and still count, in user units.
 *
 * The window is deliberately small: at ±4 a blind guess covers 9 of the ~139
 * possible offsets (~6%), which the single-use rule and the rate limiter turn
 * into a non-starter. Widening it to be "friendlier" would trade the only
 * property this mechanism actually has.
 */
export declare const TOLERANCE = 4;
/** Where the piece sits, in canvas units. */
export interface Point {
    x: number;
    y: number;
}
/** An axis-aligned box in canvas units. */
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
/**
 * The answer: a slot's bounding-box anchor plus its silhouette.
 *
 * `(x, y)` is the top-left of the outline's bounding box — exactly the
 * element position the page reports on a drop, so verification stays a pure
 * point comparison. The silhouette never travels on the wire: the player reads
 * it off the picture, which is the whole point.
 */
export interface Slot extends Point {
    /** Which silhouette the hole and its piece share. */
    tab: TabSide;
}
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
export declare function pickAnswer(random?: () => number): Slot;
/**
 * Whether a submitted drop lands inside the slot.
 * @param answer - the slot the server issued.
 * @param submitted - the position the client reported.
 * @returns `true` when both axes are within {@link TOLERANCE}.
 */
export declare function isWithinTolerance(answer: Point, submitted: Point): boolean;
/** How a drop travels on the wire: `"<x>,<y>"`. */
export declare function formatDrop(point: Point): string;
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
export declare function parseDrop(value: unknown): Point | undefined;
/**
 * Which edge of the piece body the tab bulges out of, if any.
 *
 * Every hole wears one of these. The real slot draws its silhouette fresh per
 * challenge — its piece has to match it, so a shape that never changed would
 * make the decoy's joke answerable by memory instead of by looking. A decoy
 * always picks a *different* member of {@link ALL_TABS}, so the piece's own
 * shape identifies the real slot at a glance.
 */
export type TabSide = 'right' | 'top' | 'bottom' | 'left' | 'none';
/** Every silhouette a hole can take — the real slot draws from all of them. */
export declare const ALL_TABS: readonly TabSide[];
/** Bounding-box size of an outline: the body, plus the tab where it has one. */
export declare function outlineSize(tab: TabSide): {
    w: number;
    h: number;
};
/**
 * Where the outline's body sits, given the bounding-box anchor.
 *
 * The page reports (and {@link Slot} stores) the outline's top-left corner;
 * for a left- or top-tabbed outline the body is pushed in by the tab's radius
 * so the bulge still reaches exactly that corner.
 * @param slot - the answer's anchor and silhouette.
 * @returns the body's top-left, in canvas units.
 */
export declare function bodyAnchor(slot: Slot): Point;
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
export declare function piecePath(x: number, y: number, tab: TabSide): string;
/** A decoy slot: a body anchor plus a silhouette unlike the real slot's. */
export interface Decoy {
    /** Left edge of the decoy's body (its tab bulges outside this box). */
    x: number;
    /** Top edge of the decoy's body. */
    y: number;
    /** The decoy's silhouette — never the real slot's own. */
    tab: TabSide;
}
/**
 * Bounding box of an outline whose body sits at `(x, y)`, tab bulge included.
 * @param x - left edge of the body.
 * @param y - top edge of the body.
 * @param tab - which edge carries the tab.
 * @returns the box in canvas units.
 */
export declare function outlineBox(x: number, y: number, tab: TabSide): Box;
/**
 * The decoy's full bounding box, tab bulge included.
 * @param decoy - the decoy.
 * @returns its box in canvas units.
 */
export declare function decoyBox(decoy: Decoy): Box;
/**
 * Bounding box of the real slot: the outline a correct drop lands in.
 * @param slot - the answer.
 * @returns its box in canvas units.
 */
export declare function slotBox(slot: Slot): Box;
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
export declare function pickDecoy(slot: Slot, random?: () => number): Decoy;
