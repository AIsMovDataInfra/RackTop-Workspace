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
function enter(label: string, value: string) { const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function select(label: string, value: string) { const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; act(() => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
it('keeps synchronized hardware read-only and requires an explicit confirmation to accept pending GPUs', async () => {
  const accept = vi.spyOn(api, 'acceptInventory').mockRejectedValue(new ApiError('预约未结束', 409, 'RESOURCE_HAS_RESERVATIONS'))
  const saved = vi.fn()
  await act(async () => root.render(<ResourceDialog resource={resource} t={t} onClose={vi.fn()} onSaved={saved} />))
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 型号"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 数量"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLSelectElement>('[aria-label="资源类型"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLSelectElement>('[aria-label="资源类型"]')!.value).toBe('gpu')
  expect(container.textContent).toContain('H100')
  await click('核验新的 GPU 清单')
  expect(accept).not.toHaveBeenCalled()
  await click('确认新的 GPU 清单')
  expect(accept).toHaveBeenCalledWith(resource)
  expect(saved).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('取消或结束现有预约')
})
it.each([1, 0])('only edits user-controlled metadata for a synchronized resource with %s GPUs', async (gpuCount) => {
  const synchronized = { ...resource, gpuCount, gpuModel: gpuCount ? resource.gpuModel : '', inventoryState: 'synced' as const }
  const update = vi.spyOn(api, 'updateResource').mockResolvedValue({ resource })
  await act(async () => root.render(<ResourceDialog resource={synchronized} t={t} onClose={vi.fn()} onSaved={vi.fn()} />))
  const type = container.querySelector<HTMLSelectElement>('[aria-label="资源类型"]')!
  expect(type.value).toBe(gpuCount ? 'gpu' : 'cpu'); expect(type.disabled).toBe(true)
  select('资源类型', gpuCount ? 'cpu' : 'gpu')
  await submit()
  expect(update).toHaveBeenCalledWith(resource.id, { name: resource.name, cluster: resource.cluster, notes: resource.notes })
})
it('does not reuse a super administrator historical company for a new resource', async () => {
  const user = { id: 'super', name: '超级管理员', role: 'admin' as const, isSuperAdmin: true, company: '西浦' as const }
  await act(async () => root.render(<ResourceDialog user={user} t={t} onClose={vi.fn()} onSaved={vi.fn()} />))
  expect(container.querySelector<HTMLSelectElement>('[aria-label="所属公司"]')!.value).toBe('')
  expect([...container.querySelectorAll<HTMLOptionElement>('[aria-label="所属公司"] option')].map(option => option.value)).toEqual(['', 'A公司', 'B公司', 'C公司', '西浦'])
})

it('creates a CPU resource with zero GPUs and no stale GPU model while preserving the entered name, cluster and company', async () => {
  const create = vi.spyOn(api, 'createResource').mockResolvedValue({ resource })
  const saved = vi.fn()
  const user = { id: 'super', name: '超级管理员', role: 'admin' as const, isSuperAdmin: true, company: '西浦' as const }
  await act(async () => root.render(<ResourceDialog user={user} t={t} onClose={vi.fn()} onSaved={saved} />))
  select('所属公司', 'B公司')
  enter('资源名称', '自建计算节点'); enter('所属集群', '原研发集群'); enter('GPU 型号', 'A100')
  select('资源类型', 'cpu')
  expect(container.querySelector('[aria-label="GPU 型号"]')).toBeNull()
  expect(container.querySelector('[aria-label="GPU 数量"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="资源名称"]')!.placeholder).toContain('阿里云 ECS')
  await submit()
  expect(create).toHaveBeenCalledWith({ company: 'B公司', name: '自建计算节点', cluster: '原研发集群', gpuModel: '', gpuCount: 0, notes: '' })
  expect(saved).toHaveBeenCalledOnce()
})

it('preserves manual GPU inputs when switching types and submits only the selected hardware type', async () => {
  const manual = { ...resource, inventoryVersion: 0, inventoryState: 'manual' as const, cluster: '原GPU集群', company: 'A公司' as const, companyVersion: 4 }
  const user = { id: 'super', name: '超级管理员', role: 'admin' as const, isSuperAdmin: true }
  const update = vi.spyOn(api, 'updateResource').mockResolvedValue({ resource })
  await act(async () => root.render(<ResourceDialog resource={manual} user={user} t={t} onClose={vi.fn()} onSaved={vi.fn()} />))
  enter('GPU 数量', '4'); enter('GPU 型号', 'H100')
  select('资源类型', 'cpu')
  await submit()
  expect(update).toHaveBeenLastCalledWith(resource.id, { company: 'A公司', companyVersion: 4, name: manual.name, cluster: manual.cluster, notes: '', gpuModel: '', gpuCount: 0 })
  select('资源类型', 'gpu')
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 数量"]')!.value).toBe('4')
  expect(container.querySelector<HTMLInputElement>('[aria-label="GPU 型号"]')!.value).toBe('H100')
  await submit()
  expect(update).toHaveBeenLastCalledWith(resource.id, { company: 'A公司', companyVersion: 4, name: manual.name, cluster: manual.cluster, notes: '', gpuModel: 'H100', gpuCount: 4 })
})

it('requires a model and 1–64 whole GPUs when changing an existing CPU resource to GPU', async () => {
  const cpu = { ...resource, gpuCount: 0, gpuModel: '', inventoryVersion: 0, inventoryState: 'manual' as const }
  const update = vi.spyOn(api, 'updateResource').mockResolvedValue({ resource })
  await act(async () => root.render(<ResourceDialog resource={cpu} t={t} onClose={vi.fn()} onSaved={vi.fn()} />))
  expect(container.querySelector<HTMLSelectElement>('[aria-label="资源类型"]')!.value).toBe('cpu')
  select('资源类型', 'gpu')
  await submit()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('请填写 GPU 型号')
  enter('GPU 型号', 'H100')
  for (const count of ['', '0', '-1', '1.5', '65']) {
    enter('GPU 数量', count); await submit()
    expect(update).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1–64')
  }
  for (const count of ['1', '64']) {
    enter('GPU 数量', count); await submit()
    expect(update).toHaveBeenLastCalledWith(cpu.id, { name: cpu.name, cluster: cpu.cluster, notes: cpu.notes, gpuModel: 'H100', gpuCount: Number(count) })
  }
})
