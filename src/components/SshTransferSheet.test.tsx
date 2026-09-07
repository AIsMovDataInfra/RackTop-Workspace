// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { SshExportSheet, SshImportSourceSheet } from './SshTransferSheet'
import type { Server } from '../types/models'

vi.mock('../services/api', () => ({ api: { isDesktop: true } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.clearAllMocks() })
const server: Server = { id: 'test', name: 'Test', host: 'test.example', username: 'tester', port: 22, tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'password', status: 'unknown' }

describe('SSH transfer dialogs', () => {
  it('reports a native save failure, permits retry, and closes with Escape', async () => {
    const onClose = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root.render(<SshExportSheet servers={[server]} onClose={onClose} />))
    vi.mocked(invoke).mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce('/downloads/RackTop_ssh_test.conf')
    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('保存配置文件'))!
    await act(async () => save.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('permission denied')
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(container.querySelector('[role="status"]')?.textContent).toContain('/downloads/RackTop_ssh_test.conf')
    expect(invoke).toHaveBeenLastCalledWith('save_ssh_export', { content: expect.stringContaining('HostName test.example') })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    act(() => container.querySelector('section')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('rejects an invalid file before preview and accepts a corrected file', async () => {
    const onParsed = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    act(() => root.render(<SshImportSourceSheet onClose={vi.fn()} onParsed={onParsed} onReadLocal={vi.fn()} />))
    const input = container.querySelector('input')!
    async function choose(content: string) {
      Object.defineProperty(input, 'files', { configurable: true, value: [{ size: content.length, text: () => Promise.resolve(content) }] })
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    }
    await choose('Host invalid\nHostName test.example\nUser tester\nPort 99999')
    expect(onParsed).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await choose('Host valid\nHostName=test.example\nUser tester\nPort 22')
    expect(onParsed).toHaveBeenCalledWith([expect.objectContaining({ host: 'test.example', username: 'tester', port: 22 })])
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
