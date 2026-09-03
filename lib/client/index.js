import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from 'react';
/**
 * Services required before the main body can be mounted. The PRIMARY timing
 * guarantee comes from the node half (`src/auth.ts`): a script injected into
 * the SPA index wraps `window.__ModuleLoader__.load` and flips
 * `connection.isLoopback` to true the moment the connection plugin's apply
 * returns — before cordis notifies any dependent fiber — so the settings
 * mirror and every scope are built in host mode regardless of this plugin's
 * own activation order (bundle loads finish out of order). This root plugin
 * still injects only `connection` and repeats the override as a defensive
 * layer: cordis activates a fiber as soon as its inject set is ready, and
 * connection is the earliest service in the boot graph, so this apply runs
 * early enough to matter even if the injected hook was ever lost.
 */
export const inject = ['connection'];
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
/** The switch state shown in the tab (false until the policy fetch resolves). */
function useRequireLoopbackLogin() {
    const [requireLoopbackLogin, setRequireLoopbackLogin] = useState(false);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch('/api/auth/policy');
                if (!res.ok)
                    return;
                const data = (await res.json());
                if (!cancelled && typeof data.requireLoopbackLogin === 'boolean') {
                    setRequireLoopbackLogin(data.requireLoopbackLogin);
                }
            }
            catch {
                // Policy is best-effort; the tab still renders with the switch off.
            }
        })();
        return () => { cancelled = true; };
    }, []);
    return [requireLoopbackLogin, setRequireLoopbackLogin];
}
/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-username / change-password post to the auth endpoints and show the
 * outcome inline.
 */
