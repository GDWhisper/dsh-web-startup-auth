import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_TABS,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  MAX_ANSWER_X,
  MAX_ANSWER_Y,
  MIN_ANSWER_X,
  MIN_ANSWER_Y,
  PIECE_SIZE,
  PIECE_WIDTH,
  START_X,
  START_Y,
  TOLERANCE,
  bodyAnchor,
  decoyBox,
  formatDrop,
  isWithinTolerance,
  outlineSize,
  parseDrop,
  pickAnswer,
  pickDecoy,
  piecePath,
  slotBox,
  type Box,
  type Point,
  type Slot,
  type TabSide,
} from '../src/slider/challenge.ts'
import { renderPuzzle } from '../src/slider/render.ts'
import { SLIDER_TTL_MS, internals, issueSlider, parseSliderTheme, verifySlider } from '../src/slider/index.ts'

/**
 * The slider module is layered — domain (`challenge.ts`), presentation
 * (`render.ts`), orchestration (`index.ts`) — and each layer is exercised on
 * its own here. The shared one-time table lives in `challenge-store.ts` and is
 * tested there.
 *
 * Note what is deliberately **not** asserted: that the slot is hidden from
 * anything reading the picture. It cannot be — a human has to see it — and
 * that is exactly why this mechanism is documented as decorative. The tests
 * below pin the geometry, the tolerance, the silhouette rules and the
 * single-use rule; they do not pretend the puzzle is a barrier.
 */
