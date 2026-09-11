// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { CONNECTION_RETRY_DELAY_MS } from '../utils/connectionRetry'
import { FOREGROUND_STATUS_INTERVAL_MS } from '../utils/refreshCadence'
import type { Server, Snapshot } from '../types/models'

const managedListeners = vi.hoisted(() => new Map<string, (event: { payload: { affectedIds: string[] } }) => unknown>())

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, listener: (event: { payload: { affectedIds: string[] } }) => unknown) => { managedListeners.set(name, listener); return () => managedListeners.delete(name) }) }))
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
  managedListeners.clear()
  vi.restoreAllMocks()
})

async function mount(managed?: Server['managed'], pending?: Promise<Snapshot>) {
  const servers = await api.listServers()
  const snapshot = await api.collectServer(servers[0].id)
  const server = { ...servers[0], remoteHistoryEnabled: true, managed }
  const list = vi.spyOn(api, 'listServers').mockResolvedValue([server])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue([])
  const collect = vi.spyOn(api, 'collectServer').mockRejectedValue(new Error('SSH 连接失败'))
  if (pending) collect.mockReturnValue(pending)
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
  return { collect, configure, sync, snapshot, container, list, server }
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

describe('managed server authorization changes', () => {
  const managed = { accountId: 'member', company: 'A公司', remoteId: 'cloud', available: true, reason: null, version: 1 }
  it('discards an in-flight snapshot and stops reconnecting after access is revoked', async () => {
    let complete!: (value: Snapshot) => void
    const pending = new Promise<Snapshot>(resolve => { complete = resolve })
    const { collect, snapshot, list, server } = await mount(managed, pending)
    expect(collect).toHaveBeenCalledOnce()
    list.mockResolvedValue([{ ...server, status: 'offline', lastError: '团队授权已撤销', managed: { ...managed, available: false, reason: '团队授权已撤销' } }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [server.id] } }) })
    await act(async () => { complete(snapshot); await Promise.resolve() })
    expect(document.body.textContent).not.toContain(snapshot.gpus[0]?.name)
    now += 30 * 60_000
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    expect(collect).toHaveBeenCalledOnce()
    expect(document.querySelector('.sidebar__section-header')?.textContent).toContain('0/1')
  })
  it('closes the edited managed form when its cloud configuration changes', async () => {
    const { container, list, server } = await mount({ ...managed, available: false, reason: '请先配置本机 SSH 认证' })
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    const edit = [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!
    expect(edit).toBeDefined()
    await act(async () => edit.click())
    expect(document.querySelector('.server-form')).not.toBeNull()
    list.mockResolvedValue([{ ...server, host: 'new.example.test', managed: { ...managed, available: false, reason: '请先配置本机 SSH 认证', version: 2 } }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [server.id] } }) })
    expect(document.querySelector('.server-form')).toBeNull()
    expect(container.textContent).toContain('团队服务器资源已变化')
  })
  it('ignores a late managed save after revocation instead of restoring access or starting SSH work', async () => {
    const { container, list, server, collect, configure, sync } = await mount({ ...managed, available: false, reason: '请先配置本机 SSH 认证' })
    let complete!: (server: Server) => void
    const save = vi.spyOn(api, 'saveServer').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    const edit = [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!
    await act(async () => edit.click())
    await act(async () => { container.querySelector<HTMLFormElement>('.server-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(save).toHaveBeenCalledOnce()
    list.mockResolvedValue([{ ...server, status: 'offline', lastError: '团队授权已撤销', managed: { ...managed, available: false, reason: '团队授权已撤销', version: 2 } }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [server.id] } }) })
    const configuredBefore = configure.mock.calls.length, syncedBefore = sync.mock.calls.length
    await act(async () => { complete({ ...server, managed }); await Promise.resolve() })
    expect(container.querySelector('.server-form')).toBeNull()
    expect(container.textContent).toContain('团队授权已撤销')
    expect(container.textContent).not.toContain('服务器已保存，正在连接')
    expect(configure).toHaveBeenCalledTimes(configuredBefore)
    expect(sync).toHaveBeenCalledTimes(syncedBefore)
    expect(collect).not.toHaveBeenCalled()
    now += 30 * 60_000
    await tick(FOREGROUND_STATUS_INTERVAL_MS)
    expect(collect).not.toHaveBeenCalled()
  })
  it('keeps a pending personal-server save when an unrelated managed directory entry changes', async () => {
    const { container, list, server, collect, configure } = await mount()
    let complete!: (server: Server) => void
    const save = vi.spyOn(api, 'saveServer').mockImplementation(() => new Promise(resolve => { complete = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    const edit = [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!
    await act(async () => edit.click())
    await act(async () => { container.querySelector<HTMLFormElement>('.server-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(save).toHaveBeenCalledOnce()
    list.mockResolvedValue([server])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: ['another-managed-id'] } }) })
    await act(async () => { complete(server); await Promise.resolve() })
    expect(configure).toHaveBeenCalledWith(server.id)
    expect(collect).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.server-form')).toBeNull()
    expect(container.textContent).toContain('SSH 连接失败')
  })
})
