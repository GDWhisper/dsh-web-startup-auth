import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
// Inlined by tsdown (dependency-free constants module shared with the node half).
import { SESSION_MAX_AGE_CHOICES } from "../session-limits.js";
/**
 * Service required before the section can be registered. The settings
 * section ledger is contributed by the settings shell (`settings.section`
 * slot declaration); the bundle-load order is not a timing guarantee, so the
 * registration waits on the `slots` service instead.
 *
 * Note (0.1.2): the rc.8-0.1.1 `connection.isLoopback` override (both the
 * node-half tapIndex hook and this plugin's defensive re-apply) is GONE.
 * Upstream's real cookie authentication lets a remote browser into the UI,
 * but ui-settings still builds its settings mirror from
 * `connection.isLoopback` (`location.hostname`), so LAN browsers get a
 * `memory` mirror whose Models section reports "settings are unavailable in
 * this browser". The tapIndex hook sets `window.__DSH_TRANSPORT__` with
 * `ownsHost: true` instead — that makes connection report loopback without
 * rewriting the cordis service. No mirror guard is needed here.
 */
export const inject = ['slots'];
/** Stable registration id inside the settings section list. */
const SECTION_ID = 'auth';
/** Nav label, and the only DOM-visible identity of our nav row (see installAuthNavIcon). */
const SECTION_LABEL = '认证';
/** Marks a nav row whose glyph was already swapped, so neither React nor the observer loops. */
const GLYPH_ATTR = 'data-dsh-auth-nav-icon';
/** Shield + check glyph, drawn in the shell's idiom: 16px grid, currentColor, no fill. */
const SHIELD_GLYPH_MARKUP = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8 1.4 L13.6 3.35 V7.9 C13.6 11.1 11.3 13.45 8 14.6 C4.7 13.45 2.4 11.1 2.4 7.9 V3.35 Z" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />' +
    '<path d="M5.3 7.9 L7.3 9.9 L10.8 6.2" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />' +
    '</svg>';
