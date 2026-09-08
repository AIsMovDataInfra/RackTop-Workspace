import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { api, ACCOUNT_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from './api'
import { EquipmentWorkspace } from './EquipmentWorkspace'
import { MembersWorkspace } from './MembersWorkspace'
import { Workspace } from './Workspace'
import type { Session } from './types'

vi.mock('./Workspace', () => ({ Workspace: vi.fn(() => <div>预约工作台</div>) }))
vi.mock('./EquipmentWorkspace', () => ({ EquipmentWorkspace: vi.fn(() => <div>设备工作台</div>) }))
vi.mock('./MembersWorkspace', () => ({ MembersWorkspace: vi.fn(() => <div>成员管理工作台</div>) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const anonymous: Session = { user: null, csrfToken: 'test-csrf', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const pending: Session = { ...anonymous, user: { id: 'test-member', name: '待分配员工', username: '中', role: 'member', isSuperAdmin: false, company: null } }
const assigned: Session = { ...pending, user: { ...pending.user!, company: '西浦' } }
const superAdmin: Session = { ...pending, user: { ...pending.user!, id: 'super', role: 'admin', isSuperAdmin: true } }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  window.history.replaceState({}, '', '/'); window.localStorage.clear()
  vi.mocked(Workspace).mockImplementation(() => <div>预约工作台</div>)
  vi.mocked(EquipmentWorkspace).mockImplementation(() => <div>设备工作台</div>)
  vi.mocked(MembersWorkspace).mockImplementation(() => <div>成员管理工作台</div>)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
async function mount() { await act(async () => root.render(<App/>)) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }

it('does not mount any business workspace before a company is assigned, while settings and password change remain available', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(pending)
  await mount()
  expect(container.textContent).toContain('等待分配公司')
  expect(Workspace).not.toHaveBeenCalled(); expect(EquipmentWorkspace).not.toHaveBeenCalled(); expect(MembersWorkspace).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click())
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('账号与密码')
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('修改密码')
})

it('checks membership on focus and every 30 seconds, then resumes the untouched equipment deep link', async () => {
  vi.useFakeTimers()
  window.history.replaceState({}, '', '/equipment/fixed-device?from=qr')
  const session = vi.spyOn(api, 'session').mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValue(assigned)
  await mount()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(session).toHaveBeenCalledTimes(2)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(container.textContent).toContain('设备工作台')
  expect(EquipmentWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixed-device', session: assigned }), undefined)
  expect(window.location.pathname + window.location.search).toBe('/equipment/fixed-device?from=qr')
})

it('mounts the member directory only for the super administrator and never for ordinary admin roles', async () => {
  window.history.replaceState({}, '', '/members')
  const session = vi.spyOn(api, 'session').mockResolvedValue({ ...assigned, user: { ...assigned.user!, role: 'admin', isSuperAdmin: false } })
  const members = vi.spyOn(api, 'members')
  await mount()
  expect(container.textContent).toContain('预约工作台')
  expect(MembersWorkspace).not.toHaveBeenCalled(); expect(members).not.toHaveBeenCalled()
  session.mockResolvedValue(superAdmin)
  await act(async () => window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT)))
  expect(container.textContent).toContain('成员管理工作台')
})

it('immediately unloads business content on account changes, before the fresh session arrives', async () => {
  window.history.replaceState({}, '', '/equipment/fixed-device?from=qr')
  let resolve!: (value: Session) => void
  vi.spyOn(api, 'session').mockResolvedValueOnce(assigned).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await mount(); expect(container.textContent).toContain('设备工作台')
  await act(async () => window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT)))
  expect(container.textContent).not.toContain('设备工作台')
  await act(async () => resolve(pending))
  expect(container.textContent).toContain('等待分配公司')
  expect(window.location.pathname + window.location.search).toBe('/equipment/fixed-device?from=qr')
})

it('does not restore an older company response after a session expiry', async () => {
  let resolve!: (value: Session) => void
  vi.spyOn(api, 'session').mockResolvedValueOnce(pending).mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValueOnce(anonymous)
  await mount(); await click('刷新状态')
  await act(async () => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)))
  await act(async () => resolve(assigned))
  expect(container.querySelector('[name="username"]')).not.toBeNull()
  expect(Workspace).not.toHaveBeenCalled(); expect(EquipmentWorkspace).not.toHaveBeenCalled()
})
