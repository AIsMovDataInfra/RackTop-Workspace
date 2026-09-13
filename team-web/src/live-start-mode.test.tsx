import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from './api'
import { Workspace } from './Workspace'
import { ReservationDialog } from './ReservationDialog'
import { ResourceCard } from './ResourceCard'
import { beijingInput, bookingPayload, initialWindow, inputToIso } from './time'
import type { PreferencesState } from './preferences'
import type { BookingStartMode, Resource, Session, UsageState } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const timestamp = Date.parse('2030-09-09T02:02:30Z')
const t = (zh: string) => zh
const session: Session = { user: { id: 'member', name: '合成成员', role: 'member', company: 'A公司' }, csrfToken: 'fixture', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const preferences: PreferencesState = { t, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
function resource(states: UsageState[], users: string[] = ['synthetic-worker']): Resource {
  return { id: 'synthetic', name: '合成集群', cluster: '合成机房', gpuCount: states.length, gpuModel: 'H200', enabled: true, notes: '', inventoryVersion: 1, inventoryState: 'synced',
    gpus: states.map((_, index) => ({ id: `gpu-${index}`, uuid: `GPU-${index}`, index, model: 'H200', memoryTotalMb: 80000 })),
    usage: { state: states.includes('busy') ? 'busy' : states.includes('unknown') ? 'unknown' : 'free', observedAt: new Date().toISOString(), gpus: states.map((state, index) => ({ id: `gpu-${index}`, uuid: `GPU-${index}`, index, state, users: state === 'busy' ? users : [], utilization: state === 'busy' ? 80 : 0, memoryUsedMb: state === 'busy' ? 4000 : 0 })) } }
}
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(timestamp); window.history.replaceState({}, '', '/'); container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(api, 'resources').mockImplementation(async () => ({ resources: [resource(['free'])] })); vi.spyOn(api, 'reservations').mockResolvedValue({ reservations: [] }); vi.spyOn(api, 'reserve').mockResolvedValue({ reservation: {} as never }) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
function enter(selector: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; expect(input).not.toBeNull(); act(() => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()) }
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function board() { await act(async () => root.render(<Workspace session={session} state={preferences} onLogout={vi.fn()} onSessionExpired={vi.fn()} />)) }
async function dialog(value = resource(['free']), mode: BookingStartMode = 'now', initialGpu?: number) { vi.mocked(api.resources).mockImplementation(async () => ({ resources: [{ ...value, usage: value.usage ? { ...value.usage, observedAt: new Date().toISOString() } : undefined }] })); await act(async () => root.render(<ReservationDialog resource={value} initialMode={mode} initialGpu={initialGpu} start="2030-09-09T11:00" end="2030-09-09T13:00" t={t} locale="zh-CN" onClose={vi.fn()} onSaved={vi.fn()} />)); enter('textarea', '保留合成用途') }
const confirmation = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

it('defaults to now and keeps all busy GPUs visible; future booking is an explicit choice with live labels still present', async () => {
  vi.mocked(api.resources).mockResolvedValue({ resources: [resource(['busy', 'busy'], [])] })
  await board()
  expect(container.querySelector('.booking-mode button[aria-pressed="true"]')?.textContent).toBe('现在使用')
  expect(container.querySelector('[aria-label="看板开始时间"]')).toBeNull()
  expect([...container.querySelectorAll<HTMLButtonElement>('.gpu-tile')].every(item => item.disabled)).toBe(true)
  expect(container.querySelectorAll('.gpu-current-usage')).toHaveLength(2)
  expect(container.querySelector('.gpu-current-usage')?.textContent).toContain('匿名用户')
  await click('.time-filter .booking-mode button:last-child')
  expect(container.querySelector('[aria-label="看板开始时间"]')).not.toBeNull()
  expect([...container.querySelectorAll<HTMLButtonElement>('.gpu-tile')].every(item => !item.disabled)).toBe(true)
  expect([...container.querySelectorAll('.gpu-current-usage')].every(item => item.textContent?.includes('当前被占用'))).toBe(true)
  expect(container.querySelector('.gpu-tile')?.textContent).toContain('仅预约未来时段')
})

it('shows current busy/free/unknown and anonymous names in the future GPU picker without treating booking intent as current usage', async () => {
  await dialog(resource(['busy', 'free', 'unknown'], []), 'scheduled', 0)
  const labels = [...container.querySelectorAll('.gpu-picker .gpu-current-usage')].map(item => item.textContent)
  expect(labels).toEqual(['当前被占用匿名用户', '当前空闲', '当前状态未知'])
  expect([...container.querySelectorAll<HTMLInputElement>('.gpu-picker input')].every(input => !input.disabled)).toBe(true)
  expect(confirmation().disabled).toBe(false)
  await submit()
  expect(api.reserve).toHaveBeenCalledWith(expect.objectContaining({ startMode: 'scheduled', startAt: '2030-09-09T03:00:00.000Z', gpuIds: ['gpu-0'] }))
})

it('lets an immediate draft sit for minutes and retries with the same request ID without sending a stale or changing start timestamp', async () => {
  await dialog()
  expect(container.querySelector('[aria-label="开始时间"]')).toBeNull()
  expect(confirmation().textContent).toContain('确认现在使用')
  await act(async () => vi.advanceTimersByTimeAsync(125_000))
  vi.mocked(api.reserve).mockRejectedValueOnce(new TypeError('synthetic uncertain result'))
  await submit()
  const first = vi.mocked(api.reserve).mock.calls[0][0]
  expect(first.startMode).toBe('now'); expect(first.startAt).toBeUndefined()
  await act(async () => vi.advanceTimersByTimeAsync(65_000))
  await submit()
  const second = vi.mocked(api.reserve).mock.calls[1][0]
  expect(second).toEqual(first)
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成用途')
})

it('blocks explicit future times within one minute and refreshes eligibility as the selected start approaches', async () => {
  await dialog(resource(['free']), 'scheduled', 0)
  enter('[aria-label="开始时间"]', '2030-09-09T10:04')
  expect(confirmation().disabled).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(30_001))
  expect(confirmation().disabled).toBe(true)
  expect(container.textContent).toContain('未来预约须至少提前 1 分钟')
  await submit(); expect(api.reserve).not.toHaveBeenCalled()
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留合成用途')
})

it('expires a future card’s busy names independently of its future booking eligibility', async () => {
  const value = resource(['busy'])
  await act(async () => root.render(<ResourceCard mode="scheduled" resource={value} reservations={[]} start="2030-09-09T03:00:00Z" end="2030-09-09T04:00:00Z" complete t={t} locale="zh-CN" onReserve={vi.fn()} onDetails={vi.fn()} />))
  await act(async () => vi.advanceTimersByTimeAsync(89_999))
  expect(container.querySelector('.gpu-current-usage')?.textContent).toContain('synthetic-worker')
  await act(async () => vi.advanceTimersByTimeAsync(2))
  expect(container.querySelector('.gpu-current-usage')?.textContent).toBe('当前状态未知')
  expect(container.textContent).not.toContain('synthetic-worker')
  expect(container.querySelector<HTMLButtonElement>('.gpu-tile')!.disabled).toBe(false)
  expect(container.querySelector('.gpu-tile')?.textContent).toContain('仅预约未来时段')
})

it('updates resource usage when the selected schedule fails and marks booking counts unverified instead of unreserved', async () => {
  await board()
  vi.mocked(api.resources).mockResolvedValue({ resources: [resource(['busy'], ['new-worker'])] })
  vi.mocked(api.reservations).mockImplementation(async options => { if (!options?.mine) throw new TypeError('synthetic schedule failure'); return { reservations: [] } })
  await click('[aria-label="刷新排期"]')
  expect(container.querySelector('.gpu-current-usage')?.textContent).toContain('new-worker')
  expect(container.querySelector('.gpu-booking-label')?.textContent).toBe('排期待核验')
  expect(container.querySelector('.resource-hardware')?.textContent).not.toContain('未预约')
  expect(container.querySelector<HTMLButtonElement>('.gpu-tile')!.disabled).toBe(true)
})

it('does not drop successful live data or a verified schedule when only the member’s own reservations fail', async () => {
  vi.mocked(api.resources).mockResolvedValue({ resources: [resource(['busy'])] })
  vi.mocked(api.reservations).mockImplementation(async options => { if (options?.mine) throw new TypeError('synthetic mine failure'); return { reservations: [] } })
  await board()
  expect(container.querySelector('.gpu-current-usage')?.textContent).toContain('当前被占用')
  expect(container.querySelector('.gpu-booking-label')?.textContent).toBe('此时段未预约')
  expect(container.querySelector('.error')?.textContent).toContain('网络连接失败')
})

it('marks retained usage unknown immediately after a resource read fails even if reservations still load', async () => {
  await board()
  vi.mocked(api.resources).mockRejectedValueOnce(new TypeError('synthetic resources failure'))
  await click('[aria-label="刷新排期"]')
  expect(container.querySelector('.gpu-current-usage')?.textContent).toBe('当前状态未知')
  expect(container.querySelector<HTMLButtonElement>('.gpu-tile')!.disabled).toBe(true)
})

it('preserves the manual CPU whole-machine flow without labeling its unknown telemetry idle', async () => {
  const cpu = { ...resource([]), usage: undefined }
  await dialog(cpu)
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('未知')
  expect(container.querySelector('input[value="gpus"]')).toBeNull()
  expect(confirmation().disabled).toBe(false)
  await submit()
  expect(api.reserve).toHaveBeenCalledWith(expect.objectContaining({ startMode: 'now', scope: 'machine', gpuIndices: [] }))
})

it('uses current default input and leaves stable now payloads independent of client time; future inputs require one minute lead time', () => {
  expect(inputToIso(initialWindow().start)).toBe('2030-09-09T02:02:00.000Z')
  const values = { resourceId: 'resource', scope: 'machine' as const, gpuIndices: [], start: '1999-01-01T00:00', end: beijingInput(timestamp + 3600000), purpose: 'fixture', startMode: 'now' as const }
  expect(bookingPayload(values)).not.toHaveProperty('startAt')
  expect(() => bookingPayload({ ...values, startMode: 'scheduled', start: beijingInput(timestamp + 30_000) })).toThrow('1 分钟')
})

it('releases an elapsed reservation in now mode even when the broad schedule query still contains it', async () => {
  const current = { id: 'elapsed', resourceId: 'synthetic', resourceName: '合成集群', cluster: '合成机房', ownerName: 'another-booker', scope: 'machine' as const, gpuIndices: [], startAt: new Date(timestamp - 60_000).toISOString(), endAt: new Date(timestamp + 20_000).toISOString(), status: 'confirmed' as const, version: 1, createdAt: new Date(timestamp).toISOString(), updatedAt: new Date(timestamp).toISOString() }
  vi.mocked(api.reservations).mockImplementation(async options => ({ reservations: options?.mine ? [] : [current] }))
  await board()
  expect(container.querySelector<HTMLButtonElement>('.gpu-tile')!.disabled).toBe(true)
  expect(container.querySelector('.gpu-booking-label')?.textContent).toBe('another-booker')
  await act(async () => vi.advanceTimersByTimeAsync(30_001))
  expect(container.querySelector<HTMLButtonElement>('.gpu-tile')!.disabled).toBe(false)
  expect(container.querySelector('.gpu-booking-label')?.textContent).toBe('此时段未预约')
  expect(container.querySelectorAll('.schedule-row')).toHaveLength(0)
})

it('announces current occupancy and anonymous users independently from schedule status in English', async () => {
  const value = resource(['busy', 'unknown'], [])
  await act(async () => root.render(<ResourceCard mode="scheduled" resource={value} reservations={[]} start="2030-09-09T03:00:00Z" end="2030-09-09T04:00:00Z" complete t={(_zh, en) => en} locale="en" onReserve={vi.fn()} onDetails={vi.fn()} />))
  const tiles = [...container.querySelectorAll<HTMLButtonElement>('.gpu-tile')]
  expect(tiles[0].getAttribute('aria-label')).toContain('Occupied now · Anonymous user; Unreserved in this slot')
  expect(tiles[1].getAttribute('aria-label')).toContain('Usage unknown; Unreserved in this slot')
  expect(tiles[0].textContent).toContain('Future booking only')
})
