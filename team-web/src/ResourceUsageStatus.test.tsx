import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResourceUsageStatus } from './ResourceUsageStatus'
import { ResourceCard } from './ResourceCard'
import type { Reservation, Resource } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const now = Date.parse('2030-09-09T02:00:00Z')
const t = (zh: string, _en: string) => zh
const resource: Resource = { id: 'gpu-server', name: '合成 GPU 服务器', cluster: '上海', gpuCount: 1, gpuModel: 'A100', enabled: true, notes: '',
  usage: { state: 'busy', observedAt: new Date(now).toISOString(), gpus: [{ id: 'gpu-1', uuid: 'GPU-1', index: 0, state: 'busy', users: ['linux-worker'], utilization: 85, memoryUsedMb: 8192 }] } }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })

it('shows system users separately from reservation owners and keeps the future reservation action available', async () => {
  const booking: Reservation = { id: 'future', resourceId: resource.id, resourceName: resource.name, cluster: '上海', ownerName: '未来预约同学', scope: 'machine', gpuIndices: [], startAt: '2030-09-10T02:00:00Z', endAt: '2030-09-10T03:00:00Z', status: 'confirmed', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), version: 1 }
  const reserve = vi.fn()
  await act(async () => root.render(<ResourceCard resource={resource} reservations={[booking]} start={booking.startAt} end={booking.endAt} locale="zh-CN" t={t} complete onReserve={reserve} onDetails={vi.fn()} />))
  const usage = container.querySelector('[aria-label="当前实际占用"]')!
  expect(usage.textContent).toContain('linux-worker')
  expect(usage.textContent).not.toContain('未来预约同学')
  expect(container.querySelector('.resource-schedule')?.textContent).toContain('未来预约同学')
  expect(container.textContent).toContain('预约不会自动停止现有任务')
  const button = container.querySelector<HTMLButtonElement>('article > header > button')!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(reserve).toHaveBeenCalledWith()
})

it('uses anonymous user when a busy sample has no names, then expires without a network refresh', async () => {
  const unnamed = { ...resource, usage: { ...resource.usage!, gpus: [{ ...resource.usage!.gpus[0], users: [] }] } }
  await act(async () => root.render(<ResourceUsageStatus resource={unnamed} locale="zh-CN" t={t} />))
  expect(container.textContent).toContain('匿名用户')
  await act(async () => vi.advanceTimersByTime(90_001))
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('未知')
  expect(container.textContent).toContain('采样已超过 90 秒')
  expect(container.textContent).not.toContain('匿名用户')
  expect(container.querySelectorAll('li')).toHaveLength(0)
})

it('shows old resources without telemetry as unknown in English', async () => {
  await act(async () => root.render(<ResourceUsageStatus resource={{ ...resource, usage: undefined }} locale="en" t={(_zh, en) => en} />))
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('Unknown')
  expect(container.textContent).not.toContain('Idle')
})
