import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api, ApiError } from './api'
import { EquipmentLabel, EquipmentWorkspace } from './EquipmentWorkspace'
import type { Equipment, Session } from './types'
import type { PreferencesState } from './preferences'
import QRCode from 'qrcode'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXItZXhhbXBsZQ==') } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string) => zh
const state: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const anonymous: Session = { user: null, csrfToken: 'anonymous', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const member: Session = { ...anonymous, user: { id: 'member', name: '李同学', role: 'member' } }
const equipment: Equipment = { id: 'ef96d063-030e-4ec7-ae3f-a4d47185c012', code: 'EQ-000001', name: '实验室相机', model: 'Z9', category: '相机', serialNumber: 'SN-123', responsiblePerson: '', location: '实验室 A', notes: '', status: 'available', version: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
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
  it('opens a scanned device anonymously and resumes its assignment after login', async () => {
    window.history.replaceState({}, '', `/equipment/${equipment.id}`)
    vi.spyOn(api, 'session').mockResolvedValue(anonymous)
    vi.spyOn(api, 'login').mockResolvedValue(member)
    const update = vi.spyOn(api, 'updateEquipment').mockResolvedValue({ equipment: { ...equipment, responsiblePerson: '李同学', status: 'in_use', version: 2 } })
    await act(async () => root.render(<App />))
    expect(container.textContent).toContain('实验室相机')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(api.equipmentDetails).toHaveBeenCalledWith(equipment.id)
    await click('领用登记')
    enter('username', '同'); enter('password', '中')
    await submit()
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('领用登记')
    expect(container.querySelector<HTMLInputElement>('[name="responsiblePerson"]')?.value).toBe('李同学')
    expect(container.querySelector<HTMLSelectElement>('[name="status"]')?.value).toBe('in_use')
    await submit()
    expect(update).toHaveBeenCalledWith(equipment.id, { responsiblePerson: '李同学', status: 'in_use', version: 1 })
    expect(window.location.pathname).toBe(`/equipment/${equipment.id}`)
  })

  it('creates a device with only its name and never sends server-owned fields', async () => {
    const create = vi.spyOn(api, 'createEquipment').mockResolvedValue({ equipment })
    await act(async () => root.render(<EquipmentWorkspace session={member} state={state} navigate={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
    await click('新增设备')
    expect(document.activeElement).toBe(container.querySelector('[name="name"]'))
    enter('name', '新设备')
    await submit()
    expect(create).toHaveBeenCalledWith({ name: '新设备', category: '', model: '', serialNumber: '', responsiblePerson: '', location: '', notes: '', status: 'available' })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps edits on version conflict and merges only changed fields onto the refreshed version', async () => {
    const latest = { ...equipment, responsiblePerson: '王同学', location: '实验室 B', version: 2 }
    const update = vi.spyOn(api, 'updateEquipment').mockRejectedValueOnce(new ApiError('changed', 409, 'VERSION_CONFLICT')).mockResolvedValue({ equipment: { ...latest, location: '实验室 C', version: 3 } })
    await mount(); await click('编辑信息')
    enter('location', '实验室 C'); await submit()
    expect(container.querySelector<HTMLInputElement>('[name="location"]')!.value).toBe('实验室 C')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('输入已保留')
    vi.mocked(api.equipmentDetails).mockResolvedValue({ equipment: latest, history: [] })
    await click('读取最新版本')
    expect(container.querySelector<HTMLInputElement>('[name="responsiblePerson"]')!.value).toBe('王同学')
    expect(container.querySelector<HTMLInputElement>('[name="location"]')!.value).toBe('实验室 C')
    await submit()
    expect(update).toHaveBeenLastCalledWith(equipment.id, { location: '实验室 C', version: 2 })
  })

  it('retains an unsaved edit across an expired session and sign-in', async () => {
    const update = vi.spyOn(api, 'updateEquipment').mockRejectedValueOnce(new ApiError('expired', 401, 'UNAUTHENTICATED')).mockResolvedValue({ equipment: { ...equipment, location: '实验室 D', version: 2 } })
    vi.spyOn(api, 'login').mockResolvedValue(member)
    await mount(); await click('编辑信息'); enter('location', '实验室 D'); await submit()
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('登录')
    enter('username', '李'); enter('password', '密码'); await submit()
    expect(container.querySelector<HTMLInputElement>('[name="location"]')!.value).toBe('实验室 D')
    await submit()
    expect(update).toHaveBeenLastCalledWith(equipment.id, { location: '实验室 D', version: 1 })
  })

  it('filters by location and status and navigates a device link', async () => {
    const navigate = vi.fn()
    vi.mocked(api.equipment).mockResolvedValue({ equipment: [equipment, { ...equipment, id: 'other', name: '备用显示器', status: 'maintenance', location: '办公室' }] })
    await act(async () => root.render(<EquipmentWorkspace session={anonymous} state={state} navigate={navigate} onSessionChanged={vi.fn()} onSessionExpired={vi.fn()} onLogout={vi.fn()} />))
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

  it('generates a stable local QR label and supports printing and downloading', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
    expect(QRCode.toDataURL).toHaveBeenCalledWith(`${window.location.origin}/equipment/${equipment.id}`, expect.objectContaining({ margin: 4, errorCorrectionLevel: 'M' }))
    expect(container.querySelector('.equipment-print-label')?.textContent).toContain('实验室相机EQ-000001Z9')
    expect(container.querySelector('a[download]')?.getAttribute('href')).toMatch(/^data:image\/png;/)
    expect(container.querySelector('a[download]')?.getAttribute('download')).toBe('EQ-000001-QR.png')
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
