import { describe, expect, it } from 'vitest'
import { LOGIN_PAGE_HTML } from '../src/login-page.ts'

/**
 * The login page is a standalone document: the browser half registers nowhere
 * and no test harness loads it, so these assertions are the only guard on the
 * script it ships. Both cases here are regressions worth locking down.
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
})
