import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EquipmentPhoto } from './EquipmentPhoto'
import { api, ApiError } from './api'
import { compressEquipmentPhoto } from './equipment-photo'
import type { Equipment } from './types'
vi.mock('./equipment-photo', () => ({ compressEquipmentPhoto: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const equipment: Equipment = { company: '', id: 'device', code: 'EQ-1', serialNumber: '00000001', name: '机械臂', model: '', category: '机械臂', responsiblePerson: '负责人', currentUser: '', location: '上海', notes: '', status: 'available', photo: null, version: 1, createdAt: '', updatedAt: '' }
const compressed = { dataUrl: 'data:image/jpeg;base64,cGhvdG8=', width: 1000, height: 750, bytes: 100_000 }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
async function click(text: string) { const button = [...container.querySelectorAll('button')].find((value) => value.textContent === text)!; expect(button).toBeDefined(); await act(async () => button.click()) }
async function choose() { const input = container.querySelector<HTMLInputElement>('input:not([capture])')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['photo'], 'device.jpg', { type: 'image/jpeg' })] }); await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))) }
async function mount(value = equipment, onChanged = vi.fn()) { await act(async () => root.render(<EquipmentPhoto equipment={value} t={(zh) => zh} onChanged={onChanged} onSessionExpired={vi.fn()} />)) }
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.mocked(compressEquipmentPhoto).mockResolvedValue(compressed)
  vi.spyOn(api, 'equipmentPhoto').mockResolvedValue(new Blob(['photo'], { type: 'image/jpeg' }))
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue('blob:device-photo'), revokeObjectURL: vi.fn() }))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('equipment photos', () => {
  it('separates camera and album selection and requires explicit save after compression', async () => {
    const upload = vi.spyOn(api, 'setEquipmentPhoto').mockResolvedValue({ equipment: { ...equipment, version: 2 } })
    await mount()
    expect(container.querySelector('input[capture]')?.getAttribute('capture')).toBe('environment')
    expect(container.querySelector('input:not([capture])')?.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp')
    await choose()
    expect(container.querySelector('img')?.src).toBe(compressed.dataUrl)
    expect(upload).not.toHaveBeenCalled()
    await click('保存照片')
    expect(upload).toHaveBeenCalledWith('device', 1, compressed.dataUrl)
    expect(container.textContent).toContain('照片已保存')
  })
  it('keeps the compressed preview on conflict and retries only after loading the latest version', async () => {
    const upload = vi.spyOn(api, 'setEquipmentPhoto').mockRejectedValueOnce(new ApiError('conflict', 409, 'VERSION_CONFLICT')).mockResolvedValue({ equipment: { ...equipment, version: 3 } })
    vi.spyOn(api, 'equipmentDetails').mockResolvedValue({ equipment: { ...equipment, version: 2 }, history: [] })
    await mount(); await choose(); await click('保存照片')
    expect(container.querySelector('img')?.src).toBe(compressed.dataUrl)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('所选照片已保留')
    await click('读取最新版本'); await click('保存照片')
    expect(upload).toHaveBeenLastCalledWith('device', 2, compressed.dataUrl)
  })
  it('requires confirmation to delete and revokes the protected display URL on unmount', async () => {
    const remove = vi.spyOn(api, 'deleteEquipmentPhoto').mockResolvedValue({ equipment: { ...equipment, version: 2 } })
    const withPhoto = { ...equipment, photo: { url: '/api/equipment/device/photo', width: 100, height: 100, bytes: 1000, updatedAt: '' } }
    await mount(withPhoto)
    expect(api.equipmentPhoto).toHaveBeenCalledWith('device', 1)
    expect(container.querySelector('img')?.src).toBe('blob:device-photo')
    await click('删除照片'); expect(remove).not.toHaveBeenCalled()
    await click('确认删除'); expect(remove).toHaveBeenCalledWith('device', 1)
    await act(async () => root.render(null))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:device-photo')
  })
  it('shows a friendly decode error without starting upload', async () => {
    vi.mocked(compressEquipmentPhoto).mockRejectedValue(new Error('HEIC 请先导出为 JPEG。 / Export HEIC as JPEG first.'))
    const upload = vi.spyOn(api, 'setEquipmentPhoto')
    await mount(); await choose()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('HEIC 请先导出为 JPEG')
    expect(upload).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
  })
})
