import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { RefreshCw, SquareTerminal, X } from 'lucide-react'
import { isSharingDesktop, sharingApi, sharingError } from '../services/sharingApi'
import type { SharingTerminalExit, SharingTerminalOutput } from '../types/sharing'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from '../utils/terminalPaste'

export function SharingTerminal({ id, enabled }: { id: string; enabled: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const [restart, setRestart] = useState(0)
  const [closed, setClosed] = useState(false)
  const [status, setStatus] = useState('尚未连接')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled || closed || !isSharingDesktop() || !container.current) return
    const element = container.current
    let disposed = false
    let sessionId: string | null = null
    let unlistenOutput: (() => void) | undefined
    let unlistenExit: (() => void) | undefined
    let pending: SharingTerminalOutput[] = []
    let pendingBytes = 0
    const earlyExits = new Map<string, SharingTerminalExit>()
    let resizeFrame = 0
    const terminal = new Terminal({ fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, scrollback: 5000, cursorBlink: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, theme: { background: '#1c1d20', foreground: '#f5f5f7', cursor: '#79aaff' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit); terminal.open(element); fit.fit()
    setStatus('正在建立独立会话'); setError('')
    const report = (reason: unknown) => { if (!disposed) setError(sharingError(reason)) }
    const write = (data: string) => {
      try { terminal.write(Uint8Array.from(atob(data), character => character.charCodeAt(0))) }
      catch { report('终端收到无效的输出数据，请重新连接。') }
    }
    const send = (data: string) => { if (sessionId) void sharingApi.terminalInput(id, sessionId, data).catch(report) }
    const dataSubscription = terminal.onData(send)
    const paste = (event: ClipboardEvent) => {
      const value = event.clipboardData?.getData('text/plain') ?? ''
      if (!isMultilineTerminalPaste(value)) return
      event.preventDefault(); event.stopImmediatePropagation()
      send(bracketTerminalPaste(normalizeTerminalPaste(value)))
    }
    element.addEventListener('paste', paste, true)
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return
        fit.fit()
        if (sessionId) void sharingApi.terminalResize(id, sessionId, terminal.cols, terminal.rows).catch(report)
      })
    })
    resize.observe(element)
    void (async () => {
      unlistenOutput = await sharingApi.onTerminalOutput(event => {
        if (disposed || event.resourceId !== id) return
        if (sessionId && event.sessionId === sessionId) write(event.data)
        else if (!sessionId && pendingBytes + event.data.length < 512 * 1024) { pending.push(event); pendingBytes += event.data.length }
      })
      if (disposed) { unlistenOutput(); return }
      unlistenExit = await sharingApi.onTerminalExit(event => {
        if (disposed || event.resourceId !== id) return
        if (!sessionId && earlyExits.size < 32) { earlyExits.set(event.sessionId, event); return }
        if (event.sessionId === sessionId) {
          sessionId = null; terminal.options.disableStdin = true; setStatus('会话已结束')
          terminal.writeln('\r\n[会话已结束]')
        }
      })
      if (disposed) { unlistenExit(); return }
      const opened = await sharingApi.terminalOpen(id, terminal.cols, terminal.rows)
      if (disposed) { await sharingApi.terminalClose(id, opened); return }
      sessionId = opened
      pending.filter(event => event.sessionId === opened).forEach(event => write(event.data)); pending = []
      if (earlyExits.has(opened)) { sessionId = null; terminal.options.disableStdin = true; setStatus('会话已结束'); terminal.writeln('\r\n[会话已结束]') }
      else { setStatus('已连接 · 独立会话'); terminal.focus() }
      earlyExits.clear()
    })().catch(reason => { if (!disposed) setStatus('连接失败'); report(reason) })
    return () => {
      disposed = true; resize.disconnect(); cancelAnimationFrame(resizeFrame)
      unlistenOutput?.(); unlistenExit?.(); dataSubscription.dispose(); element.removeEventListener('paste', paste, true)
      if (sessionId) void sharingApi.terminalClose(id, sessionId).catch(() => {})
      terminal.dispose()
    }
  }, [id, enabled, restart, closed])
  if (!enabled) return <div className="sharing-empty"><SquareTerminal size={28} /><h3>终端当前不可用</h3><p>连接资源并获得终端授权后即可使用。</p></div>
  if (!isSharingDesktop()) return <div className="sharing-empty"><SquareTerminal size={28} /><h3>在桌面 App 中打开终端</h3><p>网页预览不会建立远端会话。</p></div>
  return <section className="sharing-terminal" aria-label="共享资源终端">
    <header><SquareTerminal size={16}/><strong>{closed ? '会话已关闭' : status}</strong><button className="button button--secondary" onClick={() => { setClosed(false); setRestart(value => value + 1) }}><RefreshCw size={14}/>重新连接</button><button className="button button--secondary" disabled={closed} onClick={() => setClosed(true)}><X size={14}/>关闭会话</button></header>
    {error && <p className="sharing-error" role="alert">{error}</p>}
    <div ref={container} className="sharing-terminal-canvas" hidden={closed}/>
    <p className="sharing-terminal-note">终端使用共享的远端账号；命令可能影响同账号的文件和任务。</p>
  </section>
}
export default SharingTerminal