/** How long a status/action message stays visible. */
const MESSAGE_MS = 5000;
/** Reads `/api/auth/status`; never rejects, so callers need no try/catch. */
async function readStatus() {
    try {
        const res = await fetch('/api/auth/status');
        if (!res.ok)
            return { failed: true };
        return { body: (await res.json()) };
    }
    catch {
        return { failed: true };
    }
}
/** Reads the loopback-login policy; `undefined` means "could not read". */
async function readPolicy() {
    try {
        const res = await fetch('/api/auth/policy');
        if (!res.ok)
            return undefined;
        const data = (await res.json());
        return typeof data.requireLoopbackLogin === 'boolean' ? data.requireLoopbackLogin : undefined;
    }
    catch {
        return undefined;
    }
}
/** Reads the configured session lifetime; `undefined` means "could not read". */
async function readSessionMaxAge() {
    try {
        const res = await fetch('/api/auth/session-max-age');
        if (!res.ok)
            return undefined;
        const data = (await res.json());
        return typeof data.days === 'number' ? data.days : undefined;
    }
    catch {
        return undefined;
    }
}
/** Reads the slider-puzzle switch; `undefined` means "could not read". */
async function readSlideVerification() {
    try {
        const res = await fetch('/api/auth/challenge-policy');
        if (!res.ok)
            return undefined;
        const data = (await res.json());
        return typeof data.slideVerification === 'boolean' ? data.slideVerification : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Starts a read now — while this bundle initializes — and returns a taker that
 * hands the result out once.
 *
 * Why not at mount: a request born when the tab mounts lands in the middle of
 * the SPA's startup burst, so it queues behind everything else sharing the six
 * same-origin connections. Browser-measured 2026-09-16: the requests
 * themselves are ~5 ms (queue 1 ms + TTFB 2 ms) and the slowest startup call
 * was 74 ms on a clean instance, yet a live instance can hold such a latecomer
 * up for ten-odd seconds. That wait showed up as placeholders at best, and as
 * a *wrong* answer at worst — the policy switch rendered as OFF (its `useState`
 * default) while the backend said ON, for as long as the read was queued.
 */
function startPrefetch(read) {
    let inflight = read();
    let settled;
    void inflight.then((value) => { settled = value; });
    return () => {
        // Handed out once: later mounts and explicit refreshes read fresh, so a
        // stale answer can never be reused as the current state.
        const taken = { settled, pending: inflight };
        settled = undefined;
        inflight = undefined;
        return taken;
    };
}
const takeStatusPrefetch = startPrefetch(readStatus);
const takePolicyPrefetch = startPrefetch(readPolicy);
const takeSessionMaxAgePrefetch = startPrefetch(readSessionMaxAge);
const takeSlideVerificationPrefetch = startPrefetch(readSlideVerification);
/**
 * The account state behind the tab.
 *
 * `registered` carries its own meaning beyond the username: a loopback caller
 * is implicitly trusted before any admin exists, so `/api/auth/status` reports
 * `authenticated: true` with no username. Only `registered === false` tells the
 * tab that creating the first admin is still on the table — that state has no
 * username *and* no remote account yet, and it is exactly the case where the
 * sign-out / change-password forms are meaningless but registration is not.
 */
function useAccountStatus() {
    // Consumed once, on the first render (see `startPrefetch`).
    const [prefetch] = useState(takeStatusPrefetch);
    const initialBody = prefetch.settled !== undefined && 'body' in prefetch.settled
        ? prefetch.settled.body
        : undefined;
    const [username, setUsername] = useState(initialBody?.username);
    const [registered, setRegistered] = useState(initialBody?.registered);
    const [session, setSession] = useState(initialBody?.session);
    const [trusted, setTrusted] = useState(initialBody?.trusted);
    const [failed, setFailed] = useState(prefetch.settled !== undefined && 'failed' in prefetch.settled);
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        // The first render already applied a settled prefetch.
        if (nonce === 0 && prefetch.settled !== undefined)
            return;
        let cancelled = false;
        const source = nonce === 0 && prefetch.pending !== undefined ? prefetch.pending : readStatus();
        void source.then((result) => {
            if (cancelled)
                return;
            if ('failed' in result) {
                // A failed read is NOT a signed-out verdict. The fields stay unknown
                // so the card asserts nothing it never read.
                setFailed(true);
                return;
            }
            // Every field is written from this one answer, the empty ones included:
            // a name read for an older state must not outlive it.
            setUsername(typeof result.body.username === 'string' ? result.body.username : undefined);
            if (typeof result.body.registered === 'boolean')
                setRegistered(result.body.registered);
            if (typeof result.body.session === 'boolean')
                setSession(result.body.session);
            if (typeof result.body.trusted === 'boolean')
                setTrusted(result.body.trusted);
            setFailed(false);
        });
        return () => { cancelled = true; };
    }, [nonce, prefetch]);
    const refresh = useCallback(() => setNonce((value) => value + 1), []);
    return { username, registered, session, trusted, failed, refresh, setUsername };
}
/**
 * Tracks the "本机登录校验" switch shown in the tab. This maps 1:1 to the
 * backend flag `requireLoopbackLogin` (no inversion): ON = the loopback
 * address is also required to present a session. OUT OF THE BOX it is OFF
 * (loopback trusted = 本机免登录); it only flips ON on an explicit admin
 * action (e.g. a shared multi-user server).
 *
 * `undefined` means the flag has not been read: the switch then renders as
 * unknown instead of as OFF. Rendering the `useState` default as OFF while the
 * backend answers ON is the bug this guards against (browser-verified
 * 2026-09-16: the switch showed OFF for 117 ms on a warm tab, and for as long
 * as the read stayed queued on a busy one).
 */
function useLoopbackLoginCheck() {
    const [prefetch] = useState(takePolicyPrefetch);
    const [loopbackLoginCheck, setLoopbackLoginCheck] = useState(prefetch.settled);
    useEffect(() => {
        if (prefetch.settled !== undefined)
            return;
        let cancelled = false;
        void (prefetch.pending ?? readPolicy()).then((value) => {
            if (!cancelled && value !== undefined)
                setLoopbackLoginCheck(value);
        });
        return () => { cancelled = true; };
    }, [prefetch]);
    return [loopbackLoginCheck, setLoopbackLoginCheck];
}
/**
 * Tracks the "会话有效期" selection shown in the tab. Maps to the persisted
 * `sessionMaxAgeDays` (see session-limits.ts for the selectable choices);
 * OUT OF THE BOX it is the 14-day default. Changing it only affects freshly
 * issued sessions — existing cookies keep the expiry baked in at sign time.
 *
 * `undefined` means the value has not been read: the field says so rather than
 * showing a default the backend may not hold.
 */
