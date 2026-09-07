import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { SettingsDialog } from './SettingsDialog'
import type { PreferencesState } from './preferences'
import type { Session } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const state: PreferencesState = { t: (zh: string) => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const session: Session = { user: { id: 'member', name: '测试成员', role: 'member', username: 'test-member' }, csrfToken: 'old-csrf', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
function enter(selector: string, value: string) { const field = container.querySelector<HTMLInputElement>(selector)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
it('uses the rotated session after a successful password change and clears password inputs', async () => {
  const rotated = { ...session, csrfToken: 'rotated-csrf' }
  const change = vi.spyOn(api, 'changePassword').mockResolvedValue(rotated), onSessionChanged = vi.fn()
  await act(async () => root.render(<SettingsDialog state={state} session={session} onClose={vi.fn()} onSessionChanged={onSessionChanged} />))
  enter('[autocomplete="current-password"]', 'old-password-test'); enter('[autocomplete="new-password"]', 'new-password-test')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(change).toHaveBeenCalledWith({ oldPassword: 'old-password-test', newPassword: 'new-password-test' })
  expect(onSessionChanged).toHaveBeenCalledWith(rotated)
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="password"]')].every((input) => input.value === '')).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('密码已更新')
})
it('reports the current password error without claiming a password change', async () => {
  vi.spyOn(api, 'changePassword').mockRejectedValue(new ApiError('Bad password', 401, 'INVALID_CREDENTIALS'))
  const onSessionChanged = vi.fn()
  await act(async () => root.render(<SettingsDialog state={state} session={session} onClose={vi.fn()} onSessionChanged={onSessionChanged} />))
  enter('[autocomplete="current-password"]', 'wrong-password'); enter('[autocomplete="new-password"]', 'new-password-test')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('当前密码不正确')
  expect(onSessionChanged).not.toHaveBeenCalled()
})
