import { describe, expect, it } from 'vitest'
import { LOGIN_PAGE_HTML } from '../src/login-page.ts'

/**
 * The login page is a standalone document: the browser half registers nowhere
 * and no test harness loads it, so these assertions are the only guard on the
 * script it ships. Every case here is a regression worth locking down.
 */
describe('login page', () => {
  it('keeps a trusted-but-unregistered visitor on the registration form', () => {
    // A loopback caller is implicitly trusted before any admin exists, so
    // `/api/auth/status` reports `authenticated: true`. Redirecting on that
    // flag alone bounces them straight back to `/` — and since the index never
    // redirects a caller it trusts, that closes the last browser route to
    // creating the first admin (issue #27).
    expect(LOGIN_PAGE_HTML).toContain("data.authenticated && data.registered")
  })

  it('renders the registration form from the status reply', () => {
    expect(LOGIN_PAGE_HTML).toContain("mode = data.registered ? 'login' : 'register'")
  })

  it('parses as a script', () => {
    // The page has no build step, so nothing else would catch a syntax error
    // here: the failure mode is a silently dead login form. `new Function`
    // compiles the inline script without running it.
    const script = /<script>([\s\S]*?)<\/script>/.exec(LOGIN_PAGE_HTML)?.[1]
    expect(script).toBeDefined()
    expect(() => new Function(script ?? '')).not.toThrow()
  })
})

/**
 * The slider puzzle is opt-in and off by default: the page must therefore be
 * able to log in without ever hearing about a challenge, and only grow the
 * extra controls when the server says it wants one.
 */
describe('login page slider puzzle', () => {
  it('asks the server whether a puzzle is required', () => {
    expect(LOGIN_PAGE_HTML).toContain("fetch('/api/auth/challenge'")
  })

  it('ships the stage, the background, the piece and the refresh control', () => {
    expect(LOGIN_PAGE_HTML).toContain('id="challenge-field"')
    expect(LOGIN_PAGE_HTML).toContain('id="slider-stage"')
    expect(LOGIN_PAGE_HTML).toContain('id="slider-bg"')
    expect(LOGIN_PAGE_HTML).toContain('id="slider-piece"')
    expect(LOGIN_PAGE_HTML).toContain('id="captcha-refresh"')
  })

  it('drag is free on both axes, not a horizontal slide', () => {
    // The slot is not on the piece's row, so a one-dimensional slide cannot
    // solve it; the drag tracks both clientX and clientY.
    expect(LOGIN_PAGE_HTML).toContain('dragStartPointerY')
    expect(LOGIN_PAGE_HTML).toContain('clampY(')
  })

  it('drags with pointer events, so mouse and touch behave the same', () => {
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      expect(LOGIN_PAGE_HTML).toContain(`addEventListener('${event}'`)
    }
    // Capture is what keeps a fast drag from dropping the piece when the
    // pointer leaves it; touch-action is what stops a drag from scrolling.
    expect(LOGIN_PAGE_HTML).toContain('setPointerCapture')
    expect(LOGIN_PAGE_HTML).toContain('touch-action: none')
  })

  it('places the piece by percentage, so any display width works', () => {
    // The stage is fluid (the card is narrower than the canvas on a phone), so
    // pixel positions would drift; only the drag delta needs the scale.
    expect(LOGIN_PAGE_HTML).toContain("(pieceX / canvasWidth * 100) + '%'")
    expect(LOGIN_PAGE_HTML).toContain('stageScale()')
  })

  it('takes the geometry from the server, never from a literal', () => {
    for (const field of ['data.pieceWidth', 'data.pieceHeight', 'data.startX', 'data.startY', 'data.width', 'data.height']) {
      expect(LOGIN_PAGE_HTML).toContain(field)
    }
  })

  it('reports the drop as a pair with the login attempt', () => {
    expect(LOGIN_PAGE_HTML).toContain('payload.challengeId = challengeId')
    expect(LOGIN_PAGE_HTML).toContain("Math.round(pieceX) + ',' + Math.round(pieceY)")
  })

  it('clears the password when the puzzle is what failed', () => {
    // A half-filled form must not be resubmittable against a fresh puzzle by
    // muscle memory alone.
    expect(LOGIN_PAGE_HTML).toContain('if (data && data.challengeExpired) {')
    expect(LOGIN_PAGE_HTML).toContain("password.value = ''")
  })

  it('refuses a submit before the piece has been moved', () => {
    // The untouched start position can never be the slot, so this is a clearer
    // message rather than a server round trip.
    expect(LOGIN_PAGE_HTML).toContain('sliderVisible() && !hasDragged')
  })

  it('only shows the field for a login, never for registration', () => {
    // Registration is never gated (see src/slider/index.ts): showing the field
    // there would ask for something the server ignores.
    expect(LOGIN_PAGE_HTML).toContain("return sliderEnabled && mode === 'login'")
  })

  it('re-arms after every failed attempt, not just an expired puzzle', () => {
    // The verifier runs before the password check, so *any* rejected login has
    // already spent the puzzle — including a wrong password, which does not
    // report `challengeExpired`. Re-arming only on that flag left the retry
    // failing with a stale handle (browser-caught 2026-09-24).
    expect(LOGIN_PAGE_HTML).toContain('if (data && data.error) void loadChallenge()')
  })

  it('resets the piece whenever a fresh puzzle arrives', () => {
    expect(LOGIN_PAGE_HTML).toContain('hasDragged = false')
  })

  it('does not block a login on a failed puzzle read', () => {
    // A deployment that never turned the switch on must not be locked out by
    // an unrelated fetch failure: the flag stays false until an answer says
    // otherwise.
    expect(LOGIN_PAGE_HTML).toContain('var sliderEnabled = false')
  })
})
