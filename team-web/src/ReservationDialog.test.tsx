import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { ReservationDialog, RenewalDialog } from './ReservationDialog'
import { ReservationDetails } from './ReservationDetails'
import { Workspace } from './Workspace'
import type { PreferencesState } from './preferences'
import type { Reservation, Resource, Session } from './types'
import { initialWindow, inputToIso } from './time'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string, _en: string) => zh
const resource: Resource = { id: 'server-1', name: '测试服务器', cluster: '测试集群', gpuModel: 'A100', gpuCount: 4, notes: '', enabled: true }
const reservation: Reservation = { id: 'reservation-1', resourceId: resource.id, resourceName: resource.name, cluster: resource.cluster, ownerId: 'other-member', ownerName: '其他成员', scope: 'gpus', gpuIndices: [1], startAt: '2030-09-09T02:00:00Z', endAt: '2030-09-09T03:00:00Z', purpose: '已有预约用途', status: 'confirmed', createdAt: '2030-09-01T02:00:00Z', updatedAt: '2030-09-01T02:00:00Z', version: 3 }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); window.history.replaceState({}, '', '/') })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

async function click(text: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text); expect(button, text).toBeDefined(); await act(async () => button!.click()) }
function enter(selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }

describe('reservation interactions', () => {
  it('permits a future whole-machine booking for a busy CPU resource without carrying a stale GPU selection', async () => {
    const reserve = vi.spyOn(api, 'reserve').mockResolvedValue({ reservation })
    const cpu: Resource = { ...resource, gpuCount: 0, gpuModel: '', usage: { state: 'busy', observedAt: new Date().toISOString(), gpus: [] } }
    await act(async () => root.render(<ReservationDialog resource={cpu} initialGpu={3} start="2030-09-09T10:00" end="2030-09-09T11:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />))
    expect(container.querySelector('.resource-usage-state')?.textContent).toBe('被占用')
    expect(container.textContent).toContain('匿名用户')
    expect(container.querySelector('input[value="gpus"]')).toBeNull()
    expect(container.querySelector('.gpu-picker')).toBeNull()
    enter('textarea', '明天整机计算任务')
    await submit()
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ resourceId: cpu.id, scope: 'machine', gpuIndices: [], startAt: '2030-09-09T02:00:00.000Z' }))
  })

  it('keeps the full draft when a 409 is returned and shows the conflicting member and slot', async () => {
    const reserve = vi.spyOn(api, 'reserve').mockRejectedValue(new ApiError('GPU 1 已被预约', 409, 'CONFLICT', [reservation]))
    const onSaved = vi.fn()
    await act(async () => root.render(<ReservationDialog resource={resource} initialGpu={1} start="2030-09-09T10:00" end="2030-09-09T11:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={onSaved} />))
    enter('textarea', '我自己的新训练任务')
    await submit()
    expect(reserve).toHaveBeenCalledWith({ resourceId: resource.id, scope: 'gpus', gpuIndices: [1], startAt: '2030-09-09T02:00:00.000Z', endAt: '2030-09-09T03:00:00.000Z', purpose: '我自己的新训练任务', requestId: expect.any(String) })
    expect(container.querySelector('textarea')!.value).toBe('我自己的新训练任务')
    expect(container.querySelector<HTMLInputElement>('[aria-label="开始时间"]')!.value).toBe('2030-09-09T10:00')
    expect(container.querySelector<HTMLInputElement>('.gpu-picker input:checked')?.parentElement?.textContent).toBe('GPU 1')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('其他成员')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('输入已保留')
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('uses stable GPU identities and keeps a request ID across an uncertain network retry', async () => {
    const reserve = vi.spyOn(api, 'reserve').mockRejectedValue(new TypeError('Network error'))
    const synced: Resource = { ...resource, inventoryVersion: 4, inventoryState: 'synced', gpuCount: 1, gpus: [{ id: 'gpu-stable', uuid: 'GPU-physical', index: 7, model: 'A100', memoryTotalMb: 81920 }] }
    await act(async () => root.render(<ReservationDialog resource={synced} initialGpu={7} start="2030-09-09T10:00" end="2030-09-09T11:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />))
    enter('textarea', '稳定 GPU 预约')
    await submit(); await submit()
    const first = reserve.mock.calls[0][0], second = reserve.mock.calls[1][0]
    expect(first).toMatchObject({ gpuIds: ['gpu-stable'], gpuIndices: [7], inventoryVersion: 4 })
    expect(second.requestId).toBe(first.requestId)
    enter('textarea', '新的预约请求'); await submit()
    expect(reserve.mock.calls[2][0].requestId).not.toBe(first.requestId)
  })
  it('prevents new bookings while the synchronized GPU inventory requires review', async () => {
    const reserve = vi.spyOn(api, 'reserve')
    await act(async () => root.render(<ReservationDialog resource={{ ...resource, inventoryState: 'conflict', inventoryVersion: 2 }} start="2030-09-09T10:00" end="2030-09-09T11:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />))
    enter('textarea', '无法提交'); await submit()
    expect(reserve).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(container.textContent).toContain('GPU 清单待核验')
  })
  it('renews with the original version and only a new end time', async () => {
    const renew = vi.spyOn(api, 'renew').mockResolvedValue({ reservation })
    const onSaved = vi.fn()
    await act(async () => root.render(<RenewalDialog reservation={reservation} t={t} locale="zh-CN" onClose={vi.fn()} onSaved={onSaved} />))
    enter('input', '2030-09-09T13:00')
    await submit()
    expect(renew).toHaveBeenCalledWith(reservation, '2030-09-09T05:00:00.000Z')
    expect(onSaved).toHaveBeenCalledOnce()
  })
  it('extends a reservation using the current inventory version after GPU indices change', async () => {
    const renew = vi.spyOn(api, 'renew').mockResolvedValue({ reservation })
    const currentResource = { ...resource, inventoryVersion: 8, inventoryState: 'synced' as const }
    await act(async () => root.render(<RenewalDialog reservation={{ ...reservation, inventoryVersion: 2 }} resource={currentResource} t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />))
    enter('input', '2030-09-09T13:00'); await submit()
    expect(renew).toHaveBeenCalledWith(expect.objectContaining({ inventoryVersion: 2 }), '2030-09-09T05:00:00.000Z', 8)
  })
  it('loads a linked reservation but hides controls for other members', async () => {
    const detail = vi.spyOn(api, 'reservation').mockResolvedValue({ reservation })
    await act(async () => root.render(<ReservationDetails id={reservation.id} user={{ id: 'current-member', name: '当前成员', role: 'member' }} t={t} locale="zh-CN" onClose={vi.fn()} onAction={vi.fn()} />))
    expect(detail).toHaveBeenCalledWith(reservation.id)
    expect(container.textContent).toContain('其他成员')
    expect(container.textContent).toContain('仅预约人或管理员可以修改')
    expect([...container.querySelectorAll('button')].some((button) => ['续约', '取消预约', '提前结束'].includes(button.textContent || ''))).toBe(false)
  })
  it('hides resource administration for members and opens new bookings with keyboard focus', async () => {
    vi.spyOn(api, 'resources').mockResolvedValue({ resources: [resource] })
    vi.spyOn(api, 'reservations').mockResolvedValue({ reservations: [] })
    const session: Session = { user: { id: 'member', name: '成员', role: 'member' }, csrfToken: 'test', authMode: 'demo', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
    const state: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
    await act(async () => root.render(<Workspace session={session} state={state} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    expect(container.querySelector('nav')?.textContent).not.toContain('资源管理')
    expect(container.querySelector('.resource-usage-state')?.textContent).toBe('未知')
    expect(container.textContent).toContain('预约不会自动启动或停止任务')
    await click('预约')
    expect(container.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
  it('opens another member’s reservation details directly from the resource schedule', async () => {
    const window = initialWindow()
    const currentBooking = { ...reservation, startAt: inputToIso(window.start), endAt: inputToIso(window.end) }
    vi.spyOn(api, 'resources').mockResolvedValue({ resources: [resource] })
    vi.spyOn(api, 'reservations').mockImplementation(async (options = {}) => ({ reservations: options.mine ? [] : [currentBooking] }))
    const details = vi.spyOn(api, 'reservation').mockResolvedValue({ reservation: currentBooking })
    const session: Session = { user: { id: 'member', name: '成员', role: 'member' }, csrfToken: 'test', authMode: 'demo', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
    const state: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
    await act(async () => root.render(<Workspace session={session} state={state} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    const detailButton = container.querySelector<HTMLButtonElement>('[aria-label="查看预约详情: 其他成员"]')!
    expect(detailButton).not.toBeNull()
    expect(detailButton.tabIndex).toBe(0)
    await act(async () => { detailButton.focus(); detailButton.click() })
    expect(details).toHaveBeenCalledWith(currentBooking.id)
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('已有预约用途')
    expect(dialog.textContent).toContain('仅预约人或管理员可以修改')
    expect([...dialog.querySelectorAll('button')].some((button) => ['续约', '取消预约'].includes(button.textContent || ''))).toBe(false)
  })
})
