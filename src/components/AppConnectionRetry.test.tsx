// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { CONNECTION_RETRY_DELAY_MS } from '../utils/connectionRetry'
import { FOREGROUND_STATUS_INTERVAL_MS } from '../utils/refreshCadence'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../services/appUpdater', () => ({ checkDesktopAppUpdate: vi.fn(async () => null), relaunchUpdatedApp: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
let root: ReturnType<typeof createRoot> | null = null
let now = 1_800_000_000_000
const intervals = new Map<number, { callback: () => void; delay: number }>()
let nextId = 1

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  api.isDesktop = false
  document.body.innerHTML = ''
  localStorage.clear()
  intervals.clear()
  vi.restoreAllMocks()
})

async function mount() {
  const servers = await api.listServers()
  const snapshot = await api.collectServer(servers[0].id)
  vi.spyOn(api, 'listServers').mockResolvedValue([{ ...servers[0], remoteHistoryEnabled: true }])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue([])
  const collect = vi.spyOn(api, 'collectServer').mockRejectedValue(new Error('SSH 连接失败'))
  const configure = vi.spyOn(api, 'configureRemoteHistory').mockResolvedValue(undefined)
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 0, latestTimestamp: null })
  vi.spyOn(api, 'notify').mockResolvedValue(undefined)
  vi.spyOn(api, 'retryRemoteCleanups').mockResolvedValue({ cleanedNames: [], pendingNames: [], expiredNames: [] })
  api.isDesktop = true
  now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  // Keep DOM numeric timer IDs even when dependencies bring in Node timer types.
  const browserTimers: Pick<Window, 'setInterval' | 'clearInterval'> = window
  vi.spyOn(browserTimers, 'setInterval').mockImplementation((callback, delay) => { const id = nextId++; intervals.set(id, { callback: callback as () => void, delay: delay ?? 0 }); return id })
  vi.spyOn(browserTimers, 'clearInterval').mockImplementation((id) => { if (id) intervals.delete(id) })
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root?.render(<App />); await Promise.resolve() })
  return { collect, configure, sync, snapshot, container }
}

async function tick(delay: number) {
  const entry = [...intervals.values()].find((entry) => entry.delay === delay)
  expect(entry).toBeDefined()
  await act(async () => { entry?.callback(); await Promise.resolve() })
}

describe('failed SSH connection retry scheduling', () => {
  it('waits thirty minutes across collection and five-minute history ticks, then resumes normal sampling', async () => {
    const { collect, configure, sync, snapshot, container } = await mount()
    expect(collect).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('30 分钟后自动重连')
    expect(configure).not.toHaveBeenCalled()
    now += 5 * 60_000
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    await tick(5 * 60_000)
    expect(collect).toHaveBeenCalledOnce()
    expect(sync).not.toHaveBeenCalled()
    now += 25 * 60_000 - 1
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    expect(collect).toHaveBeenCalledOnce()
    collect.mockResolvedValue(snapshot)
    now += 1
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    expect(collect).toHaveBeenCalledTimes(2)
    await tick(5 * 60_000)
    expect(sync).toHaveBeenCalledOnce()
    now += FOREGROUND_STATUS_INTERVAL_MS
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    expect(collect).toHaveBeenCalledTimes(3)
    expect(CONNECTION_RETRY_DELAY_MS).toBe(1_800_000)
  })
  it('allows a manual reconnect during the cooldown', async () => {
    const { collect, snapshot, container } = await mount()
    collect.mockResolvedValue(snapshot)
    now += 1000
    const refresh = [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新全部')
    expect(refresh).toBeDefined()
    await act(async () => { refresh?.click(); await Promise.resolve() })
    expect(collect).toHaveBeenCalledTimes(2)
  })
})
