import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

describe('SSH key service boundary', () => {
  it('does not attempt a native invocation in the browser', async () => {
    vi.stubGlobal('window', {})
    const { sshKeyManagerApi } = await import('./sshKeyManager')
    expect(sshKeyManagerApi.isDesktop).toBe(false)
    await expect(sshKeyManagerApi.list()).rejects.toThrow('桌面版')
    await expect(sshKeyManagerApi.generate({ name: 'preview', algorithm: 'ed25519', passphrase: '' })).rejects.toThrow('桌面版')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes explicit typed arguments to the desktop commands', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const { sshKeyManagerApi } = await import('./sshKeyManager')
    await sshKeyManagerApi.list()
    await sshKeyManagerApi.generate({ name: 'work', algorithm: 'rsa4096', passphrase: 'test-only' })
    await sshKeyManagerApi.import({ path: '~/.ssh/id_ed25519.pub', name: null })
    await sshKeyManagerApi.rename({ id: 'key-1', name: 'new label' })
    await sshKeyManagerApi.forget({ id: 'key-1' })
    expect(invoke.mock.calls).toEqual([
      ['list_ssh_keys', undefined],
      ['generate_ssh_key', { name: 'work', algorithm: 'rsa4096', passphrase: 'test-only' }],
      ['import_ssh_key', { path: '~/.ssh/id_ed25519.pub', name: null }],
      ['rename_ssh_key', { id: 'key-1', name: 'new label' }],
      ['forget_ssh_key', { id: 'key-1' }],
    ])
  })
})
