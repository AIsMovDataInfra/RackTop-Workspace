import { describe, expect, it } from 'vitest'
import { isNewerVersion, releaseUrl, shouldShowUpdateBadge } from './updateCheck'

describe('update checks', () => {
  it('opens community release notes for Linux versions and upstream notes for official versions', () => {
    expect(releaseUrl('1.26.0-linux.2')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.2')
    expect(releaseUrl('v1.26.0-linux.2')).toBe('https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.26.0-linux.2')
    expect(releaseUrl('v1.25.4')).toBe('https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4')
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
