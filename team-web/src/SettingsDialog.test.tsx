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

it('accepts a short Chinese new password, preserves spaces and rejects only blank new input', async () => {
  const change = vi.spyOn(api, 'changePassword').mockResolvedValue(session)
  await act(async () => root.render(<SettingsDialog state={state} session={session} onClose={vi.fn()} />))
  enter('[autocomplete="current-password"]', ' '.repeat(12)); enter('[autocomplete="new-password"]', '   ')
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(change).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('请输入密码')
  enter('[autocomplete="new-password"]', ' 密 ')
  expect(container.querySelector<HTMLFormElement>('form')!.checkValidity()).toBe(true)
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(change).toHaveBeenCalledWith({ oldPassword: ' '.repeat(12), newPassword: ' 密 ' })
  expect(container.querySelector('input[minlength], input[maxlength], input[pattern]')).toBeNull()
})

it('saves only an allowlisted icon while showing the member company as read-only', async () => {
  const account = { ...session, user: { ...session.user!, company: '西浦' as const, version: 1, avatar: 'user' } }
  const updated = { ...account, user: { ...account.user, avatar: 'cat', version: 2 } }
  const save = vi.spyOn(api, 'updateProfile').mockResolvedValue(updated), onSessionChanged = vi.fn()
  await act(async () => root.render(<SettingsDialog state={state} session={account} onClose={vi.fn()} onSessionChanged={onSessionChanged} />))
  expect(container.textContent).toContain('公司：西浦（由超级管理员管理）')
  expect(container.querySelector('select[name="company"],input[name="company"],input[type="file"]')).toBeNull()
  expect(container.querySelectorAll('.member-avatar-picker button')).toHaveLength(24)
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="猫"]')!.click())
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存头像')!.click())
  expect(save).toHaveBeenCalledWith({ version: 1, avatar: 'cat' })
  expect(onSessionChanged).toHaveBeenCalledWith(updated)
  expect(container.querySelector('button[aria-label="猫"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('头像已保存')
})

it.each([null, '西浦'] as const)('shows a super administrator with company %s as global in both languages', async (company) => {
  const account: Session = { ...session, user: { ...session.user!, role: 'admin', isSuperAdmin: true, company } }
  const save = vi.spyOn(api, 'setMemberCompany')
  await act(async () => root.render(<SettingsDialog state={state} session={account} onClose={vi.fn()} />))
  expect(container.querySelector('.member-company-readonly')?.textContent).toBe('跨公司管理，无需分配公司')
  expect(container.querySelector('.member-company-readonly')?.textContent).not.toMatch(/待分配|由超级管理员管理|西浦/)
  const english: PreferencesState = { ...state, preferences: { ...state.preferences, locale: 'en' }, t: (_zh, en) => en }
  await act(async () => root.render(<SettingsDialog state={english} session={account} onClose={vi.fn()} />))
  expect(container.querySelector('.member-company-readonly')?.textContent).toBe('Cross-company management; no company assignment needed')
  expect(container.querySelector('select[name="company"],input[name="company"]')).toBeNull()
  expect(save).not.toHaveBeenCalled()
  expect(account.user?.company).toBe(company)
})

it('saves a new colorful avatar and restores it when account settings reopen', async () => {
  const account = { ...session, user: { ...session.user!, version: 1, avatar: 'robot' } }
  const updated = { ...account, user: { ...account.user, version: 2, avatar: 'satellite' } }
  const save = vi.spyOn(api, 'updateProfile').mockResolvedValue(updated)
  await act(async () => root.render(<SettingsDialog state={state} session={account} onClose={vi.fn()} />))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="卫星"]')!.click())
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存头像')!.click())
  expect(save).toHaveBeenCalledWith({ version: 1, avatar: 'satellite' })
  await act(async () => root.render(null))
  await act(async () => root.render(<SettingsDialog state={state} session={updated} onClose={vi.fn()} />))
  expect(container.querySelector('button[aria-label="卫星"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('.member-account-summary [data-avatar="satellite"]')).not.toBeNull()
  expect([...container.querySelectorAll('button')].find(button => button.textContent === '保存头像')).toHaveProperty('disabled', true)
})

it('retains the chosen avatar after a profile conflict and uses the refreshed version on an explicit retry', async () => {
  const account = { ...session, user: { ...session.user!, company: '西浦' as const, version: 1, avatar: 'user' } }
  const latest = { ...account, user: { ...account.user, company: 'B公司' as const, version: 2, avatar: 'robot' } }
  const save = vi.spyOn(api, 'updateProfile').mockRejectedValueOnce(new ApiError('changed', 409, 'VERSION_CONFLICT')).mockResolvedValue({ ...latest, user: { ...latest.user, avatar: 'cat', version: 3 } })
  vi.spyOn(api, 'session').mockResolvedValue(latest)
  await act(async () => root.render(<SettingsDialog state={state} session={account} onClose={vi.fn()} />))
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="猫"]')!.click())
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存头像')!.click())
  expect(save).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('头像选择已保留')
  expect(container.textContent).toContain('公司：B公司')
  expect(container.querySelector('button[aria-label="猫"]')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存头像')!.click())
  expect(save).toHaveBeenLastCalledWith({ version: 2, avatar: 'cat' })
})
