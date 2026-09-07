import { describe, expect, it } from 'vitest'
import { canDisplayServerDetails, offlineFailureThreshold, serverStatusAfterFailure, serverStatusAfterSyncAwareFailure, shouldShowConnectingOnAttempt } from './connectionStatus'

describe('connection status', () => {
  it('shows a failed connection as offline during the thirty-minute wait', () => {
    expect(serverStatusAfterFailure(1)).toBe('offline')
    expect(serverStatusAfterFailure(2)).toBe('offline')
    expect(serverStatusAfterFailure(3)).toBe('offline')
  })

  it('shows manual attempts as connecting even after the offline threshold', () => {
    expect(shouldShowConnectingOnAttempt(false, true, 3)).toBe(true)
    expect(shouldShowConnectingOnAttempt(true, true, 3)).toBe(false)
  })

  it('keeps cached server details visible while reconnecting', () => {
    expect(canDisplayServerDetails('connecting', true)).toBe(true)
    expect(canDisplayServerDetails('offline', true)).toBe(true)
    expect(canDisplayServerDetails('connecting')).toBe(false)
  })

  it('keeps a healthy server green during quiet background sampling', () => {
    expect(shouldShowConnectingOnAttempt(true, true, 0)).toBe(false)
    expect(shouldShowConnectingOnAttempt(true, true, 1)).toBe(false)
    expect(shouldShowConnectingOnAttempt(true, false, 0)).toBe(true)
  })

  it('only displays cached server details while the connection is usable', () => {
    expect(canDisplayServerDetails('online')).toBe(true)
    expect(canDisplayServerDetails('warning')).toBe(true)
    expect(canDisplayServerDetails('connecting')).toBe(false)
    expect(canDisplayServerDetails('offline')).toBe(false)
    expect(canDisplayServerDetails('unknown')).toBe(false)
  })

  it('marks failed sync connections offline while cached details remain available', () => {
    expect(offlineFailureThreshold(false)).toBe(1)
    expect(offlineFailureThreshold(true)).toBe(1)
    expect(serverStatusAfterSyncAwareFailure('online', 3, true, true)).toBe('offline')
    expect(serverStatusAfterSyncAwareFailure('warning', 5, true, true)).toBe('offline')
    expect(serverStatusAfterSyncAwareFailure('online', 6, true, true)).toBe('offline')
    expect(serverStatusAfterSyncAwareFailure('online', 1, false, true)).toBe('offline')
  })
})
