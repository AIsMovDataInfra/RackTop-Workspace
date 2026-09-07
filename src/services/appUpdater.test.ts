// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { check } from '@tauri-apps/plugin-updater'
import { checkDesktopAppUpdate } from './appUpdater'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))

beforeEach(() => vi.mocked(check).mockResolvedValue(null))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('desktop update platform support', () => {
  it('explains manual Linux updates without querying the macOS/Windows feed', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    await expect(checkDesktopAppUpdate()).rejects.toThrow('github.com/AIsMovDataInfra/RackTop/releases')
    expect(check).not.toHaveBeenCalled()
  })

  it.each(['Windows NT 10.0', 'Macintosh; Intel Mac OS X 10_15_7'])('preserves updates on %s', async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${platform})`)
    await expect(checkDesktopAppUpdate()).resolves.toBeNull()
    expect(check).toHaveBeenCalledWith({ timeout: 30_000 })
  })
})
