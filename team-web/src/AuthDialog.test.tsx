import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, ApiError } from './api'
import { AuthDialog } from './AuthDialog'
import { Workspace } from './Workspace'
import { ReservationDetails } from './ReservationDetails'
import type { PreferencesState } from './preferences'
import type { Reservation, Resource, Session } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string, _en: string) => zh
const anonymous: Session = { user: null, csrfToken: 'anonymous-csrf', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const member: Session = { ...anonymous, user: { id: 'member-1', name: '测试成员', role: 'member', username: 'test-member' } }
const state: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const resource: Resource = { id: 'server-1', name: '同步 A100', cluster: '研发', gpuModel: 'A100', gpuCount: 1, notes: '', enabled: true, inventoryVersion: 3, inventoryState: 'synced', status: 'unknown', lastSeenAt: '2030-09-01T02:00:00Z', gpus: [{ id: 'stable-gpu', uuid: 'GPU-physical', index: 2, model: 'A100', memoryTotalMb: 81920 }] }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); window.history.replaceState({}, '', '/'); window.localStorage.clear() })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
function enter(name: string, value: string) { const field = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; expect(field).not.toBeNull(); act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(text: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
function mockCatalog() { vi.spyOn(api, 'resources').mockResolvedValue({ resources: [resource] }); return vi.spyOn(api, 'reservations').mockResolvedValue({ reservations: [] }) }

describe('username accounts and public browsing', () => {
  it('allows anonymous schedules without a mine request and requires sign-in for booking', async () => {
    const reservations = mockCatalog()
    await act(async () => root.render(<Workspace session={anonymous} state={state} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    expect(container.textContent).toContain('同步 A100')
    expect(container.textContent).toContain('状态未知')
    expect(container.textContent).toContain('80 GiB')
    expect(reservations.mock.calls.every(([options]) => !options?.mine)).toBe(true)
    expect(container.querySelector('nav')?.textContent).not.toContain('资源管理')
    await click('预约')
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('登录')
    expect(document.activeElement).toBe(container.querySelector('input[name="username"]'))
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('registers the fixed name and username or storing a password', async () => {
    const register = vi.spyOn(api, 'register').mockResolvedValue(member)
    const signedIn = vi.fn()
    await act(async () => root.render(<AuthDialog session={anonymous} t={t} onClose={vi.fn()} onSignedIn={signedIn} />))
    await click('注册账号')
    enter('username', ' test-member '); enter('name', '测试成员'); enter('password', 'safe-password-test')
    await submit()
    expect(register).toHaveBeenCalledWith({ username: 'test-member', name: '测试成员', password: 'safe-password-test' })
    expect(signedIn).toHaveBeenCalledWith(member)
    expect(container.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe('')
    expect(container.textContent).not.toContain('邮箱')
    expect(JSON.stringify(window.localStorage)).not.toContain('safe-password-test')
  })

  it('preserves username and reports credential failure without pretending the session expired', async () => {
    const login = vi.spyOn(api, 'login').mockRejectedValue(new ApiError('Invalid credentials', 401, 'INVALID_CREDENTIALS'))
    const signedIn = vi.fn()
    await act(async () => root.render(<AuthDialog session={anonymous} t={t} onClose={vi.fn()} onSignedIn={signedIn} />))
    enter('username', 'test-member'); enter('password', 'wrong-password')
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('用户名或密码不正确')
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('登录已过期')
    expect(container.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe('test-member')
    expect(login).toHaveBeenCalledWith({ username: 'test-member', password: 'wrong-password', rememberMe: true })
    expect(signedIn).not.toHaveBeenCalled()
  })

  it('resumes the same GPU reservation after username login', async () => {
    mockCatalog(); vi.spyOn(api, 'session').mockResolvedValue(anonymous); vi.spyOn(api, 'login').mockResolvedValue(member)
    await act(async () => root.render(<App />))
    await act(async () => container.querySelector<HTMLButtonElement>('.gpu-tile')!.click())
    enter('username', 'test-member'); enter('password', 'safe-password-test')
    await act(async () => container.querySelector('.dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('新建预约')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('同步 A100')
    expect(container.querySelector<HTMLInputElement>('.gpu-picker input:checked')?.parentElement?.textContent).toContain('GPU 2')
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
  })

  it('removes the setup code from the URL and sends it only with administrator registration', async () => {
    window.history.replaceState({}, '', '/#setup=test-bootstrap-secret')
    mockCatalog(); vi.spyOn(api, 'session').mockResolvedValue(anonymous)
    const register = vi.spyOn(api, 'register').mockResolvedValue(member)
    await act(async () => root.render(<App />))
    expect(window.location.hash).toBe('')
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('创建管理员账号')
    expect(container.textContent).not.toContain('test-bootstrap-secret')
    enter('username', 'test-admin'); enter('name', '管理员'); enter('password', 'safe-password-test')
    await act(async () => container.querySelector('.dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ bootstrapToken: 'test-bootstrap-secret' }))
    expect(JSON.stringify(window.localStorage)).not.toContain('test-bootstrap-secret')
  })

  it('does not display a private purpose or edit controls to a guest even with an older cached response', async () => {
    const reservation: Reservation = { id: 'booking', resourceId: resource.id, resourceName: resource.name, cluster: resource.cluster, ownerId: 'other', ownerName: '其他成员', scope: 'machine', gpuIndices: [], startAt: '2030-09-09T02:00:00Z', endAt: '2030-09-09T03:00:00Z', purpose: 'private-purpose', status: 'confirmed', createdAt: '', updatedAt: '', version: 1 }
    vi.spyOn(api, 'reservation').mockResolvedValue({ reservation })
    await act(async () => root.render(<ReservationDetails id="booking" user={null} locale="zh-CN" t={t} onClose={vi.fn()} onAction={vi.fn()} />))
    expect(container.textContent).toContain('其他成员')
    expect(container.textContent).not.toContain('private-purpose')
    expect(container.textContent).not.toContain('确认取消')
  })
})