function useSessionMaxAge() {
    const [prefetch] = useState(takeSessionMaxAgePrefetch);
    const [days, setDays] = useState(prefetch.settled);
    useEffect(() => {
        if (prefetch.settled !== undefined)
            return;
        let cancelled = false;
        void (prefetch.pending ?? readSessionMaxAge()).then((value) => {
            if (!cancelled && value !== undefined)
                setDays(value);
        });
        return () => { cancelled = true; };
    }, [prefetch]);
    return [days, setDays];
}
/**
 * Tracks the "拼图验证" switch shown in the tab. Maps 1:1 to the backend flag
 * `slideVerification` (no inversion): ON = the login endpoint also demands a
 * solved slider puzzle. OUT OF THE BOX it is OFF.
 *
 * `undefined` means the flag has not been read: the switch then renders as
 * unknown (disabled, semi-transparent) rather than as OFF, for the same reason
 * as the loopback switch above — a backend that says ON must never be
 * displayed as OFF.
 */
function useSlideVerification() {
    const [prefetch] = useState(takeSlideVerificationPrefetch);
    const [enabled, setEnabled] = useState(prefetch.settled);
    useEffect(() => {
        if (prefetch.settled !== undefined)
            return;
        let cancelled = false;
        void (prefetch.pending ?? readSlideVerification()).then((value) => {
            if (!cancelled && value !== undefined)
                setEnabled(value);
        });
        return () => { cancelled = true; };
    }, [prefetch]);
    return [enabled, setEnabled];
}
/**
 * Replace the settings nav's default gear for our row with the shield glyph.
 * Identity comes from the label text because the row button carries no id
 * attribute (React's `key` never reaches the DOM). Geometry and class are
 * copied off the gear so the shell's `.navIcon { flex: none }` sizing and the
 * currentColor nav tint keep working.
 */
function swapNavGlyph() {
    if (document.querySelector(`[${GLYPH_ATTR}]`))
        return;
    for (const label of document.querySelectorAll('nav button span')) {
        if (label.textContent?.trim() !== SECTION_LABEL)
            continue;
        const button = label.closest('button');
        const gear = button?.querySelector('svg');
        if (!button || !gear || button.hasAttribute(GLYPH_ATTR))
            continue;
        button.setAttribute(GLYPH_ATTR, '1');
        const holder = document.createElement('template');
        holder.innerHTML = SHIELD_GLYPH_MARKUP;
        const glyph = holder.content.firstElementChild;
        if (glyph === null)
            return;
        for (const attr of ['width', 'height', 'class']) {
            const value = gear.getAttribute(attr);
            if (value !== null)
                glyph.setAttribute(attr, value);
        }
        glyph.setAttribute('aria-hidden', 'true');
        gear.replaceWith(glyph);
        return;
    }
}
/**
 * The settings shell chooses nav glyphs from a hardcoded if-chain over the
 * section id (`ui-settings-general`'s `navIcon`), and the `settings.section`
 * slot spec carries only `{ id, order, label }` — a registrant cannot ship an
 * icon, so "认证" lands on the fallback gear. Swapping it in the DOM is the
 * only plugin-side route: the panel unmounts on close, so an observer keeps
 * re-applying on every mount, and a row that stops matching simply keeps the
 * gear (cosmetic failure only, never a broken panel).
 */
function installAuthNavIcon() {
    if (typeof document === 'undefined')
        return;
    let queued = false;
    const schedule = () => {
        if (queued)
            return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            swapNavGlyph();
        });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
}
/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-username / change-password post to the auth endpoints and show the
 * outcome inline.
 */
