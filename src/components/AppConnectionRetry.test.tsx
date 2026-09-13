// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { CONNECTION_RETRY_DELAY_MS } from '../utils/connectionRetry'
import { FOREGROUND_STATUS_INTERVAL_MS } from '../utils/refreshCadence'
import type { Server, Snapshot } from '../types/models'
import * as serverMenus from '../services/serverContextMenu'

const managedListeners = vi.hoisted(() => new Map<string, (event: { payload: { affectedIds: string[]; scopeChanged?: boolean } }) => unknown>())
const managedRegistration = vi.hoisted(() => ({ ready: null as Promise<void> | null }))

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, listener: (event: { payload: { affectedIds: string[]; scopeChanged?: boolean } }) => unknown) => { if (name === 'managed-servers-changed' && managedRegistration.ready) await managedRegistration.ready; managedListeners.set(name, listener); return () => managedListeners.delete(name) }) }))
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
  managedRegistration.ready = null
  vi.restoreAllMocks()
})

async function mount(managed?: Server['managed'], pending?: Promise<Snapshot>, setup?: {
  servers?: (server: Server) => Server[]
  snapshots?: (snapshot: Snapshot, server: Server) => Snapshot[]
  listenReady?: Promise<void>
}) {
  const servers = await api.listServers()
  const snapshot = await api.collectServer(servers[0].id)
  const server = { ...servers[0], remoteHistoryEnabled: true, managed }
  const list = vi.spyOn(api, 'listServers').mockResolvedValue(setup?.servers?.(server) ?? [server])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue(setup?.snapshots?.(snapshot, server) ?? [])
  const collect = vi.spyOn(api, 'collectServer').mockRejectedValue(new Error('SSH 连接失败'))
  if (pending) collect.mockReturnValue(pending)
  const configure = vi.spyOn(api, 'configureRemoteHistory').mockResolvedValue(undefined)
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 0, latestTimestamp: null })
  vi.spyOn(api, 'notify').mockResolvedValue(undefined)
  vi.spyOn(api, 'retryRemoteCleanups').mockResolvedValue({ cleanedNames: [], pendingNames: [], expiredNames: [] })
  api.isDesktop = true
  managedRegistration.ready = setup?.listenReady ?? null
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

