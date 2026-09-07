// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerForm } from './ServerForm'
import { sshKeyManagerApi } from '../services/sshKeyManager'

vi.mock('../services/sshKeyManager', () => ({ sshKeyManagerApi: { isDesktop: true, list: vi.fn() } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement

afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.resetAllMocks() })

describe('server key selection', () => {
  it('offers private keys, preserves a custom path, and submits the selected identity', async () => {
    vi.mocked(sshKeyManagerApi.list).mockResolvedValue([
      { id: 'local-key', name: '实验室', privateKeyPath: '/tmp/lab-key', publicKeyPath: '/tmp/lab-key.pub', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture', publicKey: 'fixture-public-only', source: 'generated', warning: null, usedBy: [] },
      { id: 'public-only', name: '同事公钥', privateKeyPath: null, publicKeyPath: '/tmp/colleague.pub', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:other', publicKey: 'fixture-public-only', source: 'imported', warning: null, usedBy: [] },
    ])
    const onSave = vi.fn(async () => {})
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root?.render(<ServerForm initial={{ id: 'existing', name: 'Test', username: 'worker', host: 'example.test', authMethod: 'privateKey', identityFile: '/tmp/custom-key' }} showGuide={false} onSave={onSave} onClose={vi.fn()} />))
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="选择已管理的密钥"]')!
    const path = container.querySelector<HTMLInputElement>('input[placeholder="~/.ssh/id_ed25519"]')!
    expect(path.value).toBe('/tmp/custom-key')
    expect(select.textContent).toContain('实验室')
    expect(select.textContent).not.toContain('同事公钥')
    act(() => { select.value = '/tmp/lab-key'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(path.value).toBe('/tmp/lab-key')
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ identityFile: '/tmp/lab-key', authMethod: 'privateKey' }))
  })

  it('keeps manual entry usable if scanning fails', async () => {
    vi.mocked(sshKeyManagerApi.list).mockRejectedValue(new Error('读取失败'))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root?.render(<ServerForm initial={{ id: 'existing', authMethod: 'privateKey', identityFile: '/tmp/custom-key' }} showGuide={false} onSave={vi.fn()} onClose={vi.fn()} />))
    expect(container.querySelector('input[placeholder="~/.ssh/id_ed25519"]')?.getAttribute('value')).toBe('/tmp/custom-key')
    expect(container.textContent).toContain('也可以手动填写路径')
  })
})
