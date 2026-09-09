// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(), onAction: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  vi.mocked(isPermissionGranted).mockResolvedValue(true)
})
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.clearAllMocks() })
describe('system notification mute checks', () => {
  it('does not ask for system permission when this server is muted', async () => {
    const { api } = await import('./api')
    await api.notify('GPU', 'alert', undefined, () => false)
    expect(isPermissionGranted).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })
  it.each(['permission lookup', 'permission prompt'])('drops a notification disabled during %s', async phase => {
    let resolve!: (value: never) => void
    let enabled = true
    if (phase === 'permission lookup') vi.mocked(isPermissionGranted).mockImplementationOnce(() => new Promise(r => {resolve=r}))
    else {
      vi.mocked(isPermissionGranted).mockResolvedValueOnce(false)
      vi.mocked(requestPermission).mockImplementationOnce(() => new Promise(r => {resolve=r}))
    }
    const { api } = await import('./api')
    const pending = api.notify('GPU', 'alert', undefined, () => enabled)
    await Promise.resolve(); await Promise.resolve()
    enabled = false
    resolve((phase === 'permission lookup' ? true : 'granted') as never)
    await pending
    expect(sendNotification).not.toHaveBeenCalled()
  })
  it('still delivers an enabled notification with its action data', async () => {
    const { api } = await import('./api')
    await api.notify('GPU', 'alert', {serverId:'server'}, () => true)
    expect(sendNotification).toHaveBeenCalledExactlyOnceWith({title:'GPU',body:'alert',extra:{serverId:'server'},autoCancel:true})
  })
})
