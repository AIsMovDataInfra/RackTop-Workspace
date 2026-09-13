import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { ReservationDialog, RenewalDialog } from './ReservationDialog'
import { ResourceCard } from './ResourceCard'
import { currentGpuRestriction } from './resource-usage'
import type { Reservation, Resource } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const timestamp = Date.parse('2030-09-09T02:00:00Z')
const t = (zh: string, _en: string) => zh
function sample(states: ('busy' | 'free' | 'unknown')[]): Resource {
  return { id: 'gpu', name: '合成 H200', cluster: '合成集群', gpuCount: states.length, gpuModel: 'H200', enabled: true, notes: '', inventoryVersion: 1, inventoryState: 'synced',
    gpus: states.map((_, index) => ({ id: `gpu-${index}`, uuid: `GPU-${index}`, index, model: 'H200', memoryTotalMb: 80000 })),
    usage: { state: states.includes('busy') ? 'busy' : states.includes('unknown') ? 'unknown' : 'free', observedAt: new Date(timestamp).toISOString(), gpus: states.map((state, index) => ({ id: `gpu-${index}`, uuid: `GPU-${index}`, index, state, users: state === 'busy' ? ['synthetic-worker'] : [], utilization: state === 'busy' ? 80 : 0, memoryUsedMb: state === 'busy' ? 1000 : 0 })) } }
}
const booking: Reservation = { id: 'booking', resourceId: 'gpu', resourceName: '合成 H200', cluster: '合成集群', ownerName: '合成成员', scope: 'machine', gpuIndices: [], startAt: new Date(timestamp).toISOString(), endAt: new Date(timestamp + 3600000).toISOString(), status: 'confirmed', createdAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString(), version: 1 }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(timestamp); container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(api, 'reserve').mockResolvedValue({ reservation: booking }); vi.spyOn(api, 'resources').mockResolvedValue({ resources: [sample(['free'])] }) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
function enter(selector: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; act(() => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function mount(resource: Resource, initialGpu?: number) { vi.mocked(api.resources).mockResolvedValue({ resources: [resource] }); await act(async () => root.render(<ReservationDialog resource={resource} initialGpu={initialGpu} start="2030-09-09T10:00" end="2030-09-09T12:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />)); enter('textarea', '保留合成草稿') }
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

it('keeps all occupied GPUs visible without presenting unreserved slots as idle, and keeps the slot editor reachable', async () => {
  const resource = sample(Array(8).fill('busy')), reserve = vi.fn()
  await act(async () => root.render(<ResourceCard resource={resource} reservations={[]} start={new Date(timestamp).toISOString()} end={booking.endAt} t={t} locale="zh-CN" complete onReserve={reserve} onDetails={vi.fn()} />))
  expect(container.querySelectorAll('.gpu-tile')).toHaveLength(8)
  expect([...container.querySelectorAll<HTMLButtonElement>('.gpu-tile')].every(button => button.disabled)).toBe(true)
  expect(container.textContent).toContain('8/8 此时段未预约')
  expect(container.querySelector('.available-text')).toBeNull()
  const button = container.querySelector<HTMLButtonElement>('article > header > button')!
  expect(button.disabled).toBe(false); await act(async () => button.click()); expect(reserve).toHaveBeenCalled()
})

it('blocks an immediate occupied booking even on forced form submit but permits the same GPUs in a future slot', async () => {
  await mount(sample(['busy', 'busy']))
  expect(submitButton().disabled).toBe(true)
  await submit(); expect(api.reserve).not.toHaveBeenCalled()
  enter('[aria-label="开始时间"]', '2030-09-09T11:00')
  expect(submitButton().disabled).toBe(false)
  await submit(); expect(api.reserve).toHaveBeenCalledWith(expect.objectContaining({ startAt: '2030-09-09T03:00:00.000Z', scope: 'machine' }))
})

it('checks the selected stable GPU instead of blocking every card on a partially occupied machine', async () => {
  const resource = sample(['busy', 'free', 'unknown'])
  await mount(resource, 1)
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.gpu-picker input')]
  expect(boxes.map(box => box.disabled)).toEqual([true, false, true])
  expect(submitButton().disabled).toBe(false)
  await submit(); expect(api.reserve).toHaveBeenCalledWith(expect.objectContaining({ scope: 'gpus', gpuIndices: [1], gpuIds: ['gpu-1'] }))
  await act(async () => container.querySelector<HTMLInputElement>('input[value="machine"]')!.click())
  expect(submitButton().disabled).toBe(true)
})

it('treats absent, stale, future and mismatched GPU observations as unknown while CPU manual booking remains unchanged', () => {
  const resource = sample(['free'])
  for (const observedAt of [new Date(timestamp - 90000).toISOString(), new Date(timestamp + 1).toISOString(), 'bad']) {
    expect(currentGpuRestriction({ ...resource, usage: { ...resource.usage!, observedAt } }, booking.startAt, [0], timestamp)).toBe('GPU_USAGE_UNKNOWN')
  }
  expect(currentGpuRestriction({ ...resource, usage: undefined }, booking.startAt, [0], timestamp)).toBe('GPU_USAGE_UNKNOWN')
  expect(currentGpuRestriction({ ...resource, usage: { ...resource.usage!, gpus: [{ ...resource.usage!.gpus[0], id: 'different-gpu' }] } }, booking.startAt, [0], timestamp)).toBe('GPU_USAGE_UNKNOWN')
  expect(currentGpuRestriction({ ...resource, gpuCount: 0, gpus: [], usage: undefined }, booking.startAt, undefined, timestamp)).toBeNull()
})

it('expires an open dialog at 90 seconds even when the refresh request is still pending and preserves its draft', async () => {
  await mount(sample(['free']), 0)
  vi.mocked(api.resources).mockImplementation(() => new Promise(() => {}))
  await act(async () => vi.advanceTimersByTimeAsync(90001))
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('未知')
  expect(submitButton().disabled).toBe(true)
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成草稿')
  expect(container.textContent).toContain('所选 GPU 当前占用未知')
})

it('pauses on refresh failure, recovers without losing inputs, and detects revoked access during submit revalidation', async () => {
  await mount(sample(['free']))
  vi.mocked(api.resources).mockRejectedValueOnce(new TypeError('synthetic network failure'))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '刷新状态')!.click())
  expect(submitButton().disabled).toBe(true); expect(container.textContent).toContain('状态核对失败')
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成草稿')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '刷新状态')!.click())
  expect(submitButton().disabled).toBe(false)
  vi.mocked(api.resources).mockResolvedValue({ resources: [] })
  await submit()
  expect(api.reserve).not.toHaveBeenCalled(); expect(submitButton().disabled).toBe(true)
  expect(container.textContent).toContain('此资源已停用或当前账号不再有预约权限')
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成草稿')
})

it('rechecks a newly busy sample on submit and preserves the selected GPU draft after rejection', async () => {
  await mount(sample(['free']), 0)
  vi.mocked(api.resources).mockResolvedValue({ resources: [sample(['busy'])] })
  await submit()
  expect(api.reserve).not.toHaveBeenCalled(); expect(container.textContent).toContain('所选 GPU 当前被占用')
  expect(container.querySelector<HTMLInputElement>('.gpu-picker input')!.checked).toBe(true)
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成草稿')
})

it('stops renewal of withdrawn resources without modifying the existing reservation', async () => {
  const renew = vi.spyOn(api, 'renew')
  vi.mocked(api.resources).mockResolvedValue({ resources: [] })
  await act(async () => root.render(<RenewalDialog reservation={booking} t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />))
  expect(submitButton().disabled).toBe(true)
  expect(container.textContent).toContain('此资源已停用或当前账号不再有预约权限')
  await submit(); expect(renew).not.toHaveBeenCalled()
})
