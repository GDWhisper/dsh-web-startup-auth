/**
 * Auth settings tab, browser half.
 *
 * Registers the "认证" section into the settings panel (`settings.section`
 * slot) with two actions: sign out and change password. Both ride the
 * existing `/api/auth/*` endpoints served by the node half (`src/auth.ts`);
 * the tab itself performs no RPC, so it depends only on the `slots` service.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'

/** Services required before the auth tab can be mounted. */
export const inject = ['slots']

/** Stable registration id inside the settings section list. */
const SECTION_ID = 'auth'

/** How long a status/action message stays visible. */
const MESSAGE_MS = 5000

/** The username shown in the tab (undefined until the status fetch resolves). */
function useUsername(): string | undefined {
  const [username, setUsername] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/status')
        if (!res.ok) return
        const data = (await res.json()) as { username?: string }
        if (!cancelled && typeof data.username === 'string') setUsername(data.username)
      } catch {
        // Status is best-effort; the tab still renders without a name.
      }
    })()
    return () => { cancelled = true }
  }, [])
  return username
}

/** Transient message state (kind drives the message color). */
type Notice = { kind: 'ok' | 'error'; text: string }

/**
 * The settings tab content. Sign-out navigates back to the login page;
 * change-password posts to the auth endpoint and shows the outcome inline.
 */
export function AuthSection(props: PropsRuntime<'settings.section'>): ReactElement {
  const username = useUsername()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  const flash = useCallback((notice: Notice | undefined) => {
    setNotice(notice)
    if (notice !== undefined) {
      setTimeout(() => setNotice(undefined), MESSAGE_MS)
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      window.location.href = '/login'
    } catch {
      setBusy(false)
      setConfirmingSignOut(false)
      flash({ kind: 'error', text: '退出失败，请重试' })
    }
  }, [flash])

  const changePassword = useCallback(async () => {
    if (newPassword !== confirm) {
      flash({ kind: 'error', text: '两次输入的新密码不一致' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = (await res.json()) as { error?: string }
      if (res.ok) {
        setOldPassword('')
        setNewPassword('')
        setConfirm('')
        flash({ kind: 'ok', text: '密码已修改' })
      } else {
        flash({ kind: 'error', text: data.error ?? '修改失败，请重试' })
      }
    } catch {
      flash({ kind: 'error', text: '修改失败，请重试' })
    } finally {
      setBusy(false)
    }
  }, [oldPassword, newPassword, confirm, flash])

  const inputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    border: '1px solid #d9d9d9',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'inherit',
  }
  const buttonStyle: CSSProperties = {
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 14,
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: '1px solid transparent',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 420 }}>
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>账号</h2>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 12px' }}>
          {username !== undefined ? `当前登录：${username}` : '当前登录：管理员'}
        </p>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button
            type="button"
            onClick={() => setConfirmingSignOut(true)}
            disabled={busy}
            style={{ ...buttonStyle, background: 'none', borderColor: '#d4380d', color: '#d4380d' }}
          >
            退出登录
          </button>
          {confirmingSignOut && (
            <div
              role="alertdialog"
              aria-label="确认退出登录"
              style={{
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
              }}
            >
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: -6,
                  left: 28,
                  width: 10,
                  height: 10,
                  background: '#ffffff',
                  borderLeft: '1px solid #e5e5e5',
                  borderTop: '1px solid #e5e5e5',
                  transform: 'rotate(45deg)',
                }}
              />
              <div style={{ fontSize: 13, color: '#333', marginBottom: 10 }}>
                退出登录将回到登录页
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setConfirmingSignOut(false)}
                  disabled={busy}
                  style={{ ...buttonStyle, padding: '4px 12px', background: 'none', borderColor: '#d9d9d9', color: '#333' }}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={busy}
                  style={{ ...buttonStyle, padding: '4px 12px', background: '#d4380d', color: '#ffffff' }}
                >
                  确认退出
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px' }}>修改密码</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void changePassword()
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            当前密码
            <input
              type="password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              autoComplete="current-password"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            新密码
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            确认新密码
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="submit"
              disabled={busy}
              style={{ ...buttonStyle, background: '#4d6bfe', color: '#ffffff' }}
            >
              修改密码
            </button>
            {notice !== undefined && (
              <span style={{ fontSize: 13, color: notice.kind === 'ok' ? '#237804' : '#d4380d' }}>
                {notice.text}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  )
}

/**
 * Register the auth section once the `settings.section` declaration is on
 * the ledger. The label is a plain string (no locale dependency).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 100,
    label: () => '认证',
  }, AuthSection))
}
