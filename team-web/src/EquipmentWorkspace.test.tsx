import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, ApiError } from './api'
import { EquipmentLabel, EquipmentWorkspace } from './EquipmentWorkspace'
import type { Equipment, EquipmentHistory, Session } from './types'
import type { PreferencesState } from './preferences'
import QRCode from 'qrcode'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXItZXhhbXBsZQ==') } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string) => zh
const state: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const anonymous: Session = { user: null, csrfToken: 'anonymous', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const member: Session = { ...anonymous, user: { id: 'member', name: '李同学', role: 'member' } }
const equipment: Equipment = { id: 'ef96d063-030e-4ec7-ae3f-a4d47185c012', code: 'EQ-000001', name: '实验室相机', model: 'Z9', category: '摄像头模组', serialNumber: '00000001', legacySerialNumber: 'SN-123', responsiblePerson: '负责人甲', currentUser: '', photo: null, location: '上海', notes: '', status: 'available', version: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
function select(name: string, value: string) { act(() => { const input = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit() { await act(async () => container.querySelector('.dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function mount(session = member, id: string | undefined = equipment.id) { await act(async () => root.render(<EquipmentWorkspace id={id} session={session} state={state} navigate={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />)) }
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  window.history.replaceState({}, '', '/equipment'); window.localStorage.clear()
  vi.mocked(QRCode.toDataURL).mockImplementation(() => Promise.resolve('data:image/png;base64,cXItZXhhbXBsZQ=='))
  vi.spyOn(api, 'equipment').mockResolvedValue({ equipment: [equipment] })
  vi.spyOn(api, 'equipmentDetails').mockResolvedValue({ equipment, history: [] })
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('equipment inventory', () => {
  it('requires sign-in before loading a scanned device and keeps its complete URL', async () => {
    window.history.replaceState({}, '', `/equipment/${equipment.id}?from=qr`)
    vi.spyOn(api, 'session').mockResolvedValue(anonymous)
    vi.spyOn(api, 'login').mockResolvedValue(member)
    const update = vi.spyOn(api, 'updateEquipment').mockResolvedValue({ equipment: { ...equipment, currentUser: '李同学', status: 'in_use', version: 2 } })
    await act(async () => root.render(<App />))
    expect(container.textContent).not.toContain('实验室相机')
    expect(api.equipmentDetails).not.toHaveBeenCalled()
    enter('username', '同'); enter('password', '中')
    await submit()
    expect(api.equipmentDetails).toHaveBeenCalledWith(equipment.id)
    expect(window.location.search).toBe('?from=qr')
    await click('领用登记')
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('领用登记')
    expect(container.querySelector<HTMLInputElement>('[name="currentUser"]')?.value).toBe('李同学')
    expect(container.querySelector<HTMLSelectElement>('[name="status"]')?.value).toBe('in_use')
    await submit()
    expect(update).toHaveBeenCalledWith(equipment.id, { currentUser: '李同学', status: 'in_use', version: 1 })
    expect(window.location.pathname).toBe(`/equipment/${equipment.id}`)
  })

  it('requires name category and location and never edits or sends the generated number', async () => {
    const create = vi.spyOn(api, 'createEquipment').mockResolvedValue({ equipment })
    await act(async () => root.render(<EquipmentWorkspace session={member} state={state} navigate={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    await click('新增设备')
    expect(document.activeElement).toBe(container.querySelector('[name="name"]'))
    enter('name', '新设备')
    expect(container.querySelector<HTMLInputElement>('[name="serialNumber"]')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('[name="responsiblePerson"]')!.value).toBe('李同学')
    await submit(); expect(create).not.toHaveBeenCalled()
    select('category', '机械臂'); select('location', '上海'); await submit()
    expect(create).toHaveBeenCalledWith({ name: '新设备', category: '机械臂', model: '', responsiblePerson: '李同学', currentUser: '', location: '上海', notes: '', status: 'available' })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps edits on version conflict and merges only changed fields onto the refreshed version', async () => {
    const latest = { ...equipment, responsiblePerson: '王同学', location: '上海', version: 2 }
    const update = vi.spyOn(api, 'updateEquipment').mockRejectedValueOnce(new ApiError('changed', 409, 'VERSION_CONFLICT')).mockResolvedValue({ equipment: { ...latest, location: '太仓', version: 3 } })
    await mount(); await click('编辑信息')
    select('location', '太仓'); await submit()
    expect(container.querySelector<HTMLInputElement>('[name="location"]')!.value).toBe('太仓')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('输入已保留')
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment: latest, history: [] })
    await click('读取最新版本')
    expect(container.querySelector<HTMLInputElement>('[name="responsiblePerson"]')!.value).toBe('王同学')
    expect(container.querySelector<HTMLInputElement>('[name="location"]')!.value).toBe('太仓')
    await submit()
    expect(update).toHaveBeenLastCalledWith(equipment.id, { location: '太仓', version: 2 })
  })

  it('clears the device and editor on expiry and reloads only after explicit sign-in', async () => {
    window.history.replaceState({}, '', `/equipment/${equipment.id}`)
    vi.spyOn(api, 'session').mockResolvedValueOnce(member).mockResolvedValue(anonymous)
    vi.spyOn(api, 'updateEquipment').mockRejectedValue(new ApiError('expired', 401, 'UNAUTHENTICATED'))
    vi.spyOn(api, 'login').mockResolvedValue(member)
    await act(async () => root.render(<App />))
    await click('编辑信息'); select('location', '太仓'); await submit()
    expect(container.textContent).not.toContain('实验室相机')
    expect(container.querySelector('[name="location"]')).toBeNull()
    enter('username', '李'); enter('password', '密码'); await submit()
    expect(container.textContent).toContain('实验室相机')
    expect(window.location.pathname).toBe(`/equipment/${equipment.id}`)
  })

  it('clears sensitive content as soon as logout begins, even when remote logout fails', async () => {
    window.history.replaceState({}, '', `/equipment/${equipment.id}`)
    vi.spyOn(api, 'session').mockResolvedValue(member)
    let fail!: (error: Error) => void
    vi.spyOn(api, 'logout').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await act(async () => root.render(<App />))
    expect(container.textContent).toContain('实验室相机')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="退出登录"]')!.click())
    expect(container.textContent).not.toContain('实验室相机')
    await act(async () => fail(new Error('撤销失败')))
    expect(container.querySelector('[name="username"]')).not.toBeNull()
    expect(container.textContent).not.toContain('实验室相机')
    expect(window.location.pathname).toBe(`/equipment/${equipment.id}`)
  })

  it('returns equipment by clearing only the current user and keeps the responsible person', async () => {
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment: { ...equipment, currentUser: '使用人乙', status: 'in_use' }, history: [] })
    const update = vi.spyOn(api, 'updateEquipment').mockResolvedValue({ equipment })
    await mount(); await click('归还登记'); await submit()
    expect(update).toHaveBeenCalledWith(equipment.id, { currentUser: '', status: 'available', version: 1 })
  })

  it('preserves legacy category and location until supported choices are selected', async () => {
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment: { ...equipment, category: '旧类别', location: '北京' }, history: [] })
    const update = vi.spyOn(api, 'updateEquipment').mockResolvedValue({ equipment })
    await mount(); await click('编辑信息')
    expect(container.querySelector<HTMLSelectElement>('[name="location"]')!.value).toBe('北京')
    expect(container.querySelector<HTMLSelectElement>('[name="category"]')!.value).toBe('旧类别')
    await submit(); expect(update).not.toHaveBeenCalled()
    select('category', '机械臂'); select('location', '太仓'); await submit()
    expect(update).toHaveBeenCalledWith(equipment.id, { category: '机械臂', location: '太仓', version: 1 })
  })

  it('filters by location and status and navigates a device link', async () => {
    const navigate = vi.fn()
    vi.mocked(api.equipment).mockResolvedValue({ equipment: [equipment, { ...equipment, id: 'other', name: '备用显示器', status: 'maintenance', location: '办公室' }] })
    await act(async () => root.render(<EquipmentWorkspace session={member} state={state} navigate={navigate} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '办公室'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(container.querySelectorAll('.equipment-row')).toHaveLength(1)
    expect(container.querySelector('.equipment-row')?.textContent).toContain('备用显示器')
    act(() => { const select = container.querySelector('select')!; select.value = 'available'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('没有匹配的设备')
    await click('清除筛选')
    await act(async () => container.querySelector<HTMLAnchorElement>('.equipment-row')!.click())
    expect(navigate).toHaveBeenCalledWith(`/equipment/${equipment.id}`)
  })

  it('shows the eight-digit device number in history without exposing the internal code', async () => {
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment, history: [{ actorName: '李同学', action: 'created', at: equipment.createdAt, changes: [{ field: 'code', oldValue: null, newValue: 'RT-INTERNAL' }, { field: 'serialNumber', oldValue: null, newValue: '00000001' }] }] })
    await mount()
    const history = container.querySelector('.equipment-history')!
    expect(history.textContent).toContain('设备编号00000001')
    expect(history.textContent).not.toContain('RT-INTERNAL')
    expect(history.querySelectorAll('ul > li')).toHaveLength(1)
  })

  it('summarizes photo history without internal paths and translates fixed category and location values', async () => {
    const photoPath = '/api/equipment/device/photo?v=2 (100000 bytes)'
    const history: EquipmentHistory[] = [
      { actorName: '李同学', action: 'updated', at: equipment.createdAt, changes: [{ field: 'photo', oldValue: null, newValue: photoPath }] },
      { actorName: '李同学', action: 'updated', at: equipment.createdAt, changes: [{ field: 'photo', oldValue: photoPath, newValue: `${photoPath} replaced` }] },
      { actorName: '李同学', action: 'updated', at: equipment.createdAt, changes: [{ field: 'photo', oldValue: photoPath, newValue: null }] },
      { actorName: '李同学', action: 'updated', at: equipment.createdAt, changes: [{ field: 'category', oldValue: '机械臂', newValue: '夹爪' }, { field: 'location', oldValue: '上海', newValue: '太仓' }] },
    ]
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment, history })
    await mount()
    const text = () => container.querySelector('.equipment-history')!.textContent
    expect(text()).toContain('已上传照片'); expect(text()).toContain('已更换照片'); expect(text()).toContain('已移除照片')
    expect(text()).not.toContain('/api/'); expect(text()).not.toContain('100000 bytes')
    const english: PreferencesState = { ...state, t: (_zh, en) => en, preferences: { ...state.preferences, locale: 'en' } }
    await act(async () => root.render(<EquipmentWorkspace id={equipment.id} session={member} state={english} navigate={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    expect(text()).toContain('Photo uploaded'); expect(text()).toContain('Photo replaced'); expect(text()).toContain('Photo removed')
    expect(text()).toContain('Robot arm → Gripper'); expect(text()).toContain('Shanghai → Taicang')
    expect(text()).not.toContain('/api/'); expect(text()).not.toContain('机械臂'); expect(text()).not.toContain('上海')
  })

  it('generates a stable local QR label and supports printing and downloading', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
    expect(QRCode.toDataURL).toHaveBeenCalledWith(`${window.location.origin}/equipment/${equipment.id}`, expect.objectContaining({ margin: 4, errorCorrectionLevel: 'M' }))
    expect(container.querySelector('.equipment-print-label')?.textContent).toContain('实验室相机00000001Z9')
    expect(container.querySelector('a[download]')?.getAttribute('href')).toMatch(/^data:image\/png;/)
    expect(container.querySelector('a[download]')?.getAttribute('download')).toBe('00000001-QR.png')
    await click('打印标签'); expect(print).toHaveBeenCalledOnce()
  })

  it('closes the editor with Escape and restores the originating button focus', async () => {
    await mount()
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '编辑信息')!
    button.focus(); await click('编辑信息')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})