describe('current account server presentation', () => {
  const managed = { accountId: 'member', company: 'A公司', remoteId: 'cloud', available: true, reason: null, version: 1 }

  it('waits for native listener registration and rejects a startup response from the previous scope', async () => {
    let register!: () => void
    const { container, list, server } = await mount(managed, new Promise(() => {}), {
      listenReady: new Promise(resolve => { register = resolve }),
      snapshots: snapshot => [snapshot],
    })
    expect(list).not.toHaveBeenCalled()
    let finishOldList!: (servers: Server[]) => void
    const next = { ...server, id: 'new-account-server', name: 'CurrentAccountConnection', managed: { ...managed, accountId: 'super-admin' } }
    list.mockReturnValueOnce(new Promise(resolve => { finishOldList = resolve })).mockResolvedValue([next])
    await act(async () => { register(); await Promise.resolve() })
    expect(list).toHaveBeenCalledOnce()
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [], scopeChanged: true } }) })
    await act(async () => { finishOldList([server]); await Promise.resolve() })
    expect(list).toHaveBeenCalledTimes(3)
    expect(container.querySelectorAll('.server-row')).toHaveLength(1)
    expect(container.querySelector('.server-list')?.textContent).toContain(next.name)
    expect(container.querySelector('.server-list')?.textContent).not.toContain(server.name)
    expect(container.querySelector('.primary-nav .nav-count')?.textContent).toBe('0')
  })

  it('shows a listener registration failure without restoring an unobserved account list', async () => {
    let failRegistration!: (reason: Error) => void
    const { container, list } = await mount(managed, undefined, {
      listenReady: new Promise((_resolve, reject) => { failRegistration = reject }),
    })
    await act(async () => { failRegistration(new Error('目录通知注册失败')); await Promise.resolve() })
    expect(list).not.toHaveBeenCalled()
    expect(container.textContent).toContain('读取本机资料失败')
    expect(container.textContent).toContain('目录通知注册失败')
  })

  it('does not start the initial read when unmounted before listener registration finishes', async () => {
    let register!: () => void
    const { list } = await mount(managed, undefined, { listenReady: new Promise(resolve => { register = resolve }) })
    act(() => root?.unmount()); root = null
    await act(async () => { register(); await Promise.resolve() })
    expect(list).not.toHaveBeenCalled()
    expect(managedListeners.has('managed-servers-changed')).toBe(false)
  })

  it('preserves snapshots and an unaffected terminal during an ordinary empty metadata event', async () => {
    const { container, list, server, snapshot } = await mount(managed, new Promise(() => {}), {
      servers: server => [server, { ...server, id: 'unaffected-server', name: 'UnaffectedConnection' }],
      snapshots: snapshot => [snapshot, { ...snapshot, serverId: 'unaffected-server' }],
    })
    vi.spyOn(serverMenus, 'popupServerContextMenu').mockImplementation(async (_x, _y, _settings, actions) => { actions.openTerminal() })
    await act(async () => { container.querySelectorAll('.server-row')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    const terminal = container.querySelector('.quick-terminal-sheet')
    expect(terminal).not.toBeNull()
    list.mockResolvedValue([{ ...server, name: 'RenamedConnection' }, { ...server, id: 'unaffected-server', name: 'UnaffectedConnection' }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [] } }) })
    expect(container.querySelector('.quick-terminal-sheet')).toBe(terminal)
    expect(container.querySelectorAll('.server-row')).toHaveLength(2)
    expect(container.querySelector('.server-list')?.textContent).toContain('RenamedConnection')
    expect(container.querySelector('.primary-nav .nav-count')?.textContent).toBe(String(snapshot.gpus.length * 2))
  })

  it('does not retry a saved connection history setup after switching away from that account', async () => {
    const { container, list, server, configure, sync, collect } = await mount({ ...managed, available: false, reason: '请先配置本机 SSH 认证' })
    let failConfiguration!: (reason: Error) => void
    configure.mockReturnValue(new Promise((_resolve, reject) => { failConfiguration = reject }))
    collect.mockReturnValue(new Promise(() => {}))
    vi.spyOn(api, 'saveServer').mockResolvedValue({ ...server, managed })
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!.click())
    await act(async () => { container.querySelector<HTMLFormElement>('.server-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(configure).toHaveBeenCalled()
    list.mockResolvedValue([])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [], scopeChanged: true } }) })
    const timeout = vi.spyOn(window, 'setTimeout')
    await act(async () => { failConfiguration(new Error('LatePreviousAccountHistoryFailure')); await Promise.resolve() })
    expect(timeout.mock.calls.some(call => call[1] === 900 || call[1] === 1800)).toBe(false)
    expect(sync).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('LatePreviousAccountHistoryFailure')
  })

  it('does not restore orphaned snapshots when the native list is already scoped to a different account', async () => {
    const { container, snapshot } = await mount(managed, new Promise(() => {}), {
      snapshots: (snapshot, server) => [snapshot, {
        ...snapshot, serverId: 'old-account-server',
        gpus: [{ ...snapshot.gpus[0], name: 'PreviousAccountGPU', uuid: 'previous-account-gpu' }],
      }].map(value => value.serverId === snapshot.serverId ? { ...value, serverId: server.id } : value),
    })
    const gpuSummary = [...container.querySelectorAll('.fleet-summary > span')].find(item => item.textContent?.includes('加速卡总数'))
    expect(gpuSummary?.querySelector('strong')?.textContent).toBe(String(snapshot.gpus.length))
    expect(container.textContent).not.toContain('PreviousAccountGPU')
    expect(container.querySelectorAll('.server-row')).toHaveLength(1)
  })

  it('reselects the new same-name connection on an empty scope-change event and rejects the late old snapshot', async () => {
    let completeOld!: (value: Snapshot) => void
    const { container, list, server, snapshot, collect } = await mount(managed, new Promise(resolve => { completeOld = resolve }))
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    const next = { ...server, id: 'new-account-server', host: 'new-scope.example.test', status: 'offline' as const,
      managed: { ...managed, accountId: 'super-admin', available: false, reason: '请先配置本机 SSH 认证' } }
    let finishList!: (servers: Server[]) => void
    list.mockReturnValue(new Promise(resolve => { finishList = resolve }))
    let changing!: Promise<unknown>
    await act(async () => { changing = managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [], scopeChanged: true } }) as Promise<unknown> })
    expect(container.querySelectorAll('.server-row')).toHaveLength(0)
    await act(async () => { finishList([next]); await changing })
    expect(container.querySelectorAll('.server-row')).toHaveLength(1)
    expect(container.querySelector('.server-row.is-selected')).not.toBeNull()
    expect(container.querySelector('.topbar__title .eyebrow')?.textContent).toBe(next.host)
    await act(async () => { completeOld({ ...snapshot, gpus: [{ ...snapshot.gpus[0], name: 'LatePreviousAccountGPU' }] }); await Promise.resolve() })
    expect(container.textContent).not.toContain('LatePreviousAccountGPU')
    expect(container.querySelector('.primary-nav .nav-count')?.textContent).toBe('0')
    expect(collect).toHaveBeenCalledOnce()
    const edit = [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!
    await act(async () => edit.click())
    expect(container.querySelector('.server-form')).not.toBeNull()
  })

  it('removes already-unavailable old rows on an empty event while preserving personal connections', async () => {
    const { container, list, server } = await mount({ ...managed, available: false, reason: '当前账号无权限' }, undefined, {
      servers: server => [server, { ...server, id: 'personal-server', name: 'PersonalConnection', managed: null, remoteHistoryEnabled: false }],
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    list.mockResolvedValue([{ ...server, id: 'personal-server', name: 'PersonalConnection', managed: null }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [], scopeChanged: true } }) })
    expect(container.querySelectorAll('.server-row')).toHaveLength(1)
    expect(container.querySelector('.server-row.is-selected')?.textContent).toContain('PersonalConnection')
    expect(container.querySelector('.server-list')?.textContent).not.toContain(server.name)
  })

  it('invalidates removed managed IDs even when they are missing from a nonempty event payload', async () => {
    let completeOld!: (value: Snapshot) => void
    const { container, list, snapshot } = await mount(managed, new Promise(resolve => { completeOld = resolve }))
    list.mockResolvedValue([])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: ['another-managed-server'] } }) })
    await act(async () => { completeOld(snapshot); await Promise.resolve() })
    expect(container.querySelectorAll('.server-row')).toHaveLength(0)
    expect(container.querySelector('.primary-nav .nav-count')?.textContent).toBe('0')
    expect(container.textContent).toContain('连接第一台服务器')
  })

  it('refreshes only eligible personal and managed connections without permission toasts or inflated progress', async () => {
    const { container, collect, configure, sync, snapshot, server } = await mount({ ...managed, available: false, reason: 'KnownUnavailableReason' }, undefined, {
      servers: server => [server,
        { ...server, id: 'personal-server', managed: null },
        { ...server, id: 'current-managed-server', managed },
      ],
    })
    collect.mockClear().mockImplementation(async id => ({ ...snapshot, serverId: id }))
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === '刷新全部')!
    await act(async () => refresh.click())
    expect(collect.mock.calls.map(call => call[0]).sort()).toEqual(['current-managed-server', 'personal-server'])
    expect(container.textContent).toContain('2/2 台')
    expect(container.querySelector('.toast')?.textContent ?? '').not.toContain('KnownUnavailableReason')
    expect(configure.mock.calls.some(call => call[0] === server.id)).toBe(false)
    expect(sync.mock.calls.some(call => call[0] === server.id)).toBe(false)
    expect(container.querySelectorAll('.server-row')).toHaveLength(3)
  })

  it('keeps current missing-authentication entries editable without attempting batch SSH or history sync', async () => {
    const { container, collect, configure, sync } = await mount({ ...managed, available: false, reason: '请先配置本机 SSH 认证' })
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === '刷新全部')!
    await act(async () => refresh.click())
    expect(collect).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(container.textContent).toContain('当前没有可重新连接的服务器')
    await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
    const edit = [...container.querySelectorAll('button')].find(button => button.textContent === '编辑配置')!
    await act(async () => edit.click())
    expect(container.querySelector('.server-form')).not.toBeNull()
  })

  it('allows a new-account refresh while an old batch finishes without overwriting the new progress', async () => {
    const { container, collect, list, server, snapshot } = await mount(managed)
    let finishOld!: (value: Snapshot) => void
    let finishNew!: (value: Snapshot) => void
    const oldResult = new Promise<Snapshot>(resolve => { finishOld = resolve })
    const newResult = new Promise<Snapshot>(resolve => { finishNew = resolve })
    collect.mockImplementation(id => id === 'new-account-server' ? newResult : oldResult)
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === '刷新全部')!
    await act(async () => refresh.click())
    expect(refresh.disabled).toBe(true)
    list.mockResolvedValue([{ ...server, id: 'new-account-server', managed: { ...managed, accountId: 'super-admin' } }])
    await act(async () => { await managedListeners.get('managed-servers-changed')!({ payload: { affectedIds: [], scopeChanged: true } }) })
    expect(refresh.disabled).toBe(false)
    await act(async () => refresh.click())
    expect(refresh.disabled).toBe(true)
    await act(async () => { finishOld(snapshot); await Promise.resolve() })
    expect(refresh.disabled).toBe(true)
    expect(container.textContent).toContain('0/1 台')
    await act(async () => { finishNew({ ...snapshot, serverId: 'new-account-server' }); await Promise.resolve() })
    expect(refresh.disabled).toBe(false)
    expect(container.textContent).toContain('1/1 台')
  })
})
