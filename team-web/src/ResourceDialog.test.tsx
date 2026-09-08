import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { ResourceDialog } from './ResourceDialog'
import type { Resource } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const t = (zh: string, _en: string) => zh
const resource: Resource = { id: 'server', cluster: '测试', name: 'A100 服务器', gpuModel: 'A100', gpuCount: 1, notes: '', enabled: true, inventoryVersion: 3, inventoryState: 'conflict', pendingGpus: [{ uuid: 'GPU-new', index: 0, model: 'H100', memoryTotalMb: 81920 }] }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function click(text: string) { const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!; expect(button).toBeDefined(); await act(async () => button.click()) }
it('keeps synchronized hardware read-only and requires an explicit confirmation to accept pending GPUs', async () => {
  const accept = vi.spyOn(api, 'acceptInventory').mockRejectedValue(new ApiError('预约未结束', 409, 'RESOURCE_HAS_RESERVATIONS'))
  const saved = vi.fn()
  await act(async () => root.render(<ResourceDialog resource={resource} t={t} onClose={vi.fn()} onSaved={saved} />))
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 型号"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 数量"]')!.disabled).toBe(true)
  expect(container.textContent).toContain('H100')
  await click('核验新的 GPU 清单')
  expect(accept).not.toHaveBeenCalled()
  await click('确认新的 GPU 清单')
  expect(accept).toHaveBeenCalledWith(resource)
  expect(saved).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('取消或结束现有预约')
})
it('only edits user-controlled metadata for a synchronized resource', async () => {
  const update = vi.spyOn(api, 'updateResource').mockResolvedValue({ resource })
  await act(async () => root.render(<ResourceDialog resource={{ ...resource, inventoryState: 'synced' }} t={t} onClose={vi.fn()} onSaved={vi.fn()} />))
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(update).toHaveBeenCalledWith(resource.id, { name: resource.name, cluster: resource.cluster, notes: resource.notes })
})