beforeEach(() => {
  internals.store.prune(Number.MAX_SAFE_INTEGER)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Deterministic LCG, so a rendering is reproducible. */
function seededRandom(seed = 1): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** The slot the store is holding for a handle. */
function issuedAnswer(id: string): Slot {
  return internals.store.peek(id)?.payload.answer ?? { x: -1, y: -1, tab: 'none' }
}

/**
 * An offset inside the draggable range but outside the acceptance window.
 *
 * Picking a direction matters: near the right edge "answer + 40" would fall off
 * the end of the canvas and be rejected as malformed rather than misaligned,
 * which is a different code path.
 */
function offTarget(answer: Point): Point {
  const right = answer.x + TOLERANCE + 20
  const x = right <= CANVAS_WIDTH - PIECE_SIZE ? right : answer.x - TOLERANCE - 20
  return { x, y: answer.y }
}

/** Whether two boxes keep 12 units of clear air between them (DECOY_GAP). */
const apart = (a: Box, b: Box): boolean =>
  a.x + a.w + 12 <= b.x || b.x + b.w + 12 <= a.x || a.y + a.h + 12 <= b.y || b.y + b.h + 12 <= a.y

// ── domain: challenge.ts ─────────────────────────────────────────────────────

describe('slider geometry', () => {
  it('keeps the piece and its travel inside the canvas', () => {
    expect(MIN_ANSWER_X).toBeGreaterThanOrEqual(PIECE_WIDTH)
    // Every silhouette the slot may wear: the box must fit wherever it goes.
    for (const tab of ALL_TABS) {
      const size = outlineSize(tab)
      expect(MAX_ANSWER_X + size.w, tab).toBeLessThanOrEqual(CANVAS_WIDTH)
      expect(MAX_ANSWER_Y + size.h, tab).toBeLessThanOrEqual(CANVAS_HEIGHT)
      expect(START_X + size.w, tab).toBeLessThanOrEqual(CANVAS_WIDTH)
      expect(START_Y + size.h, tab).toBeLessThanOrEqual(CANVAS_HEIGHT)
    }
  })

  it('starts the piece clear of the slot row', () => {
    // If the piece began within a drop of the slot row the drag would collapse
    // back into a one-dimensional slide and the vertical work would be free —
    // so the gap has to exceed the tolerance, not merely exist.
    expect(START_Y - MAX_ANSWER_Y).toBeGreaterThan(TOLERANCE)
    expect(MIN_ANSWER_X - START_X).toBeGreaterThan(TOLERANCE)
    expect(START_X).toBeLessThan(MIN_ANSWER_X)
  })

  it('picks a slot inside the travel range', () => {
    for (let i = 0; i < 200; i += 1) {
      const answer = pickAnswer()
      expect(answer.x).toBeGreaterThanOrEqual(MIN_ANSWER_X)
      expect(answer.x).toBeLessThanOrEqual(MAX_ANSWER_X)
      expect(answer.y).toBeGreaterThanOrEqual(MIN_ANSWER_Y)
      expect(answer.y).toBeLessThanOrEqual(MAX_ANSWER_Y)
      expect(Number.isInteger(answer.x)).toBe(true)
      expect(Number.isInteger(answer.y)).toBe(true)
      expect(ALL_TABS).toContain(answer.tab)
      // The anchor is the outline's box, so the whole outline has to fit.
      const size = outlineSize(answer.tab)
      expect(answer.x + size.w).toBeLessThanOrEqual(CANVAS_WIDTH)
      expect(answer.y + size.h).toBeLessThanOrEqual(CANVAS_HEIGHT)
    }
  })

  it('draws every silhouette across challenges', () => {
    // A shape that never changed would let the real hole be told apart from
    // the decoy by memory instead of by looking at this picture.
    const seen = new Set<TabSide>()
    for (let i = 0; i < 200; i += 1) seen.add(pickAnswer(seededRandom(i + 1)).tab)
    expect([...seen].sort()).toEqual([...ALL_TABS].sort())
  })

  it('reaches both ends of both ranges', () => {
    // A generator that never lands near an edge would make some slots
    // unreachable — and the ends are where an off-by-one would hide.
    expect(pickAnswer(() => 0)).toEqual({ x: MIN_ANSWER_X, y: MIN_ANSWER_Y, tab: 'right' })
    expect(pickAnswer(() => 0.999999)).toEqual({ x: MAX_ANSWER_X, y: MAX_ANSWER_Y, tab: 'none' })
    expect(pickAnswer(() => 1)).toEqual({ x: MAX_ANSWER_X, y: MAX_ANSWER_Y, tab: 'none' })
  })

  it('accepts a drop inside the tolerance and refuses one outside', () => {
    const answer = { x: 150, y: 50 }
    expect(isWithinTolerance(answer, { x: 150, y: 50 })).toBe(true)
    expect(isWithinTolerance(answer, { x: 150 + TOLERANCE, y: 50 - TOLERANCE })).toBe(true)
    // Either axis alone is enough to miss.
    expect(isWithinTolerance(answer, { x: 150 + TOLERANCE + 1, y: 50 })).toBe(false)
    expect(isWithinTolerance(answer, { x: 150, y: 50 + TOLERANCE + 1 })).toBe(false)
  })

  it('round-trips a drop through its wire format', () => {
    expect(formatDrop({ x: 123, y: 45 })).toBe('123,45')
    expect(parseDrop(formatDrop({ x: 123.4, y: 45.6 }))).toEqual({ x: 123.4, y: 45.6 })
  })

  it('parses only drops the widget could have produced', () => {
    expect(parseDrop('0,0')).toEqual({ x: 0, y: 0 })
    // The widest placement the widget allows (its smallest outline still
    // fits) — any silhouette's drop falls inside these caps.
    expect(parseDrop(`${CANVAS_WIDTH - PIECE_SIZE},${CANVAS_HEIGHT - PIECE_SIZE}`))
      .toEqual({ x: CANVAS_WIDTH - PIECE_SIZE, y: CANVAS_HEIGHT - PIECE_SIZE })
    // Beyond the draggable range, malformed, or not a pair at all.
    expect(parseDrop(`${CANVAS_WIDTH - PIECE_SIZE + 1},0`)).toBeUndefined()
    expect(parseDrop(`0,${CANVAS_HEIGHT - PIECE_SIZE + 1}`)).toBeUndefined()
    expect(parseDrop('-1,0')).toBeUndefined()
    expect(parseDrop('0,-1')).toBeUndefined()
    expect(parseDrop('150')).toBeUndefined()
    expect(parseDrop('1,2,3')).toBeUndefined()
    expect(parseDrop(',')).toBeUndefined()
    expect(parseDrop('a,b')).toBeUndefined()
    expect(parseDrop('')).toBeUndefined()
    expect(parseDrop('1'.repeat(25))).toBeUndefined()
    expect(parseDrop(42)).toBeUndefined()
    expect(parseDrop(undefined)).toBeUndefined()
  })

  it('draws the piece as a closed path with a tab', () => {
    const path = piecePath(100, 40, 'right')
    expect(path.startsWith('M ')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    // The arc is the tab; without it the shape is just a rounded square.
    expect(path).toContain('A ')
  })

  it('draws the tab bulging out of any edge, or no tab at all', () => {
    // The real slot picks among these; the decoy borrows the rest.
    for (const tab of ['right', 'top', 'bottom', 'left'] as const) {
      const path = piecePath(100, 40, tab)
      expect(path.startsWith('M ')).toBe(true)
      expect(path.endsWith('Z')).toBe(true)
      expect(path, tab).toContain('A ')
    }
    expect(piecePath(100, 40, 'none')).not.toContain('A ')
  })
})

// ── domain: the decoy slot ───────────────────────────────────────────────────

describe('slider decoy', () => {
  it('never wears the real slot silhouette', () => {
    // The piece only fits the hole shaped like it — that is how a person (or a
    // script, just as easily) tells the two holes apart, whichever shape the
    // real slot drew this time.
    for (let i = 0; i < 200; i += 1) {
      const slot = pickAnswer(seededRandom(i + 1))
      const decoy = pickDecoy(slot, seededRandom(i + 2))
      expect(decoy.tab).not.toBe(slot.tab)
    }
  })

  it('keeps clear of the slot and of the piece start, and fits the canvas', () => {
    for (let i = 0; i < 200; i += 1) {
      const slot = pickAnswer(seededRandom(i + 1))
      const decoy = pickDecoy(slot, seededRandom(i + 7))
      const box = decoyBox(decoy)
      // Tab bulge included, inside the canvas...
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(CANVAS_WIDTH)
      expect(box.y + box.h).toBeLessThanOrEqual(CANVAS_HEIGHT)
      // ...and clear of both keep-out zones, or it would spoil the puzzle.
      // The slot box follows the silhouette; the start wears the same one.
      expect(apart(box, slotBox(slot))).toBe(true)
      expect(apart(box, { x: START_X, y: START_Y, ...outlineSize(slot.tab) })).toBe(true)
    }
  })

  it('falls back to a valid decoy when placement keeps failing', () => {
    // A source that always proposes the same overlapping corner exhausts the
    // retries, so the deterministic fallback carries the puzzle instead — and
    // must honour the same rules for every real silhouette: a shape unlike the
    // slot's own, clear air, and a box inside the canvas.
    for (const tab of ALL_TABS) {
      const slot: Slot = { x: MAX_ANSWER_X, y: MAX_ANSWER_Y, tab }
      const decoy = pickDecoy(slot, () => 0.999999)
      expect(decoy.tab, tab).not.toBe(tab)
      const box = decoyBox(decoy)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(CANVAS_WIDTH)
      expect(box.y + box.h).toBeLessThanOrEqual(CANVAS_HEIGHT)
      expect(apart(box, slotBox(slot))).toBe(true)
      expect(apart(box, { x: START_X, y: START_Y, ...outlineSize(tab) })).toBe(true)
    }
  })

  it('never passes for the slot', () => {
    // Dropping the piece on the decoy (its box corner is where the piece
    // would land) must not count as solved.
    for (let i = 0; i < 200; i += 1) {
      const slot = pickAnswer(seededRandom(i + 1))
      const decoy = pickDecoy(slot, seededRandom(i + 3))
      const box = decoyBox(decoy)
      expect(isWithinTolerance(slot, { x: box.x, y: box.y })).toBe(false)
    }
  })
})

// ── presentation: render.ts ──────────────────────────────────────────────────

describe('slider rendering', () => {
  it('renders two self-contained svg documents', () => {
    const { background, piece } = renderPuzzle(7, { x: 150, y: 40, tab: 'right' }, 'light')
    for (const svg of [background, piece]) {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
    }
  })

  it('crops the piece to its own outline', () => {
    // The crop is what makes the piece draggable as a plain image: its top-left
    // corner in page coordinates *is* the offset the page reports. The box is
    // the outline's bounding box — tab bulge included — for every silhouette,
    // and the clip is the outline itself, body placed per silhouette.
    for (const tab of ALL_TABS) {
      const slot: Slot = { x: 137, y: 52, tab }
      const size = outlineSize(tab)
      const { piece } = renderPuzzle(7, slot, 'light')
      expect(piece, tab).toContain(`viewBox="${slot.x} ${slot.y} ${size.w} ${size.h}"`)
      expect(piece, tab).toContain(`width="${size.w}" height="${size.h}"`)
      const body = bodyAnchor(slot)
      expect(piece, tab).toContain(
        `<clipPath id="dsh-slider-piece"><path d="${piecePath(body.x, body.y, tab)}"/></clipPath>`,
      )
    }
  })

  it('cuts the slot into the background at the answer, without an outline', () => {
    for (const tab of ALL_TABS) {
      const slot: Slot = { x: 137, y: 52, tab }
      const { background } = renderPuzzle(7, slot, 'light')
      const body = bodyAnchor(slot)
      expect(background, tab).toContain(piecePath(body.x, body.y, tab))
      // The slot is a visible cut-out — that is the puzzle working as intended.
      expect(background, tab).toContain('fill="rgba(17, 24, 39, 0.45)"')
      // ...but only a silhouette: an outline reads as a drawn box, and doubles
      // as a hard edge for a script to lock onto. Every hole in the background
      // (the real slot and the decoy) obeys this.
      const pathTags = background.match(/<path [^>]*>/g) ?? []
      expect(pathTags.length, tab).toBe(2)
      for (const tag of pathTags) {
        expect(tag).toContain('fill=')
        expect(tag).not.toContain('stroke')
      }
    }
  })

  it('cuts one decoy of a different shape into the background', () => {
    for (const tab of ALL_TABS) {
      const slot: Slot = { x: 137, y: 52, tab }
      const { background, decoy } = renderPuzzle(7, slot, 'light')
      // Drawn, and shaped nothing like the real slot.
      expect(background, tab).toContain(piecePath(decoy.x, decoy.y, decoy.tab))
      expect(decoy.tab, tab).not.toBe(tab)
      // Not painted over the answer: the piece must visibly fit one hole only.
      expect(apart(decoyBox(decoy), slotBox(slot)), tab).toBe(true)
    }
  })

  it('cuts both documents from the same picture', () => {
    // A piece cut from a *different* texture could never be aligned, which
    // would make the puzzle unsolvable rather than merely decorative.
    const { background, piece } = renderPuzzle(99, { x: 150, y: 40, tab: 'left' }, 'light')
    // Compare the generated primitives themselves: the piece document also
    // carries a clipPath, so slicing between tags would pick up the wrong one.
    const blobs = (svg: string): string[] => svg.match(/<circle[^>]*opacity="0\.32"\/>/g) ?? []
    const streaks = (svg: string): string[] => svg.match(/<line[^>]*\/>/g) ?? []
    expect(blobs(background)).toHaveLength(7)
    expect(blobs(piece)).toEqual(blobs(background))
    expect(streaks(piece)).toEqual(streaks(background))
  })

  it('is fully determined by the seed', () => {
    const first = renderPuzzle(42, { x: 150, y: 40, tab: 'right' }, 'light')
    const second = renderPuzzle(42, { x: 150, y: 40, tab: 'right' }, 'light')
    expect(first).toEqual(second)
    expect(first).not.toEqual(renderPuzzle(43, { x: 150, y: 40, tab: 'right' }, 'light'))
    // The silhouette is part of the drawing, so it changes the documents too.
    expect(first).not.toEqual(renderPuzzle(42, { x: 150, y: 40, tab: 'left' }, 'light'))
  })

  it('picks the palette from the theme', () => {
    expect(renderPuzzle(1, { x: 150, y: 40, tab: 'right' }, 'light').background).toContain('#dce6f7')
    expect(renderPuzzle(1, { x: 150, y: 40, tab: 'right' }, 'dark').background).toContain('#42557d')
  })

  it('reads the theme hint off a query value', () => {
    expect(parseSliderTheme('dark')).toBe('dark')
    expect(parseSliderTheme('light')).toBe('light')
    expect(parseSliderTheme(null)).toBe('light')
    expect(parseSliderTheme('DARK')).toBe('light')
  })
})

// ── orchestration: index.ts ──────────────────────────────────────────────────

describe('slider issue/verify', () => {
  it('issues an opaque id, both images and the geometry', () => {
    const issued = issueSlider('192.0.2.1', 'light')
    expect(issued.id).toMatch(/^[0-9a-f]{32}$/)
    expect(issued.expiresInMs).toBe(SLIDER_TTL_MS)
    expect(issued.background.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(issued.piece.startsWith('data:image/svg+xml;base64,')).toBe(true)
    // Geometry travels with the puzzle so the page hardcodes nothing — and it
    // has to describe the silhouette that was actually drawn, or the page
    // would size the piece element wrong.
    const slot = issuedAnswer(issued.id)
    const size = outlineSize(slot.tab)
    expect(issued.width).toBe(CANVAS_WIDTH)
    expect(issued.height).toBe(CANVAS_HEIGHT)
    expect(issued.pieceWidth).toBe(size.w)
    expect(issued.pieceHeight).toBe(size.h)
    const pieceSvg = Buffer.from(issued.piece.slice(issued.piece.indexOf(',') + 1), 'base64').toString('utf8')
    expect(pieceSvg).toContain(`width="${size.w}" height="${size.h}"`)
    expect(pieceSvg).toContain(`viewBox="${slot.x} ${slot.y} ${size.w} ${size.h}"`)
    expect(issued.startX).toBe(START_X)
    expect(issued.startY).toBe(START_Y)
    expect(issued.tolerance).toBe(TOLERANCE)
    expect(internals.store.peek(issued.id)?.clientKey).toBe('192.0.2.1')
  })

  it('issues every silhouette across challenges', () => {
    // Same uniform draw as pickAnswer; ~200 flips cannot miss one of five.
    const seen = new Set<TabSide>()
    for (let i = 0; i < 200 && seen.size < ALL_TABS.length; i += 1) {
      seen.add(issuedAnswer(issueSlider('192.0.2.1').id).tab)
    }
    expect([...seen].sort()).toEqual([...ALL_TABS].sort())
  })

  it('accepts the slot and refuses a drop outside the window', () => {
    const issued = issueSlider('192.0.2.1')
    const answer = issuedAnswer(issued.id)
    expect(verifySlider('192.0.2.1', issued.id, formatDrop({ x: answer.x + TOLERANCE, y: answer.y })))
      .toEqual({ ok: true })

    const other = issueSlider('192.0.2.1')
    expect(verifySlider('192.0.2.1', other.id, formatDrop(offTarget(issuedAnswer(other.id)))))
      .toEqual({ ok: false, reason: 'misaligned' })
  })

  it('refuses a drop that is right on one axis and wrong on the other', () => {
    // Both axes have to line up; a one-dimensional slide must not pass.
    const issued = issueSlider('192.0.2.1')
    const answer = issuedAnswer(issued.id)
    const wrongY = answer.y + TOLERANCE + 20 <= CANVAS_HEIGHT - PIECE_SIZE ? answer.y + TOLERANCE + 20 : answer.y - TOLERANCE - 20
    expect(verifySlider('192.0.2.1', issued.id, formatDrop({ x: answer.x, y: wrongY })))
      .toEqual({ ok: false, reason: 'misaligned' })
  })

  it('consumes the puzzle on a wrong drop', () => {
    const issued = issueSlider('192.0.2.1')
    const answer = issuedAnswer(issued.id)
    expect(verifySlider('192.0.2.1', issued.id, formatDrop(offTarget(answer)))).toEqual({ ok: false, reason: 'misaligned' })
    // Same id, right offset, no second chance: one puzzle, one attempt.
    expect(verifySlider('192.0.2.1', issued.id, formatDrop(answer))).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an empty submission without touching the store', () => {
    const issued = issueSlider('192.0.2.1')
    expect(verifySlider('192.0.2.1', '', '10,10')).toEqual({ ok: false, reason: 'missing' })
    expect(verifySlider('192.0.2.1', issued.id, '')).toEqual({ ok: false, reason: 'missing' })
    expect(internals.store.peek(issued.id)).toBeDefined()
  })

  it('refuses a malformed offset', () => {
    // A fresh puzzle per case: the verifier consumes on every attempt, so one
    // handle cannot be reused to probe several shapes.
    for (const bad of ['nope', '-5,10', '1e9,1e9', '999,999', '10']) {
      const issued = issueSlider('192.0.2.1')
      expect(verifySlider('192.0.2.1', issued.id, bad), bad).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('refuses a drop reported by another client', () => {
    const issued = issueSlider('192.0.2.1')
    expect(verifySlider('192.0.2.2', issued.id, formatDrop(issuedAnswer(issued.id))))
      .toEqual({ ok: false, reason: 'ip-mismatch' })
  })

  it('refuses an unknown id', () => {
    expect(verifySlider('192.0.2.1', 'deadbeef', '150,40')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an expired puzzle even with the right offset', () => {
    vi.useFakeTimers()
    try {
      const issued = issueSlider('192.0.2.1')
      const answer = issuedAnswer(issued.id)
      vi.advanceTimersByTime(SLIDER_TTL_MS + 1)
      expect(verifySlider('192.0.2.1', issued.id, formatDrop(answer))).toEqual({ ok: false, reason: 'expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an address-less caller as its own binding', () => {
    const issued = issueSlider(undefined)
    expect(verifySlider('192.0.2.1', issued.id, formatDrop(issuedAnswer(issued.id))))
      .toEqual({ ok: false, reason: 'ip-mismatch' })
  })

  it('does not reuse a picture across challenges', () => {
    // A recognisable picture would let a caller answer without looking.
    const first = issueSlider('192.0.2.1')
    const second = issueSlider('192.0.2.1')
    expect(first.background).not.toBe(second.background)
  })

  it('blinds a blind guess often enough to be a nuisance and not more', () => {
    // Documents the actual strength: a random offset lands in the window about
    // this often, and the single-use rule plus the login limiter are what make
    // that useless rather than the puzzle being hard.
    // Both axes: (9 / 243) * (9 / 79)
    const hitRate = ((2 * TOLERANCE + 1) / (CANVAS_WIDTH - PIECE_WIDTH))
      * ((2 * TOLERANCE + 1) / (MAX_ANSWER_Y - MIN_ANSWER_Y + 1))
    expect(hitRate).toBeLessThan(0.01)
  })
})
