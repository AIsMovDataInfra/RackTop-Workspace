import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MembersWorkspace } from './MembersWorkspace'
import { api, ApiError } from './api'
import type { Member, Session } from './types'
import type { PreferencesState } from './preferences'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const employee: Member = { id: 'employee', username: '中', name: '李同学', role: 'member', company: null, isSuperAdmin: false, version: 1, createdAt: '2030-01-01T00:00:00Z', recoveryRequestedAt: '2030-01-02T00:00:00Z' }
const admin: Member = { ...employee, id: 'admin', username: 'fixture-admin', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: '西浦', recoveryRequestedAt: null }
const session: Session = { user: admin, authMode: 'account', csrfToken: 'fixture', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const state: PreferencesState = { t: (zh) => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const expired = vi.fn()
async function mount(user = admin) { await act(async () => root.render(<MembersWorkspace session={{ ...session, user }} state={state} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired} />)) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === text || item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function select(value: string) { act(() => container.querySelector<HTMLInputElement>(`input[name="companies"][value="${value}"]`)!.click()) }
async function submit() { await act(async () => container.querySelector('.dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(api, 'members').mockResolvedValue({ members: [admin, employee] }); expired.mockClear() })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

it('does not fetch or render the roster for ordinary admins, and erases it when permission changes', async () => {
  await mount({ ...admin, isSuperAdmin: false }); expect(api.members).not.toHaveBeenCalled(); expect(container.textContent).toBe('')
  await mount(); expect(container.textContent).toContain(employee.name)
  await mount({ ...admin, isSuperAdmin: false }); expect(container.textContent).toBe('')
})
it.each([null, '西浦'] as const)('keeps super administrators with company %s global and out of employee company filters', async (company) => {
  const globalAdmin = { ...admin, company }
  const assigned = { ...employee, id: 'assigned', name: '已分配员工', username: 'assigned', company: '西浦' as const }
  const update = vi.spyOn(api, 'setMemberCompanies')
  vi.mocked(api.members).mockResolvedValue({ members: [globalAdmin, employee, assigned] })
  await mount(globalAdmin)
  const rows = () => [...container.querySelectorAll<HTMLTableRowElement>('.member-table tbody tr')]
  const superRow = rows().find((row) => row.cells[0].textContent?.includes(admin.name))!
  expect(superRow.cells[1].textContent).toBe('跨公司管理，无需分配公司')
  expect(superRow.querySelector('button')).toBeNull()
  expect(container.querySelector(`[aria-label="分配公司 · ${employee.name}"]`)).not.toBeNull()
  const filter = (value: string) => act(() => {
    const input = container.querySelector<HTMLSelectElement>('.member-filters select')!
    input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  filter('pending')
  expect(rows()).toHaveLength(1)
  expect(rows()[0].cells[0].textContent).toContain(employee.name)
  expect(container.querySelector('.member-directory-heading strong')?.textContent).toBe('成员 1')
  filter('西浦')
  expect(rows()).toHaveLength(1)
  expect(rows()[0].cells[0].textContent).toContain(assigned.name)
  filter('')
  act(() => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '西浦')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(rows()).toHaveLength(1)
  expect(rows()[0].cells[0].textContent).toContain(assigned.name)
  expect(update).not.toHaveBeenCalled()
  expect(globalAdmin.company).toBe(company)
})
it('supports single-character Chinese credentials, fixed company choices and clears the password after creating', async () => {
  const create = vi.spyOn(api, 'createMember').mockResolvedValue({ member: { ...employee, id: 'new', name: '名', company: 'A公司' } })
  await mount(); await click('增加员工'); enter('name', '名'); enter('password', '密'); select('A公司')
  expect([...container.querySelectorAll<HTMLInputElement>('input[name="companies"]')].map(input => input.value)).toEqual(['A公司', 'B公司', 'C公司', '西浦'])
  await submit(); expect(create).toHaveBeenCalledWith({ name: '名', password: '密', companies: ['A公司'] }); expect(container.querySelector('input[type="password"]')).toBeNull()
})
it('creates long Chinese and English member names without a length gate or accent normalization', async () => {
  const create = vi.spyOn(api, 'createMember').mockImplementation(async (value) => ({ member: { ...employee, id: value.name, name: value.name, company: value.companies[0], companies: value.companies } }))
  await mount()
  for (const name of ['Member中文 + @.'.repeat(100), 'Cafe\u0301员工']) {
    await click('增加员工'); enter('name', name); enter('password', '密'); select('A公司')
    const input = container.querySelector<HTMLInputElement>('input[name="name"]')!
    for (const attr of ['minlength', 'maxlength', 'pattern']) expect(input.hasAttribute(attr)).toBe(false)
    expect(container.querySelector<HTMLFormElement>('.dialog form')!.checkValidity()).toBe(true)
    await submit(); expect(create).toHaveBeenLastCalledWith({ name, password: '密', companies: ['A公司'] })
  }
})
it('shows recovery requests and resets with a version without exposing passwords in notices', async () => {
  const reset = vi.spyOn(api, 'resetMemberPassword').mockResolvedValue({ member: { ...employee, version: 2, recoveryRequestedAt: null } })
  await mount(); expect(container.textContent).toContain('待处理'); await click(`重置密码 · ${employee.name}`); enter('password', 'private-fixture-secret'); await submit()
  expect(reset).toHaveBeenCalledWith(employee, 'private-fixture-secret'); expect(container.textContent).toContain('旧会话已退出'); expect(container.textContent).not.toContain('private-fixture-secret'); expect(container.textContent).not.toContain('待处理')
})
it('requires a second explicit submit after a concurrent company change and preserves the selected company', async () => {
  const latest = { ...employee, version: 2, company: 'B公司' as const }
  const update = vi.spyOn(api, 'setMemberCompanies').mockRejectedValueOnce(new ApiError('changed', 409, 'VERSION_CONFLICT')).mockResolvedValue({ member: { ...latest, version: 3, company: '西浦' } })
  await mount(); await click(`分配公司 · ${employee.name}`); select('西浦'); vi.mocked(api.members).mockResolvedValue({ members: [admin, latest] }); await submit()
  expect(update).toHaveBeenCalledTimes(1); expect(container.querySelector<HTMLInputElement>('input[name="companies"][value="西浦"]')!.checked).toBe(true); expect(container.textContent).toContain('你的输入已保留'); await submit(); expect(update).toHaveBeenLastCalledWith(latest, ['西浦'])
})
it('confirms employee deletion while never offering a superadmin delete or reset action', async () => {
  const remove = vi.spyOn(api, 'deleteMember').mockResolvedValue({ ok: true })
  await mount(); expect(container.querySelector(`[aria-label="删除账号 · ${admin.name}"]`)).toBeNull(); expect(container.querySelector(`[aria-label="重置密码 · ${admin.name}"]`)).toBeNull()
  await click(`删除账号 · ${employee.name}`); expect(remove).not.toHaveBeenCalled(); expect(container.textContent).toContain('历史预约、设备与登记记录保留'); await submit(); expect(remove).toHaveBeenCalledWith(employee); expect(container.querySelector('.member-table')!.textContent).not.toContain(employee.name)
})
it('erases member details and draft passwords immediately when the server denies access', async () => {
  vi.spyOn(api, 'resetMemberPassword').mockRejectedValue(new ApiError('forbidden', 403, 'SUPERADMIN_REQUIRED'))
  await mount(); await click(`重置密码 · ${employee.name}`); enter('password', 'fixture'); await submit(); expect(container.textContent).not.toContain(employee.name); expect(container.querySelector('input[type="password"]')).toBeNull(); expect(container.querySelector('.member-table')).toBeNull()
})
it('ignores a delayed roster after superadmin permission is removed', async () => {
  let resolve!: (value: { members: Member[] }) => void
  vi.mocked(api.members).mockImplementation(() => new Promise((done) => { resolve = done }))
  await mount(); await mount({ ...admin, isSuperAdmin: false }); await act(async () => resolve({ members: [employee] })); expect(container.textContent).toBe('')
})

it('assigns multiple organizations and includes a member when filtering by a secondary organization', async () => {
  const multi = { ...employee, company: 'A公司' as const, companies: ['A公司', '西浦'] as const }
  const update = vi.spyOn(api, 'setMemberCompanies').mockResolvedValue({ member: { ...multi, companies: [...multi.companies], version: 2 } })
  await mount(); await click(`分配公司 · ${employee.name}`); select('A公司'); select('西浦'); await submit()
  expect(update).toHaveBeenCalledWith(employee, ['A公司', '西浦'])
  expect(container.querySelector('.member-table')!.textContent).toContain('A公司、西浦')
  act(() => { const input = container.querySelector<HTMLSelectElement>('.member-filters select')!; input.value = '西浦'; input.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelectorAll('.member-table tbody tr')).toHaveLength(1)
  expect(container.querySelector('.member-table tbody')!.textContent).toContain(employee.name)
})
it('permits removing all memberships with a visible explanation and keeps the account', async () => {
  const assigned = { ...employee, company: 'A公司' as const, companies: ['A公司' as const] }
  vi.mocked(api.members).mockResolvedValue({ members: [assigned, admin] })
  const update = vi.spyOn(api, 'setMemberCompanies').mockResolvedValue({ member: { ...employee, companies: [], version: 2 } })
  await mount(); await click(`分配公司 · ${employee.name}`); select('A公司')
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain('取消全部归属后')
  await submit(); expect(update).toHaveBeenCalledWith(assigned, [])
  expect(container.querySelector('.member-table')!.textContent).toContain(employee.name)
})
