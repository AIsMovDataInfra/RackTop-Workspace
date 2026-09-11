import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RequestWorkspace } from './RequestWorkspace'
import { api, ApiError } from './api'
import { workspaceApi } from './workspace-api'
import type { Equipment, Member, Session } from './types'
import type { PreferencesState } from './preferences'
import type { EquipmentRequest } from './workspace-types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2030-01-01T00:00:00Z'
const author: Member = { id: 'author', username: '成员', name: '李同学', role: 'member', company: 'A公司', isSuperAdmin: false, version: 1, createdAt: stamp, recoveryRequestedAt: null }
const admin: Member = { ...author, id: 'admin', name: '超级管理员', role: 'admin', isSuperAdmin: true }
const session: Session = { user: author, authMode: 'account', csrfToken: 'fixture', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const state: PreferencesState = { t: zh => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const equipment: Equipment = { id: 'equipment', code: 'code', serialNumber: '00000001', name: '测试夹爪', category: '夹爪', company: 'A公司', model: '', responsiblePerson: '负责人', currentUser: '', location: '上海', notes: '', status: 'available', photo: null, version: 1, createdAt: stamp, updatedAt: stamp }
const request: EquipmentRequest = { id: 'request', applicantId: author.id, applicantName: author.name, company: 'A公司', category: '夹爪', quantity: 1, purpose: '需要设备完成抓取测试', equipmentId: equipment.id, equipmentName: equipment.name, equipmentSerial: equipment.serialNumber, status: 'pending', decisionComment: '', equipmentUpdated: false, version: 1, createdAt: stamp, updatedAt: stamp }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const expired = vi.fn()
async function mount(user = author) { await act(async () => root.render(<RequestWorkspace session={{ ...session, user }} state={state} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired}/>)) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!; act(() => { const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function select(name: string, value: string) { act(() => { const input = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit() { await act(async () => container.querySelector('.work-request-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(api, 'equipment').mockResolvedValue({ equipment: [equipment, { ...equipment, id: 'other', company: 'B公司' }, { ...equipment, id: 'occupied', currentUser: '其他使用人' }, { ...equipment, id: 'maintenance', status: 'maintenance' }] }); vi.spyOn(workspaceApi, 'requests').mockResolvedValue({ requests: [request] }); vi.spyOn(workspaceApi, 'deviceRequest').mockResolvedValue({ request, history: [] }); expired.mockClear() })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

it('offers only available company equipment, locks linked quantity and confirms submission without fetching employee request history', async () => {
  const create = vi.spyOn(workspaceApi, 'createRequest').mockResolvedValue({ id: request.id, submitted: true })
  await mount(); expect(workspaceApi.requests).not.toHaveBeenCalled(); expect(workspaceApi.deviceRequest).not.toHaveBeenCalled()
  expect([...container.querySelectorAll<HTMLOptionElement>('[name="equipmentId"] option')].map(item => item.value)).toEqual(['', equipment.id])
  select('equipmentId', equipment.id)
  expect(container.querySelector<HTMLSelectElement>('[name="category"]')!.value).toBe('夹爪'); expect(container.querySelector<HTMLInputElement>('[name="quantity"]')!.disabled).toBe(true)
  enter('purpose', 'PRIVATE_REQUEST_TEXT'); await submit()
  expect(create).toHaveBeenCalledWith({ category: '夹爪', quantity: 1, purpose: 'PRIVATE_REQUEST_TEXT', equipmentId: equipment.id })
  expect(container.textContent).toContain('申请已提交'); expect(container.textContent).not.toContain('PRIVATE_REQUEST_TEXT'); expect(container.querySelector('[name="purpose"]')).toBeNull(); expect(workspaceApi.requests).not.toHaveBeenCalled()
  await click('继续提交申请'); expect(container.querySelector<HTMLTextAreaElement>('[name="purpose"]')!.value).toBe('')
})

it('submits an unlinked need with explicit category, quantity and immutable purpose', async () => {
  const create = vi.spyOn(workspaceApi, 'createRequest').mockResolvedValue({ id: request.id, submitted: true })
  await mount(); select('category', '摄像头模组'); enter('quantity', '3'); enter('purpose', '三路视觉采集'); await submit()
  expect(create).toHaveBeenCalledWith({ category: '摄像头模组', quantity: 3, purpose: '三路视觉采集', equipmentId: null })
})

it('shows Laptop in English requests while submitting the canonical Chinese category', async () => {
  const english: PreferencesState = { ...state, t: (_zh, en) => en, preferences: { ...state.preferences, locale: 'en' } }
  const create = vi.spyOn(workspaceApi, 'createRequest').mockResolvedValue({ id: request.id, submitted: true })
  const render = async (user = author) => act(async () => root.render(<RequestWorkspace session={{ ...session, user }} state={english} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired}/>))
  await render()
  const option = [...container.querySelectorAll<HTMLOptionElement>('[name="category"] option')].find(item => item.textContent === 'Laptop')
  expect(option?.value).toBe('笔记本电脑')
  select('category', option!.value); enter('purpose', 'Mobile development'); await submit()
  expect(create).toHaveBeenCalledWith({ category: '笔记本电脑', quantity: 1, purpose: 'Mobile development', equipmentId: null })
  const laptopRequest = { ...request, category: '笔记本电脑' }
  vi.mocked(workspaceApi.requests).mockResolvedValue({ requests: [laptopRequest] })
  vi.mocked(workspaceApi.deviceRequest).mockResolvedValue({ request: laptopRequest, history: [] })
  await render(admin)
  expect(container.querySelector('.work-request-section')?.textContent).toContain('Laptop × 1')
  await click('View request')
  expect(container.querySelector('.work-request-facts')?.textContent).toContain('Laptop × 1')
  expect(container.querySelector('.work-request-facts')?.textContent).not.toContain('笔记本电脑')
})

it('supports super administrator approval followed by atomic equipment collection and shows the preserved original request', async () => {
  const approved = { ...request, status: 'approved' as const, decisionComment: '批准使用', version: 2 }
  const collected = { ...approved, status: 'collected' as const, equipmentUpdated: true, version: 3 }
  const update = vi.spyOn(workspaceApi, 'updateRequest').mockResolvedValueOnce({ request: approved }).mockResolvedValueOnce({ request: collected })
  await mount(admin); expect(api.equipment).not.toHaveBeenCalled(); await click('查看申请')
  expect(container.textContent).toContain(request.purpose); expect(container.querySelector('.dialog [name="purpose"]')).toBeNull()
  enter('decisionComment', '批准使用'); await click('批准申请'); expect(update).toHaveBeenNthCalledWith(1, request.id, 1, 'approved', '批准使用')
  await click('登记已领取'); expect(update).toHaveBeenNthCalledWith(2, request.id, 2, 'collected', '批准使用')
  expect(container.textContent).toContain('关联设备台账已同步更新'); expect(container.textContent).not.toContain('登记已领取'); expect(container.textContent).toContain(request.purpose)
})

it('preserves decision notes after a concurrent update and requires explicitly loading the current version', async () => {
  vi.spyOn(workspaceApi, 'updateRequest').mockRejectedValueOnce(new ApiError('stale', 409, 'VERSION_CONFLICT'))
  await mount(admin); await click('查看申请'); enter('decisionComment', '我尚未保存的说明'); await click('批准申请')
  expect(container.querySelector<HTMLTextAreaElement>('[name="decisionComment"]')!.value).toBe('我尚未保存的说明'); expect(container.textContent).toContain('你的说明已保留')
  vi.mocked(workspaceApi.deviceRequest).mockResolvedValue({ request: { ...request, decisionComment: '其他管理员已经处理', status: 'approved', version: 2 }, history: [] })
  await click('载入最新记录（替换说明）'); expect(container.querySelector<HTMLTextAreaElement>('[name="decisionComment"]')!.value).toBe('其他管理员已经处理'); expect(container.textContent).toContain('登记已领取')
})

it.each([null, 'A公司'] as const)('keeps a super administrator with company %s in the review role without a personal request form', async (company) => {
  await mount({ ...admin, company }); expect(workspaceApi.requests).toHaveBeenCalledTimes(1); expect(api.equipment).not.toHaveBeenCalled(); expect(container.querySelector('.work-request-form')).toBeNull()
  expect(container.textContent).toContain('超级管理员无需提交自己的设备申请')
  await click('查看申请'); expect(container.textContent).toContain(request.purpose)
})

it('erases admin records on permission failure and ignores delayed responses after loss of super administrator access', async () => {
  vi.spyOn(workspaceApi, 'updateRequest').mockRejectedValue(new ApiError('forbidden', 403, 'SUPERADMIN_REQUIRED'))
  await mount(admin); await click('查看申请'); await click('批准申请'); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).not.toContain(request.purpose)
  let resolve!: (value: { requests: EquipmentRequest[] }) => void
  vi.mocked(workspaceApi.requests).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await mount({ ...admin, company: 'B公司' }); await mount(author); await act(async () => resolve({ requests: [{ ...request, applicantName: 'PRIVATE_ADMIN_RECORD' }] }))
  expect(container.textContent).not.toContain('PRIVATE_ADMIN_RECORD'); expect(container.querySelector('[aria-label="全部设备申请"]')).toBeNull()
})
