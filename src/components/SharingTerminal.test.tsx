// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharingApi } from '../services/sharingApi'
import type { SharingTerminalOutput, SharingTerminalExit } from '../types/sharing'
import { SharingTerminal } from './SharingTerminal'
const terminalState = vi.hoisted(() => ({ write: vi.fn(), data: (_data: string) => {}, cols: 100, rows: 30 }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options = { disableStdin: false }; cols = terminalState.cols; rows = terminalState.rows
  loadAddon() {} open() {} focus() {} dispose() {} write(data: Uint8Array) { terminalState.write(data) } writeln() {}
  onData(fn: (data: string) => void) { terminalState.data = fn; return { dispose() {} } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let output: (event: SharingTerminalOutput) => void
let exit: (event: SharingTerminalExit) => void
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(sharingApi, 'onTerminalOutput').mockImplementation(async fn => { output = fn; return () => {} })
  vi.spyOn(sharingApi, 'onTerminalExit').mockImplementation(async fn => { exit = fn; return () => {} })
  vi.spyOn(sharingApi, 'terminalOpen').mockResolvedValue('session-a')
  vi.spyOn(sharingApi, 'terminalInput').mockResolvedValue(undefined)
  vi.spyOn(sharingApi, 'terminalClose').mockResolvedValue(undefined)
  terminalState.write.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })
describe('shared terminal session isolation', () => {
  it('binds input/output/close to both guest resource and session IDs', async () => {
    await act(async () => root.render(<SharingTerminal id="guest-a" enabled/>))
    expect(sharingApi.terminalOpen).toHaveBeenCalledWith('guest-a', 100, 30)
    await act(async () => {
      output({ resourceId: 'guest-b', sessionId: 'session-a', data: btoa('hidden') })
      output({ resourceId: 'guest-a', sessionId: 'session-b', data: btoa('hidden') })
      output({ resourceId: 'guest-a', sessionId: 'session-a', data: btoa('visible') })
      terminalState.data('ls\r')
    })
    expect(terminalState.write).toHaveBeenCalledTimes(1)
    expect(Array.from(terminalState.write.mock.calls[0][0])).toEqual(Array.from(new TextEncoder().encode('visible')))
    expect(sharingApi.terminalInput).toHaveBeenCalledWith('guest-a', 'session-a', 'ls\r')
    await act(async () => root.render(<SharingTerminal id="guest-b" enabled/>))
    expect(sharingApi.terminalClose).toHaveBeenCalledWith('guest-a', 'session-a')
  })
  it('retains output and an exit that arrive before the open response', async () => {
    let resolveOpen: (value: string) => void = () => {}
    vi.mocked(sharingApi.terminalOpen).mockImplementation(() => new Promise(resolve => { resolveOpen = resolve }))
    await act(async () => root.render(<SharingTerminal id="guest-a" enabled/>))
    await act(async () => {
      output({ resourceId: 'guest-a', sessionId: 'early', data: btoa('last output') })
      exit({ resourceId: 'guest-a', sessionId: 'early', exitCode: 0 })
      resolveOpen('early')
    })
    expect(terminalState.write).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('会话已结束')
    expect(container.textContent).not.toContain('已连接 · 独立会话')
  })
  it('closes a late session result when the resource is disconnected during open', async () => {
    let resolveOpen: (value: string) => void = () => {}
    vi.mocked(sharingApi.terminalOpen).mockImplementation(() => new Promise(resolve => { resolveOpen = resolve }))
    await act(async () => root.render(<SharingTerminal id="guest-a" enabled/>))
    await act(async () => root.render(<SharingTerminal id="guest-a" enabled={false}/>))
    await act(async () => resolveOpen('late-session'))
    expect(sharingApi.terminalClose).toHaveBeenCalledWith('guest-a', 'late-session')
  })
})
