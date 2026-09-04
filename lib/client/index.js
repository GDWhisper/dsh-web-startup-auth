import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
// Inlined by tsdown (dependency-free constants module shared with the node half).
import { DEFAULT_SESSION_MAX_AGE_DAYS, SESSION_MAX_AGE_CHOICES } from "../session-limits.js";
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
/** How long a status/action message stays visible. */
const MESSAGE_MS = 5000;
/** The username shown in the tab (undefined until the status fetch resolves). */
function useUsername() {
    const [username, setUsername] = useState(undefined);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/auth/status');
                if (!res.ok)
                    return;
                const data = (await res.json());
                if (!cancelled && typeof data.username === 'string')
                    setUsername(data.username);
            }
            catch {
                // Status is best-effort; the tab still renders without a name.
            }
        })();
        return () => { cancelled = true; };
    }, []);
    return [username, setUsername];
}
/**
 * Tracks the "本机登录校验" switch shown in the tab. This maps 1:1 to the
 * backend flag `requireLoopbackLogin` (no inversion): ON = the loopback
 * address is also required to present a session. OUT OF THE BOX it is OFF
 * (loopback trusted = 本机免登录); it only flips ON on an explicit admin
 * action (e.g. a shared multi-user server).
 */
function useLoopbackLoginCheck() {
    const [loopbackLoginCheck, setLoopbackLoginCheck] = useState(false);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/auth/policy');
                if (!res.ok)
                    return;
                const data = (await res.json());
                if (!cancelled && typeof data.requireLoopbackLogin === 'boolean') {
                    setLoopbackLoginCheck(data.requireLoopbackLogin === true);
                }
            }
            catch {
                // Policy is best-effort; the tab still renders with the switch off.
            }
        })();
        return () => { cancelled = true; };
    }, []);
    return [loopbackLoginCheck, setLoopbackLoginCheck];
}
/**
 * Tracks the "会话有效期" selection shown in the tab. Maps to the persisted
 * `sessionMaxAgeDays` (see session-limits.ts for the selectable choices);
 * OUT OF THE BOX it is the 14-day default. Changing it only affects freshly
 * issued sessions — existing cookies keep the expiry baked in at sign time.
 */
function useSessionMaxAge() {
    const [days, setDays] = useState(DEFAULT_SESSION_MAX_AGE_DAYS);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/auth/session-max-age');
                if (!res.ok)
                    return;
                const data = (await res.json());
                if (!cancelled && typeof data.days === 'number') {
                    setDays(data.days);
                }
            }
            catch {
                // Best-effort; the tab still renders with the default selection.
            }
        })();
        return () => { cancelled = true; };
    }, []);
    return [days, setDays];
}
/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-username / change-password post to the auth endpoints and show the
 * outcome inline.
 */
