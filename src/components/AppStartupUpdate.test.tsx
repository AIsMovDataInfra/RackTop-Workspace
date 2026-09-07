// @vitest-environment jsdom

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { loadCachedUpdate, saveCachedUpdate, UPDATE_CHECK_INTERVAL_MS } from '../utils/updateCheck'
import packageInfo from '../../package.json'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
})

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('App startup update check', () => {
  it('checks on app mount without resetting the persisted 24-hour schedule', async () => {
    const now = 1_800_000_000_000
    const lastScheduledCheckAt = now - 20 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    saveCachedUpdate({ lastCheckedAt: now, lastScheduledCheckAt, release: undefined })
    const setTimeout = vi.spyOn(window, 'setTimeout')
    const getLatestRelease = vi.spyOn(api, 'getLatestRelease').mockResolvedValue({
      version: '1.25.4',
      url: 'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4',
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<StrictMode><App /></StrictMode>)
      await Promise.resolve()
    })

    expect(getLatestRelease).toHaveBeenCalledOnce()
    expect(loadCachedUpdate().lastScheduledCheckAt).toBe(lastScheduledCheckAt)
    const remainingDelay = 4 * 60 * 60 * 1000
    const scheduledCheck = setTimeout.mock.calls.find(([, delay]) => delay === remainingDelay)?.[0]
    expect(scheduledCheck).toBeTypeOf('function')
    if (typeof scheduledCheck !== 'function') throw new Error('Scheduled update callback was not registered')
    await act(async () => {
      scheduledCheck()
      await Promise.resolve()
    })
    expect(getLatestRelease).toHaveBeenCalledTimes(2)
    expect(loadCachedUpdate().lastScheduledCheckAt).toBe(now)
  })

  it('opens the current release notes from the About update row', async () => {
    vi.spyOn(api, 'getLatestRelease').mockResolvedValue({
      version: '1.25.4',
      url: 'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4',
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<App />)
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="关于 RackTop"]')?.click()
    })
    const releaseNotes = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '版本说明')
    expect(releaseNotes).toBeDefined()
    await act(async () => releaseNotes?.click())
    expect(open).toHaveBeenCalledWith(
      `https://github.com/AIsMovDataInfra/RackTop/releases/tag/v${packageInfo.version}`,
      '_blank',
      'noopener,noreferrer',
    )
    const xiaohongshu = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('小红书'))
    expect(xiaohongshu).toBeDefined()
    await act(async () => xiaohongshu?.click())
    expect(open).toHaveBeenLastCalledWith(
      'https://xhslink.cn/o/AsgFqJMZfR5',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('identifies the current maintainer separately from the original author and opens fork help links', async () => {
    vi.spyOn(api, 'getLatestRelease').mockResolvedValue({
      version: packageInfo.version,
      url: `https://github.com/AIsMovDataInfra/RackTop/releases/tag/v${packageInfo.version}`,
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root?.render(<App />) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="关于 RackTop"]')?.click() })

    const about = container.querySelector('.about-sheet')!
    const maintainer = about.querySelector('section[aria-label="当前维护者"]')!
    const originalAuthor = about.querySelector('section[aria-label="原作者"]')!
    expect(maintainer.textContent).toContain('AIsMov')
    expect(originalAuthor.textContent).toContain('Tongzh-SEU')
    expect(originalAuthor.textContent).toContain('原作者')
    expect(originalAuthor.textContent).not.toContain('维护者')
    expect(maintainer.compareDocumentPosition(originalAuthor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(maintainer.querySelector('img')).toBeNull()
    expect(originalAuthor.querySelector('img')?.alt).toBe('原作者 Tongzh-SEU 头像')
    expect(about.textContent).toContain('GPL-3.0')

    for (const [label, url] of [
      ['GitHub @AIsMovDataInfra', 'https://github.com/AIsMovDataInfra'],
      ['GitHub 仓库', 'https://github.com/AIsMovDataInfra/RackTop'],
      ['使用说明', 'https://github.com/AIsMovDataInfra/RackTop/blob/main/README.md'],
      ['问题反馈', 'https://github.com/AIsMovDataInfra/RackTop/issues'],
      ['上游项目', 'https://github.com/Tongzh-SEU/RackTop'],
    ]) {
      const link = [...about.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label))
      expect(link, label).toBeDefined()
      await act(async () => { link?.click() })
      expect(open).toHaveBeenLastCalledWith(url, '_blank', 'noopener,noreferrer')
    }
  })
})
