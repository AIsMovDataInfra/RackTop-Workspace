// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as currentVersion } from '../../package.json'

const macUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const macFeed = 'https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/macos.json'
const windowsFeed = 'https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/latest.json'
const linuxFeed = 'https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/linux-amd64.json'

beforeEach(() => {
  vi.resetModules()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(macUserAgent)
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('release metadata platform routing', () => {
  it('uses the fork Mac channel and its release page for a real Mac desktop', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ version: '2.0.0', pub_date: '2026-09-09T00:00:00Z', platforms: { 'darwin-aarch64': {}, 'darwin-x86_64': {} } })))
    const { api } = await import('./api')
    await expect(api.getLatestRelease()).resolves.toEqual({ version: '2.0.0', publishedAt: '2026-09-09T00:00:00Z', url: 'https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0' })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(macFeed, { headers: { Accept: 'application/vnd.github+json' } })
  })

  it('does not fall back to upstream when the Mac channel is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }))
    const { api } = await import('./api')
    await expect(api.getLatestRelease()).rejects.toThrow('HTTP 404')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(macFeed, expect.anything())
  })

  it.each([null, {}, { version: 127 }, { version: '2.0.0/../../latest' }])('rejects an invalid Mac manifest %j', async (manifest) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(manifest)))
    const { api } = await import('./api')
    await expect(api.getLatestRelease()).rejects.toThrow('更新清单返回内容不完整')
  })

  it.each([
    ['Windows NT 10.0; Win64; x64', windowsFeed],
    ['X11; Linux x86_64', linuxFeed],
  ])('uses the independent updater feed for %s', async (userAgent, feed) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`Mozilla/5.0 (${userAgent})`)
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ version: '2.0.0' })))
    const { api } = await import('./api')
    expect((await api.getLatestRelease()).url).toBe('https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0')
    expect(fetch).toHaveBeenCalledWith(feed, expect.anything())
  })

  it('does not fetch the Mac channel in an ordinary Mac browser preview', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    const { api } = await import('./api')
    expect(api.isDesktop).toBe(false)
    expect((await api.getLatestRelease()).version).toBe(currentVersion)
    expect(fetch).not.toHaveBeenCalled()
  })
})