export function AuthSection(props) {
    const { username, registered, session, trusted, failed, refresh, setUsername } = useAccountStatus();
    /** True only when no admin exists yet (`registered` is undefined while loading). */
    const needsRegistration = registered === false;
    /**
     * True only when this browser holds a session cookie. A default loopback
     * deployment is implicitly trusted, so `registered` (and therefore the rest
     * of this tab) is reachable without one: such a caller is authorized but
     * never signed in, and there is nothing for "退出登录" to revoke.
     */
    const signedIn = session === true;
    /**
     * The card has no answer to stand on: either the first read has not
     * returned, or the last read failed — a failed read carries no verdict
     * either, and the fields still hold whatever the previous read said, which
     * is not the current state. Reading this as "signed out" is what made a
     * freshly logged-in browser claim "当前未登录，或登录已失效" and offer a
     * pointless "前往登录" button, and it stuck there for as long as the status
     * request went unanswered (browser-verified 2026-09-16: the wrong copy
     * showed ~25 ms on a warm tab, and indefinitely while the request was
     * blocked).
     */
    const statusUnknown = failed || session === undefined || trusted === undefined;
    /**
     * Signed out *and* out of luck, as a *read answer* reports it: no session,
     * and this origin is not trusted either (loopback login check on, or a
     * remote caller). Everything else in the SPA is 401-ing in this state, so
     * the card points at the login page rather than claiming the address is
     * exempt.
     */
    const signedOut = !statusUnknown && !signedIn && trusted !== true;
    const [loopbackLoginCheck, setLoopbackLoginCheck] = useLoopbackLoginCheck();
    const [sessionMaxAgeDays, setSessionMaxAgeDays] = useSessionMaxAge();
    const [slideVerification, setSlideVerification] = useSlideVerification();
    const [newUsername, setNewUsername] = useState('');
    const [usernamePassword, setUsernamePassword] = useState('');
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(undefined);
    const [confirmingSignOut, setConfirmingSignOut] = useState(false);
    /** Which edit form (if any) is expanded; both start collapsed. */
    const [expanded, setExpanded] = useState(null);
    const flash = useCallback((notice) => {
        setNotice(notice);
        if (notice !== undefined) {
            setTimeout(() => setNotice(undefined), MESSAGE_MS);
        }
    }, []);
    const signOut = useCallback(async () => {
        setBusy(true);
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.href = '/login';
        }
        catch {
            setBusy(false);
            setConfirmingSignOut(false);
            flash({ kind: 'error', text: '退出失败，请重试', owner: 'account' });
        }
    }, [flash]);
    const changePassword = useCallback(async () => {
        if (newPassword !== confirm) {
            flash({ kind: 'error', text: '两次输入的新密码不一致', owner: 'password' });
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword }),
            });
            const data = (await res.json());
            if (res.ok) {
                setOldPassword('');
                setNewPassword('');
                setConfirm('');
                flash({ kind: 'ok', text: '密码已修改', owner: 'password' });
            }
            else {
                flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'password' });
            }
        }
        catch {
            flash({ kind: 'error', text: '修改失败，请重试', owner: 'password' });
        }
        finally {
            setBusy(false);
        }
    }, [oldPassword, newPassword, confirm, flash]);
    const toggleLoopbackLoginCheck = useCallback(async (next) => {
        // Enabling requires an admin account — the backend refuses the flag before
        // one exists (see `setRequireLoopbackLogin`), which would otherwise surface
        // as a bare 400 here. Send the caller to the only page that can create it
        // instead; the switch stays off and can be flipped once they return.
        if (registered === false) {
            flash({ kind: 'error', text: '尚未设置管理员账号，正在前往注册页…', owner: 'policy' });
            window.setTimeout(() => { window.location.href = '/login'; }, 1200);
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/auth/policy', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requireLoopbackLogin: next }),
            });
            const data = (await res.json());
            if (res.ok) {
                setLoopbackLoginCheck(data.requireLoopbackLogin === true);
                if (next && !signedIn) {
                    // Enabling withdraws the implicit trust this very page was riding
                    // on: from now on every protected route wants a session this browser
                    // does not have, so the SPA behind this tab is already 401-ing.
                    // Re-reading the status would only reword the card — send the caller
                    // to sign in instead, which is what "本机地址将要求登录" means here.
                    flash({ kind: 'ok', text: '已启用：本机地址将要求登录，正在前往登录页…', owner: 'policy' });
                    window.setTimeout(() => { window.location.href = '/login'; }, 1200);
                    return;
                }
                // The trust verdict behind `authenticated` moved even when this caller
                // keeps its session, so the account card has to be re-read.
                refresh();
                flash({ kind: 'ok', text: next ? '已启用：本机地址将要求登录' : '已关闭：本机访问免登录', owner: 'policy' });
            }
            else {
                flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'policy' });
            }
        }
        catch {
            flash({ kind: 'error', text: '修改失败，请重试', owner: 'policy' });
        }
        finally {
            setBusy(false);
        }
    }, [flash, refresh, registered, signedIn, setLoopbackLoginCheck]);
    /**
     * Flips the slider-puzzle switch. Unlike the loopback switch this can never
     * lock anyone out — the puzzle is solvable — so there is no navigation side
     * effect; the only failure mode is "no admin account yet", which the backend
     * refuses (the flag lives in the credential file, whose existence is what
     * marks the administrator as registered).
     */
    const toggleSlideVerification = useCallback(async (next) => {
        if (registered === false) {
            flash({ kind: 'error', text: '尚未设置管理员账号，正在前往注册页…', owner: 'challenge' });
            window.setTimeout(() => { window.location.href = '/login'; }, 1200);
            return;
        }
        setBusy(true);
        try {
            const res = await fetch('/api/auth/challenge-policy', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ slideVerification: next }),
            });
            const data = (await res.json());
            if (res.ok) {
                setSlideVerification(data.slideVerification === true);
                flash({
                    kind: 'ok',
                    text: next ? '已开启：登录时出现拼图验证' : '已关闭：登录不再出现拼图验证',
                    owner: 'challenge',
                });
            }
            else {
                flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'challenge' });
            }
        }
        catch {
            flash({ kind: 'error', text: '修改失败，请重试', owner: 'challenge' });
        }
        finally {
            setBusy(false);
        }
    }, [flash, registered, setSlideVerification]);
    /** Persists the selected session lifetime immediately on change (mirrors
     * the policy toggle: load via hook, save on interaction, flash the outcome). */
    const saveSessionMaxAge = useCallback(async (next) => {
        setBusy(true);
        try {
            const res = await fetch('/api/auth/session-max-age', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ days: next }),
            });
            const data = (await res.json());
            if (res.ok) {
                if (typeof data.days === 'number')
                    setSessionMaxAgeDays(data.days);
                flash({ kind: 'ok', text: `已保存：会话有效期 ${next} 天（对新登录的会话生效）`, owner: 'sessionMaxAge' });
            }
            else {
                flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'sessionMaxAge' });
            }
        }
        catch {
            flash({ kind: 'error', text: '修改失败，请重试', owner: 'sessionMaxAge' });
        }
        finally {
            setBusy(false);
        }
    }, [flash, setSessionMaxAgeDays]);
    const changeUsername = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch('/api/auth/change-username', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ newUsername, currentPassword: usernamePassword }),
            });
            const data = (await res.json());
            if (res.ok) {
                setNewUsername('');
                setUsernamePassword('');
                if (typeof data.username === 'string')
                    setUsername(data.username);
                flash({ kind: 'ok', text: '用户名已更新', owner: 'username' });
            }
            else {
                flash({ kind: 'error', text: data.error ?? '修改失败，请重试', owner: 'username' });
            }
        }
        catch {
            flash({ kind: 'error', text: '修改失败，请重试', owner: 'username' });
        }
        finally {
            setBusy(false);
        }
    }, [newUsername, usernamePassword, flash, setUsername]);
    /** Colors use the shell's theme tokens (ui-theme design-platform.css), which
     * flip via body[data-ds-dark-theme]; the literals are light fallbacks for
     * compositions where the theme stylesheet is absent. */
    const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
        borderRadius: 6,
        fontSize: 14,
        fontFamily: 'inherit',
        background: 'var(--dsw-specific-input-major, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #333)',
    };
    const buttonStyle = {
        padding: '8px 16px',
        borderRadius: 6,
        fontSize: 14,
        fontFamily: 'inherit',
        cursor: 'pointer',
        border: '1px solid transparent',
    };
    /** Card wrapper so the four settings blocks read as visually distinct units. */
    const cardStyle = {
        border: '1px solid var(--dsw-alias-border-l2, #e5e5e5)',
        borderRadius: 10,
        padding: '18px 20px',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
    };
    /** Text-button look used to expand/collapse the username / password forms. */
    const linkStyle = {
        background: 'none',
        border: 'none',
        color: 'var(--dsw-alias-button-info-fill, #4d6bfe)',
        fontSize: 13,
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit',
    };
    /** Accordion chevron drawn as a symmetric SVG so it rotates about its true
     * visual center (a border-drawn chevron's mass sits at the corner, which
     * drifts when rotated around the box center). */
    const Chevron = ({ up }) => (_jsx("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, style: { color: 'var(--dsw-alias-label-secondary, #333)', transform: up ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease', transformOrigin: 'center' }, children: _jsx("path", { d: "M3 5 L7 9 L11 5", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }) }));
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 460 }, children: [needsRegistration && (_jsxs("section", { style: { ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary, #d4380d)' }, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u5C1A\u672A\u8BBE\u7F6E\u7BA1\u7406\u5458\u8D26\u53F7" }), _jsx("button", { type: "button", onClick: () => { window.location.href = '/login'; }, style: { ...buttonStyle, background: 'var(--dsw-alias-button-info-fill, #4d6bfe)', color: '#ffffff' }, children: "\u524D\u5F80\u8BBE\u7F6E\u7BA1\u7406\u5458\u8D26\u53F7" })] })), !needsRegistration && (_jsxs(_Fragment, { children: [_jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u8D26\u53F7" }), !statusUnknown && (_jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '0 0 12px' }, children: signedIn
                                    ? `当前登录：${username ?? '管理员'}`
                                    : `管理员账号：${username ?? '管理员'}` })), failed ? (_jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: 0 }, children: "\u65E0\u6CD5\u8BFB\u53D6\u767B\u5F55\u72B6\u6001\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u6B64\u8BBE\u7F6E\u9875\u3002" })) : statusUnknown ? (_jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: 0 }, children: "\u6B63\u5728\u8BFB\u53D6\u767B\u5F55\u72B6\u6001\u2026" })) : signedIn ? (_jsxs("div", { style: { position: 'relative', display: 'inline-block' }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(true), disabled: busy, style: { ...buttonStyle, background: 'none', borderColor: 'var(--dsw-alias-state-error-primary, #d4380d)', color: 'var(--dsw-alias-state-error-primary, #d4380d)' }, children: "\u9000\u51FA\u767B\u5F55" }), confirmingSignOut && (_jsxs("div", { role: "alertdialog", "aria-label": "\u786E\u8BA4\u9000\u51FA\u767B\u5F55", style: {
                                            position: 'absolute',
                                            top: 'calc(100% + 10px)',
                                            left: 0,
                                            zIndex: 10,
                                            minWidth: 260,
                                            padding: '12px 14px',
                                            background: 'var(--dsw-specific-menu, #ffffff)',
                                            border: '1px solid var(--dsw-alias-border-l3, #e5e5e5)',
                                            borderRadius: 8,
                                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
                                        }, children: [_jsx("div", { "aria-hidden": true, style: {
                                                    position: 'absolute',
                                                    top: -6,
                                                    left: 28,
                                                    width: 10,
                                                    height: 10,
                                                    background: 'var(--dsw-specific-menu, #ffffff)',
                                                    borderLeft: '1px solid var(--dsw-alias-border-l3, #e5e5e5)',
                                                    borderTop: '1px solid var(--dsw-alias-border-l3, #e5e5e5)',
                                                    transform: 'rotate(45deg)',
                                                } }), _jsx("div", { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary, #333)', marginBottom: 10 }, children: "\u9000\u51FA\u767B\u5F55\u5C06\u56DE\u5230\u767B\u5F55\u9875" }), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(false), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: 'none', borderColor: 'var(--dsw-alias-border-l2, #d9d9d9)', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", onClick: () => void signOut(), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: 'var(--dsw-alias-state-error-primary, #d4380d)', color: '#ffffff' }, children: "\u786E\u8BA4\u9000\u51FA" })] })] }))] })) : signedOut ? (_jsxs(_Fragment, { children: [_jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '0 0 12px' }, children: "\u5F53\u524D\u672A\u767B\u5F55\uFF0C\u6216\u767B\u5F55\u5DF2\u5931\u6548\u3002" }), _jsx("button", { type: "button", onClick: () => { window.location.href = '/login'; }, style: { ...buttonStyle, background: 'var(--dsw-alias-button-info-fill, #4d6bfe)', color: '#ffffff' }, children: "\u524D\u5F80\u767B\u5F55" })] })) : (_jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: 0 }, children: "\u672C\u673A\u5730\u5740\u514D\u767B\u5F55\uFF1B\u9700\u8981\u5F3A\u5236\u767B\u5F55\u65F6\uFF0C\u6253\u5F00\u4E0B\u65B9\u300C\u767B\u5F55\u8981\u6C42\u300D\u7684\u5F00\u5173\u3002" })), notice?.owner === 'account' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u4FEE\u6539\u7528\u6237\u540D" }), _jsx("button", { type: "button", onClick: () => setExpanded(expanded === 'username' ? null : 'username'), disabled: busy, "aria-label": expanded === 'username' ? '收起' : '修改用户名', "aria-expanded": expanded === 'username', style: { ...linkStyle, padding: 12, margin: -12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx(Chevron, { up: expanded === 'username' }) })] }), expanded === 'username' && (_jsxs("form", { onSubmit: (event) => {
                                    event.preventDefault();
                                    void changeUsername();
                                }, style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u7528\u6237\u540D", _jsx("input", { type: "text", value: newUsername, onChange: (event) => setNewUsername(event.target.value), autoComplete: "username", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: usernamePassword, onChange: (event) => setUsernamePassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: _jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: 'var(--dsw-alias-button-info-fill, #4d6bfe)', color: '#ffffff' }, children: "\u4FEE\u6539\u7528\u6237\u540D" }) })] })), notice?.owner === 'username' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: expanded === 'username' ? '12px 0 0' : '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u4FEE\u6539\u5BC6\u7801" }), _jsx("button", { type: "button", onClick: () => setExpanded(expanded === 'password' ? null : 'password'), disabled: busy, "aria-label": expanded === 'password' ? '收起' : '修改密码', "aria-expanded": expanded === 'password', style: { ...linkStyle, padding: 12, margin: -12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx(Chevron, { up: expanded === 'password' }) })] }), expanded === 'password' && (_jsxs("form", { onSubmit: (event) => {
                                    event.preventDefault();
                                    void changePassword();
                                }, style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: oldPassword, onChange: (event) => setOldPassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: newPassword, onChange: (event) => setNewPassword(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u786E\u8BA4\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: confirm, onChange: (event) => setConfirm(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: _jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: 'var(--dsw-alias-button-info-fill, #4d6bfe)', color: '#ffffff' }, children: "\u4FEE\u6539\u5BC6\u7801" }) })] })), notice?.owner === 'password' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: expanded === 'password' ? '12px 0 0' : '8px 0 0' }, children: notice.text }))] })] })), _jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u767B\u5F55\u8981\u6C42" }), _jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '0 0 12px' }, children: needsRegistration
                            ? '设置管理员账号后可启用此开关：启用后本机地址也要求登录。'
                            : loopbackLoginCheck === undefined
                                ? '正在读取登录要求…'
                                : '若启用，本机地址将要求登录，建议在多人共享服务器、需禁止同机其他账号免登录时启用。' }), _jsxs("label", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: loopbackLoginCheck === undefined ? 'default' : 'pointer', fontSize: 13 }, children: [_jsxs("span", { style: {
                                    position: 'relative',
                                    width: 40,
                                    height: 22,
                                    borderRadius: 11,
                                    background: loopbackLoginCheck === true ? 'var(--dsw-alias-button-info-fill, #4d6bfe)' : 'var(--dsw-alias-bg-overlay, #c4c4c4)',
                                    opacity: loopbackLoginCheck === undefined ? 0.5 : 1,
                                    transition: 'background 0.2s',
                                    flexShrink: 0,
                                }, children: [_jsx("input", { type: "checkbox", checked: loopbackLoginCheck === true, disabled: busy || loopbackLoginCheck === undefined, onChange: (event) => void toggleLoopbackLoginCheck(event.target.checked), style: { position: 'absolute', inset: 0, margin: 0, width: '100%', height: '100%', opacity: 0, cursor: 'inherit' } }), _jsx("span", { style: {
                                            position: 'absolute',
                                            top: 2,
                                            left: loopbackLoginCheck === true ? 20 : 2,
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            background: '#ffffff',
                                            transition: 'left 0.2s',
                                            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                                        } })] }), "\u672C\u673A\u767B\u5F55\u6821\u9A8C"] }), notice?.owner === 'policy' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u4EBA\u673A\u9A8C\u8BC1" }), _jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '0 0 12px' }, children: "\u5E94\u7F51\u53CB\u8981\u6C42\u52A0\u4E0A\u4E86\u6CA1\u4EC0\u4E48\u7528\u7684\u9632\u4EBA\u673A\u9A8C\u8BC1\uFF0C\u6709\u5174\u8DA3\u53EF\u4EE5\u5F00\u542F\u8BD5\u8BD5 XD" }), _jsxs("label", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: slideVerification === undefined ? 'default' : 'pointer', fontSize: 13 }, children: [_jsxs("span", { style: {
                                    position: 'relative',
                                    width: 40,
                                    height: 22,
                                    borderRadius: 11,
                                    background: slideVerification === true ? 'var(--dsw-alias-button-info-fill, #4d6bfe)' : 'var(--dsw-alias-bg-overlay, #c4c4c4)',
                                    opacity: slideVerification === undefined ? 0.5 : 1,
                                    transition: 'background 0.2s',
                                    flexShrink: 0,
                                }, children: [_jsx("input", { type: "checkbox", checked: slideVerification === true, disabled: busy || slideVerification === undefined, onChange: (event) => void toggleSlideVerification(event.target.checked), style: { position: 'absolute', inset: 0, margin: 0, width: '100%', height: '100%', opacity: 0, cursor: 'inherit' } }), _jsx("span", { style: {
                                            position: 'absolute',
                                            top: 2,
                                            left: slideVerification === true ? 20 : 2,
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            background: '#ffffff',
                                            transition: 'left 0.2s',
                                            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                                        } })] }), "\u767B\u5F55\u62FC\u56FE\u9A8C\u8BC1"] }), (needsRegistration || slideVerification === undefined) && (_jsx("p", { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '8px 0 0' }, children: needsRegistration ? '需先设置管理员账号才能开启。' : '正在读取设置…' })), notice?.owner === 'challenge' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: '12px 0 0' }, children: notice.text }))] }), !needsRegistration && (_jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #333)' }, children: "\u4F1A\u8BDD\u6709\u6548\u671F" }), _jsx("p", { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #666)', margin: '0 0 12px' }, children: "\u767B\u5F55\u540E\u4F1A\u8BDD cookie \u7684\u6709\u6548\u5929\u6570\u3002\u8C03\u6574\u540E\u5BF9\u65B0\u767B\u5F55\u7684\u4F1A\u8BDD\u751F\u6548\uFF0C\u5DF2\u767B\u5F55\u7684\u4F1A\u8BDD\u4E0D\u53D7\u5F71\u54CD\u3002" }), _jsxs("label", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }, children: ["\u6709\u6548\u671F", sessionMaxAgeDays === undefined ? (_jsx("span", { style: { color: 'var(--dsw-alias-label-tertiary, #666)' }, children: "\u6B63\u5728\u8BFB\u53D6\u2026" })) : (_jsx("select", { value: sessionMaxAgeDays, disabled: busy, onChange: (event) => void saveSessionMaxAge(Number(event.target.value)), style: { ...inputStyle, width: 'auto' }, children: SESSION_MAX_AGE_CHOICES.map((days) => (_jsxs("option", { value: days, children: [days, " \u5929"] }, days))) }))] }), notice?.owner === 'sessionMaxAge' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-state-error-primary, #d4380d)', margin: '8px 0 0' }, children: notice.text }))] }))] }));
}
/**
 * Register the auth section once the `settings.section` declaration is on
 * the ledger. The label is a plain string (no locale dependency).
 *
 * Note: 0.1.2 dropped the client-runtime aggregate type and the `slots`
 * Context member is not re-declared by any package we depend on, so the
 * service is read through a narrow structural assertion (cordis proxies the
 * property at runtime; the `inject` set above is what guarantees it).
 * @param ctx - client root context.
 */
export function apply(ctx) {
    const slots = ctx.slots;
    slots?.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 100,
        label: () => SECTION_LABEL,
    }, AuthSection));
    installAuthNavIcon();
}
