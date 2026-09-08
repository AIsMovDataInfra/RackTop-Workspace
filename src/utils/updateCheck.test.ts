import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNewerVersion, releaseUrl, shouldShowUpdateBadge } from './updateCheck'

afterEach(() => vi.unstubAllGlobals())

describe('update checks', () => {
  it('opens community release notes for Linux versions and upstream notes for official versions', () => {
    expect(releaseUrl('1.26.0-linux.2')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.2')
    expect(releaseUrl('v1.26.0-linux.2')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.2')
    expect(releaseUrl('v1.25.4')).toBe('https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4')
  })

  it('opens fork release notes for a native Mac build without a Linux suffix', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(releaseUrl('1.27.0')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.27.0')
    expect(releaseUrl('v1.27.0')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.27.0')
  })

  it('keeps native Windows release notes on the upstream repository', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(releaseUrl('1.27.0')).toBe('https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.27.0')
    expect(releaseUrl('1.26.0-linux.9')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.9')
  })

  it('does not mistake an ordinary Mac browser for the native community app', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(releaseUrl('1.27.0')).toBe('https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.27.0')
    expect(releaseUrl('1.26.0-linux.9')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.9')
  })

  it('retains the explicit Linux release channel without inferring Mac from a server render', () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('navigator', undefined)
    expect(releaseUrl('1.26.0-linux.9')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.9')
    expect(releaseUrl('1.27.0')).toBe('https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.27.0')
  })

  it('compares semantic versions numerically', () => {
    expect(isNewerVersion('v1.25.0', '1.24.5')).toBe(true)
    expect(isNewerVersion('v1.24.5', '1.24.5')).toBe(false)
    expect(isNewerVersion('v1.9.0', '1.10.0')).toBe(false)
    expect(isNewerVersion('1.26.0-linux.4', '1.26.0-linux.3')).toBe(true)
    expect(isNewerVersion('1.26.0-linux.10', '1.26.0-linux.9')).toBe(true)
    expect(isNewerVersion('1.26.0-linux.4', '1.26.0-linux.4')).toBe(false)
    expect(isNewerVersion('1.26.0-linux.3', '1.26.0-linux.4')).toBe(false)
    expect(isNewerVersion('1.26.0', '1.26.0-linux.4')).toBe(true)
    expect(isNewerVersion('invalid', '1.26.0-linux.4')).toBe(false)
  })

  it('hides only the ignored release and reappears for a newer release', () => {
    expect(shouldShowUpdateBadge('1.25.0', undefined)).toBe(true)
    expect(shouldShowUpdateBadge('1.25.0', '1.25.0')).toBe(false)
    expect(shouldShowUpdateBadge('1.25.2', '1.25.1')).toBe(true)
  })
})
