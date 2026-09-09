import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EquipmentThumbnail } from './EquipmentThumbnail'
import { api } from './api'
import type { Equipment } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const equipment: Equipment = {
  id: 'device-a', code: 'EQ-1', serialNumber: '00000001', name: '实验室机械臂',
  category: '机械臂', company: 'A公司', model: '', responsiblePerson: '', currentUser: '',
  location: '上海', notes: '', status: 'available', version: 1, createdAt: '', updatedAt: '',
  photo: { url: '/api/equipment/device-a/photo?v=1', width: 400, height: 300, bytes: 1000, updatedAt: '' },
}
const t = (zh: string) => zh
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
let observers: Array<{ emit: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn> }>
const createUrl = vi.fn<(blob: Blob) => string>()
const revokeUrl = vi.fn<(url: string) => void>()
async function mount(value = equipment, key = 'company-a') {
  await act(async () => root.render(<EquipmentThumbnail key={key} equipment={value} t={t} />))
}
async function makeVisible(visible = true) { await act(async () => observers[0].emit(visible)) }
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  observers = []
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    emit: (visible: boolean) => void
    constructor(callback: IntersectionObserverCallback) {
      this.emit = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      observers.push(this)
    }
  })
  createUrl.mockReset().mockImplementation(() => `blob:thumbnail-${createUrl.mock.calls.length}`)
  revokeUrl.mockReset()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))
  vi.spyOn(api, 'equipmentPhoto').mockResolvedValue(new Blob(['protected photo'], { type: 'image/jpeg' }))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('protected equipment thumbnails', () => {
  it('waits for visibility, then displays the protected photo with an accessible description', async () => {
    await mount()
    expect(api.equipmentPhoto).not.toHaveBeenCalled()
    await makeVisible(false)
    expect(api.equipmentPhoto).not.toHaveBeenCalled()
    await makeVisible()
    expect(api.equipmentPhoto).toHaveBeenCalledExactlyOnceWith('device-a', 1)
    expect(createUrl).toHaveBeenCalledTimes(1)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail-1')
    expect(container.querySelector('img')?.alt).toBe('实验室机械臂 设备照片')
    expect(observers[0].disconnect).toHaveBeenCalled()
  })

  it.each(['page exit', 'company-view replacement'] as const)('discards a late photo after %s without creating a Blob URL', async mode => {
    const pending = deferred<Blob>()
    vi.mocked(api.equipmentPhoto).mockReturnValue(pending.promise)
    await mount(); await makeVisible()
    expect(api.equipmentPhoto).toHaveBeenCalledExactlyOnceWith('device-a', 1)
    if (mode === 'page exit') await act(async () => root.render(null))
    else await mount({ ...equipment, id: 'device-b', company: 'B公司', name: 'B公司设备', photo: null }, 'company-b')
    await act(async () => pending.resolve(new Blob(['A company late photo'], { type: 'image/jpeg' })))
    expect(container.querySelector('img')).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
    expect(revokeUrl).not.toHaveBeenCalled()
    if (mode === 'company-view replacement') expect(container.querySelector('[aria-label="暂无照片"]')).not.toBeNull()
  })

  it('revokes the displayed URL when the version changes and revokes its replacement on unmount', async () => {
    await mount(); await makeVisible()
    const next = deferred<Blob>()
    vi.mocked(api.equipmentPhoto).mockReturnValueOnce(next.promise)
    await mount({ ...equipment, version: 2 })
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:thumbnail-1')
    expect(container.querySelector('img')).toBeNull()
    expect(api.equipmentPhoto).toHaveBeenLastCalledWith('device-a', 2)
    await act(async () => next.resolve(new Blob(['replacement'], { type: 'image/jpeg' })))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail-2')
    await act(async () => root.render(null))
    expect(revokeUrl.mock.calls).toEqual([['blob:thumbnail-1'], ['blob:thumbnail-2']])
  })

  it('shows the unavailable fallback on failure and the no-photo fallback without a new request', async () => {
    vi.mocked(api.equipmentPhoto).mockRejectedValue(new Error('permission expired'))
    await mount(); await makeVisible()
    expect(container.querySelector('[aria-label="照片暂时无法读取"]')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
    await mount({ ...equipment, version: 2, photo: null })
    expect(container.querySelector('[aria-label="暂无照片"]')).not.toBeNull()
    expect(api.equipmentPhoto).toHaveBeenCalledTimes(1)
  })
})