export function AuthSection(props) {
    const [username, setUsername] = useUsername();
    const [requireLoopbackLogin, setRequireLoopbackLogin] = useRequireLoopbackLogin();
    const [newUsername, setNewUsername] = useState('');
    const [usernamePassword, setUsernamePassword] = useState('');
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(undefined);
    const [confirmingSignOut, setConfirmingSignOut] = useState(false);
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
    const toggleLoopbackLogin = useCallback(async (next) => {
        setBusy(true);
        try {
            const res = await fetch('/api/auth/policy', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requireLoopbackLogin: next }),
            });
            const data = (await res.json());
            if (res.ok) {
                setRequireLoopbackLogin(data.requireLoopbackLogin === true);
                flash({ kind: 'ok', text: next ? '已开启：本机访问也需要登录' : '已关闭：本机访问免登录', owner: 'policy' });
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
    }, [flash, setRequireLoopbackLogin]);
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
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 420 }, children: [_jsxs("section", { children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' }, children: "\u8D26\u53F7" }), _jsx("p", { style: { fontSize: 13, color: '#666', margin: '0 0 12px' }, children: username !== undefined ? `当前登录：${username}` : '当前登录：管理员' }), _jsxs("div", { style: { position: 'relative', display: 'inline-block' }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(true), disabled: busy, style: { ...buttonStyle, background: 'none', borderColor: '#d4380d', color: '#d4380d' }, children: "\u9000\u51FA\u767B\u5F55" }), confirmingSignOut && (_jsxs("div", { role: "alertdialog", "aria-label": "\u786E\u8BA4\u9000\u51FA\u767B\u5F55", style: {
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
                                        } }), _jsx("div", { style: { fontSize: 13, color: '#333', marginBottom: 10 }, children: "\u9000\u51FA\u767B\u5F55\u5C06\u56DE\u5230\u767B\u5F55\u9875" }), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 }, children: [_jsx("button", { type: "button", onClick: () => setConfirmingSignOut(false), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: 'none', borderColor: '#d9d9d9', color: '#333' }, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", onClick: () => void signOut(), disabled: busy, style: { ...buttonStyle, padding: '4px 12px', background: '#d4380d', color: '#ffffff' }, children: "\u786E\u8BA4\u9000\u51FA" })] })] }))] }), notice?.owner === 'account' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: '8px 0 0' }, children: notice.text }))] }), _jsxs("section", { children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 12px' }, children: "\u4FEE\u6539\u7528\u6237\u540D" }), _jsxs("form", { onSubmit: (event) => {
                            event.preventDefault();
                            void changeUsername();
                        }, style: { display: 'flex', flexDirection: 'column', gap: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u7528\u6237\u540D", _jsx("input", { type: "text", value: newUsername, onChange: (event) => setNewUsername(event.target.value), autoComplete: "username", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: usernamePassword, onChange: (event) => setUsernamePassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: [_jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: '#4d6bfe', color: '#ffffff' }, children: "\u4FEE\u6539\u7528\u6237\u540D" }), notice?.owner === 'username' && (_jsx("span", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d' }, children: notice.text }))] })] })] }), _jsxs("section", { children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 12px' }, children: "\u4FEE\u6539\u5BC6\u7801" }), _jsxs("form", { onSubmit: (event) => {
                            event.preventDefault();
                            void changePassword();
                        }, style: { display: 'flex', flexDirection: 'column', gap: 12 }, children: [_jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u5F53\u524D\u5BC6\u7801", _jsx("input", { type: "password", value: oldPassword, onChange: (event) => setOldPassword(event.target.value), autoComplete: "current-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: newPassword, onChange: (event) => setNewPassword(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsxs("label", { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }, children: ["\u786E\u8BA4\u65B0\u5BC6\u7801", _jsx("input", { type: "password", value: confirm, onChange: (event) => setConfirm(event.target.value), autoComplete: "new-password", style: inputStyle })] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: [_jsx("button", { type: "submit", disabled: busy, style: { ...buttonStyle, background: '#4d6bfe', color: '#ffffff' }, children: "\u4FEE\u6539\u5BC6\u7801" }), notice?.owner === 'password' && (_jsx("span", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d' }, children: notice.text }))] })] })] }), _jsxs("section", { children: [_jsx("h2", { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' }, children: "\u56DE\u73AF\u8BBF\u95EE" }), _jsx("p", { style: { fontSize: 13, color: '#666', margin: '0 0 12px' }, children: "\u5F00\u542F\u540E\uFF0C\u672C\u673A\uFF08localhost\uFF09\u8BBF\u95EE\u4E5F\u9700\u8981\u767B\u5F55\uFF0C\u4E0E\u8FDC\u7A0B\u5730\u5740\u4E00\u89C6\u540C\u4EC1" }), _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }, children: [_jsx("input", { type: "checkbox", checked: requireLoopbackLogin, disabled: busy, onChange: (event) => void toggleLoopbackLogin(event.target.checked) }), "\u672C\u673A\u8BBF\u95EE\u4E5F\u9700\u8981\u767B\u5F55"] }), notice?.owner === 'policy' && (_jsx("p", { style: { fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d', margin: '8px 0 0' }, children: notice.text }))] })] }));
}
/**
 * Register the auth section once the `settings.section` declaration is on
 * the ledger. The label is a plain string (no locale dependency).
 * @param ctx - client root context.
 */
export function apply(ctx) {
    // Remote browsers (address bar is a domain or LAN IP) are treated by the
    // DSH frontend as non-loopback: ui-settings builds its settings mirror in
    // memory mode and every `settingsScope.bind()` freezes its scope in memory
    // mode, so per-namespace consumers (plugin-configuration cards) never
    // derive any value and render nothing. The node half already treats a valid
    // session as loopback-equivalent (Host/Origin rewriting), so the browser
    // side is aligned here. The authoritative override is injected by the node
    // half (`src/auth.ts`) ahead of the module system, so mirror construction
    // and every bind() already see true; this apply re-applies it defensively
    // (idempotent) for cases where the injected hook did not run. A getter (not
    // a one-off assignment) keeps every later read true.
    const connection = ctx.get('connection');
    if (connection !== undefined) {
        Object.defineProperty(connection, 'isLoopback', {
            configurable: true,
            get: () => true,
        });
    }
    // The tab registration and the mirror guard need `slots`/`settingsScope`,
    // which are provided later in the boot. Declare them as a child plugin so
    // cordis activates this body exactly when they are ready.
    ctx.plugin({
        inject: ['slots', 'settingsScope'],
        apply: (sub) => {
            // Defensive fallback: if the mirror was somehow created in memory mode
            // (rc.8 introduced the shared `settingsScope.mirror`; rc.7 has no
            // mirror and skips), flip it back to host mode and read once. Note that
            // a host mirror alone cannot repair scopes that were already bound in
            // memory mode (they never subscribe to the mirror) — this guard only
            // helps surfaces that read the mirror directly (e.g. the models page).
            const scope = sub.get('settingsScope');
            const mirror = scope?.mirror;
            if (mirror !== undefined && mirror.persistence === 'memory' && typeof mirror.load === 'function') {
                mirror.persistence = 'host';
                void mirror.load();
            }
            sub.slots.inject('settings.section', () => sub.slots.register({
                name: 'settings.section',
                id: SECTION_ID,
                order: 100,
                label: () => '认证',
            }, AuthSection));
        },
    });
}
