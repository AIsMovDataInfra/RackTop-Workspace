import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { EquipmentWorkspace } from './EquipmentWorkspace'
import type { Equipment, Session } from './types'
import type { PreferencesState } from './preferences'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state: PreferencesState = { t: (zh: string) => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const member: Session = { user: { id: 'reader', name: '设备成员', role: 'member', company: 'A公司', isSuperAdmin: false }, csrfToken: 'test', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const superAdmin: Session = { ...member, user: { ...member.user!, role: 'admin', isSuperAdmin: true } }
const equipment: Equipment = { id: 'ef96d063-030e-4ec7-ae3f-a4d47185c012', code: 'RT-001', name: '上海机械臂', company: 'A公司', model: '', category: '机械臂', serialNumber: '00000001', responsiblePerson: '设备成员', currentUser: '', photo: null, location: '上海', notes: '', status: 'available', version: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
const second: Equipment = { ...equipment, id: '8e9d8f29-1ff4-4db0-af59-d9e6083562da', name: '太仓主机', company: 'B公司', category: '台式主机', serialNumber: '00000002', location: '太仓', status: 'in_use' }
const statistics = { total: 8, statuses: { available: 3, in_use: 2, maintenance: 1, retired: 2 }, companies: [{ company: 'A公司', count: 3 }, { company: 'B公司', count: 5 }], categories: [{ category: '机械臂', count: 6 }, { category: '台式主机', count: 2 }], locations: [{ location: '上海', count: 5 }, { location: '太仓', count: 3 }] }
const emptyStatistics = { total: 0, statuses: { available: 0, in_use: 0, maintenance: 0, retired: 0 }, companies: [], categories: [], locations: [] }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
let onSessionExpired: ReturnType<typeof vi.fn>
const navigate = vi.fn()
const onSessionChanged = vi.fn()
const onLogout = vi.fn().mockResolvedValue(undefined)

async function mount(session = superAdmin, id?: string) {
  await act(async () => root.render(<EquipmentWorkspace session={session} id={id} state={state} navigate={navigate} onSessionChanged={onSessionChanged} onSessionExpired={onSessionExpired} onLogout={onLogout} />))
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
function metric(status: string) {
  const value = container.querySelector(`.equipment-overview-metrics [data-status="${status}"] dd`)
  return value ? Number.parseInt(value.textContent || '', 10) : null
}
function select(name: string, value: string) {
  act(() => {
    const input = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function search(value: string) {
  act(() => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  onSessionExpired = vi.fn()
  vi.spyOn(api, 'equipment').mockResolvedValue({ equipment: [equipment, second] })
  vi.spyOn(api, 'equipmentStats').mockResolvedValue({ stats: statistics })
  vi.spyOn(api, 'equipmentDetails').mockResolvedValue({ equipment, history: [] })
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('equipment overview', () => {
  it('uses server totals and keeps the full overview while company, status and search filter the catalog', async () => {
    await mount()
    expect(container.querySelector('#equipment-overview-title')?.textContent).toBe('设备统计')
    expect(['total', 'available', 'in_use', 'maintenance', 'retired'].map(metric)).toEqual([8, 3, 2, 1, 2])
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(2)
    select('companyFilter', 'B公司'); select('status', 'in_use'); search('太仓')
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(1)
    search('没有匹配的设备')
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(0)
    expect(['total', 'available', 'in_use', 'maintenance', 'retired'].map(metric)).toEqual([8, 3, 2, 1, 2])
    expect(api.equipmentStats).toHaveBeenCalledTimes(1)
    const breakdowns = container.querySelector<HTMLDetailsElement>('details.equipment-overview-breakdowns')!
    expect(breakdowns.open).toBe(false)
    expect(breakdowns.querySelector('summary')?.textContent).toContain('查看公司、类别与位置分布')
    expect(container.querySelector('[data-dimension="company"]')?.textContent).toContain('B公司')
    expect(container.querySelector('[data-dimension="category"]')?.textContent).toContain('机械臂')
    expect(container.querySelector('[data-dimension="location"]')?.textContent).toContain('太仓')
  })

  it('refreshes both the total and catalog after additional registrations', async () => {
    await mount()
    vi.mocked(api.equipmentStats).mockResolvedValue({ stats: { ...statistics, total: 9, statuses: { ...statistics.statuses, available: 4 } } })
    vi.mocked(api.equipment).mockResolvedValue({ equipment: [equipment, second, { ...equipment, id: 'new-device', name: '新登记设备' }] })
    await click('刷新')
    expect(metric('total')).toBe(9); expect(metric('available')).toBe(4)
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(3)
    expect(container.textContent).toContain('新登记设备')
    expect(api.equipmentStats).toHaveBeenCalledTimes(2)
    expect(api.equipment).toHaveBeenCalledTimes(2)
  })

  it('shows genuine zero counts and an empty catalog without fabricating breakdowns', async () => {
    vi.mocked(api.equipment).mockResolvedValue({ equipment: [] })
    vi.mocked(api.equipmentStats).mockResolvedValue({ stats: emptyStatistics })
    await mount()
    expect(['total', 'available', 'in_use', 'maintenance', 'retired'].map(metric)).toEqual([0, 0, 0, 0, 0])
    expect(container.textContent).toContain('还没有设备')
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(0)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps the catalog usable when statistics fail and restores the overview on retry', async () => {
    vi.mocked(api.equipmentStats).mockRejectedValueOnce(new ApiError('统计服务忙', 503, 'DATABASE_BUSY'))
    await mount()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('统计暂时无法读取')
    expect(metric('total')).toBeNull()
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(2)
    await click('重试统计')
    expect(metric('total')).toBe(8)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(api.equipmentStats).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(2)
  })

  it('clears displayed data on statistics authentication expiry and ignores an in-flight catalog response', async () => {
    await mount()
    const pendingList = deferred<{ equipment: Equipment[] }>()
    vi.mocked(api.equipment).mockReturnValueOnce(pendingList.promise)
    vi.mocked(api.equipmentStats).mockRejectedValueOnce(new ApiError('登录已过期', 401, 'UNAUTHENTICATED'))
    await click('刷新')
    expect(onSessionExpired).toHaveBeenCalled()
    expect(metric('total')).toBeNull()
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(0)
    await act(async () => pendingList.resolve({ equipment: [equipment, second] }))
    expect(metric('total')).toBeNull()
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(0)
  })

  it('ignores old statistics after the same member is assigned to a different company', async () => {
    const oldStatistics = deferred<{ stats: typeof statistics }>()
    vi.mocked(api.equipment).mockResolvedValueOnce({ equipment: [equipment] }).mockResolvedValue({ equipment: [second] })
    vi.mocked(api.equipmentStats).mockReturnValueOnce(oldStatistics.promise).mockResolvedValue({ stats: { total: 1, statuses: { ...emptyStatistics.statuses, in_use: 1 }, companies: [{ company: 'B公司', count: 1 }], categories: [{ category: '台式主机', count: 1 }], locations: [{ location: '太仓', count: 1 }] } })
    await mount(member)
    await mount({ ...member, user: { ...member.user!, company: 'B公司' } })
    expect(metric('total')).toBe(1)
    expect(container.querySelector('.equipment-overview')?.textContent).not.toContain('A公司')
    await act(async () => oldStatistics.resolve({ stats: statistics }))
    expect(metric('total')).toBe(1)
    expect(container.querySelector('.equipment-overview')?.textContent).not.toContain('A公司')
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(1)
    expect(container.querySelector('.equipment-row')?.textContent).toContain('太仓主机')
  })

  it('does not fetch or show inventory statistics on a device details page', async () => {
    await mount(member, equipment.id)
    expect(api.equipmentStats).not.toHaveBeenCalled()
    expect(api.equipment).not.toHaveBeenCalled()
    expect(container.querySelector('.equipment-overview')).toBeNull()
    expect(container.querySelector('.equipment-detail-card')?.textContent).toContain('上海机械臂')
  })
})
