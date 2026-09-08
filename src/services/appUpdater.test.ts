// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { check } from '@tauri-apps/plugin-updater'
import { checkDesktopAppUpdate, relaunchUpdatedApp } from './appUpdater'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class { onmessage: unknown } }))

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(check).mockResolvedValue(null)
})

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('desktop update platform support', () => {
  it('checks the signed Linux channel without querying the upstream feed', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    vi.mocked(invoke).mockResolvedValueOnce({ version: '1.26.0-linux.10' }).mockResolvedValueOnce(undefined)
    const update = await checkDesktopAppUpdate()
    expect(update?.version).toBe('1.26.0-linux.10')
    expect(invoke).toHaveBeenCalledWith('check_linux_update')
    const events = vi.fn()
    await update?.downloadAndInstall(events)
    expect(invoke).toHaveBeenLastCalledWith('install_linux_update', expect.objectContaining({ version: '1.26.0-linux.10' }))
    const channel = (vi.mocked(invoke).mock.calls.at(-1)?.[1] as { onEvent: { onmessage: (event: unknown) => void } }).onEvent
    channel.onmessage({ event: 'Progress', data: { chunkLength: 100 } })
    expect(events).toHaveBeenCalledWith({ event: 'Progress', data: { chunkLength: 100 } })
    expect(check).not.toHaveBeenCalled()
  })

  it('reports no Linux update and preserves check errors', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    vi.mocked(invoke).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('network unavailable'))
    await expect(checkDesktopAppUpdate()).resolves.toBeNull()
    await expect(checkDesktopAppUpdate()).rejects.toThrow('network unavailable')
  })

  it.each(['Windows NT 10.0', 'Macintosh; Intel Mac OS X 10_15_7'])('uses the platform-configured native updater on %s', async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${platform})`)
    await expect(checkDesktopAppUpdate()).resolves.toBeNull()
    expect(check).toHaveBeenCalledWith({ timeout: 30_000 })
    expect(invoke).not.toHaveBeenCalled()
    await relaunchUpdatedApp()
    expect(relaunch).toHaveBeenCalledOnce()
  })

  it('relaunches Linux through its package installer integration', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    await relaunchUpdatedApp()
    expect(invoke).toHaveBeenCalledWith('relaunch_linux_app')
    expect(relaunch).not.toHaveBeenCalled()
  })

  it.each(['Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64', 'Windows NT 10.0'])('does not call native update APIs from a browser with %s', async (platform) => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${platform})`)
    await expect(checkDesktopAppUpdate()).resolves.toBeNull()
    await expect(relaunchUpdatedApp()).rejects.toThrow('仅在 RackTop 桌面端')
    expect(check).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })
})