export function AuthSection(props) {
    const [username, setUsername] = useUsername();
    const [loopbackLoginCheck, setLoopbackLoginCheck] = useLoopbackLoginCheck();
    const [sessionMaxAgeDays, setSessionMaxAgeDays] = useSessionMaxAge();
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
    }, [flash, setLoopbackLoginCheck]);
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
    const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        fontSize: 14,
        fontFamily: 'inherit',
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
        border: '1px solid #e5e5e5',
        borderRadius: 10,
        padding: '18px 20px',
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
    };
    /** Text-button look used to expand/collapse the username / password forms. */
    const linkStyle = {
        background: 'none',
        border: 'none',
        color: '#4d6bfe',
        fontSize: 13,
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit',
    };
    /** Accordion chevron drawn as a symmetric SVG so it rotates about its true
     * visual center (a border-drawn chevron's mass sits at the corner, which
     * drifts when rotated around the box center). */
    const Chevron = ({ up }) => (_jsx("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, style: { transform: up ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease', transformOrigin: 'center' }, children: _jsx("path", { d: "M3 5 L7 9 L11 5", fill: "none", stroke: "#333", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }) }));
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 460 }, children: [_jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' }, children: "\u8D26\u53F7" }), _jsx("p", { style: { fontSize: 13, color: '#666', margin: '0 0 12px' }, children: username !== undefined ? `当前登录：${username}` : '当前登录：管理员' }), _jsxs("div", { style: { position: 'relative', display: 'inline-block' }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(true), disabled: busy, style: { ...buttonStyle, background: 'none', borderColor: '#d4380d', color: '#d4380d' }, children: "\u9000\u51FA\u767B\u5F55" }), confirmingSignOut && (_jsxs("div", { role: "alertdialog", "aria-label": "\u786E\u8BA4\u9000\u51FA\u767B\u5F55", style: {
                                    position: 'absolute',
                                    top: 'calc(100% + 10px)',
                                    left: 0,
                                    zIndex: 10,
                                    minWidth: 260,
                                    padding: '12px 14px',
                                    background: '#ffffff',
                                    border: '1px solid #e5e5e5',
                                    borderRadius: 8,
                                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
                                }, children: [_jsx("div", { "aria-hidden": true, style: {
                                            position: 'absolute',
                                            top: -6,
                                            left: 28,
                                            width: 10,
                                            height: 10,
                                            background: '#ffffff',
                                            borderLeft: '1px solid #e5e5e5',
                                            borderTop: '1px solid #e5e5e5',
                                            transform: 'rotate(45deg)',
                                        } }), _jsx("div", { style: { fontSize: 13, color: '#333', marginBottom: 10 }, children: "\u9000\u51FA\u767B\u5F55\u5C06\u56DE\u5230\u767B\u5F55\u9875" }), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(false), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: 'none', borderColor: '#d9d9d9', color: '#333' }, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", onClick: () => void signOut(), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: '#d4380d', color: '#ffffff' }, children: "\u786E\u8BA4\u9000\u51FA" })] })] }))] }), notice?.owner === 'account' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: 0 }, children: "\u4FEE\u6539\u7528\u6237\u540D" }), _jsx("button", { type: "button", onClick: () => setExpanded(expanded === 'username' ? null : 'username'), disabled: busy, "aria-label": expanded === 'username' ? '收起' : '修改用户名', "aria-expanded": expanded === 'username', style: { ...linkStyle, padding: 12, margin: -12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx(Chevron, { up: expanded === 'username' }) })] }), expanded === 'username' && (_jsxs("form", { onSubmit: (event) => {
                            event.preventDefault();
                            void changeUsername();
                        }, style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u7528\u6237\u540D", _jsx("input", { type: "text", value: newUsername, onChange: (event) => setNewUsername(event.target.value), autoComplete: "username", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: usernamePassword, onChange: (event) => setUsernamePassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: _jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: '#4d6bfe', color: '#ffffff' }, children: "\u4FEE\u6539\u7528\u6237\u540D" }) })] })), notice?.owner === 'username' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: expanded === 'username' ? '12px 0 0' : '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: 0 }, children: "\u4FEE\u6539\u5BC6\u7801" }), _jsx("button", { type: "button", onClick: () => setExpanded(expanded === 'password' ? null : 'password'), disabled: busy, "aria-label": expanded === 'password' ? '收起' : '修改密码', "aria-expanded": expanded === 'password', style: { ...linkStyle, padding: 12, margin: -12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, children: _jsx(Chevron, { up: expanded === 'password' }) })] }), expanded === 'password' && (_jsxs("form", { onSubmit: (event) => {
                            event.preventDefault();
                            void changePassword();
                        }, style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: oldPassword, onChange: (event) => setOldPassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: newPassword, onChange: (event) => setNewPassword(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u786E\u8BA4\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: confirm, onChange: (event) => setConfirm(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: _jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: '#4d6bfe', color: '#ffffff' }, children: "\u4FEE\u6539\u5BC6\u7801" }) })] })), notice?.owner === 'password' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: expanded === 'password' ? '12px 0 0' : '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' }, children: "\u767B\u5F55\u8981\u6C42" }), _jsx("p", { style: { fontSize: 13, color: '#666', margin: '0 0 12px' }, children: "\u82E5\u542F\u7528\uFF0C\u672C\u673A\u5730\u5740\u5C06\u8981\u6C42\u767B\u5F55\uFF0C\u5EFA\u8BAE\u5728\u591A\u4EBA\u5171\u4EAB\u670D\u52A1\u5668\u3001\u9700\u7981\u6B62\u540C\u673A\u5176\u4ED6\u8D26\u53F7\u514D\u767B\u5F55\u65F6\u542F\u7528\u3002" }), _jsxs("label", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }, children: [_jsxs("span", { style: {
                                    position: 'relative',
                                    width: 40,
                                    height: 22,
                                    borderRadius: 11,
                                    background: loopbackLoginCheck ? '#4d6bfe' : '#c4c4c4',
                                    transition: 'background 0.2s',
                                    flexShrink: 0,
                                }, children: [_jsx("input", { type: "checkbox", checked: loopbackLoginCheck, disabled: busy, onChange: (event) => void toggleLoopbackLoginCheck(event.target.checked), style: { position: 'absolute', inset: 0, margin: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' } }), _jsx("span", { style: {
                                            position: 'absolute',
                                            top: 2,
                                            left: loopbackLoginCheck ? 20 : 2,
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            background: '#ffffff',
                                            transition: 'left 0.2s',
                                            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
                                        } })] }), "\u672C\u673A\u767B\u5F55\u6821\u9A8C"] }), notice?.owner === 'policy' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { style: cardStyle, children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' }, children: "\u4F1A\u8BDD\u6709\u6548\u671F" }), _jsx("p", { style: { fontSize: 13, color: '#666', margin: '0 0 12px' }, children: "\u767B\u5F55\u540E\u4F1A\u8BDD cookie \u7684\u6709\u6548\u5929\u6570\u3002\u8C03\u6574\u540E\u5BF9\u65B0\u767B\u5F55\u7684\u4F1A\u8BDD\u751F\u6548\uFF0C\u5DF2\u767B\u5F55\u7684\u4F1A\u8BDD\u4E0D\u53D7\u5F71\u54CD\u3002" }), _jsxs("label", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }, children: ["\u6709\u6548\u671F", _jsx("select", { value: sessionMaxAgeDays, disabled: busy, onChange: (event) => void saveSessionMaxAge(Number(event.target.value)), style: { ...inputStyle, width: 'auto' }, children: SESSION_MAX_AGE_CHOICES.map((days) => (_jsxs("option", { value: days, children: [days, " \u5929"] }, days))) })] }), notice?.owner === 'sessionMaxAge' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: '8px 0 0' }, children: notice.text }))] })] }));
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
        label: () => '认证',
    }, AuthSection));
}
