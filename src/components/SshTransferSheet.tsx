import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, FileUp, X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { api } from '../services/api'
import type { Server, ServerDraft } from '../types/models'
import { exportSshConfig, parseSharedSshConfig } from '../utils/sshTransfer'

function useTransferDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    if (!dialog) return
    dialog.querySelector<HTMLButtonElement>('button')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab') return
      const fields = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, [tabindex="0"]'))
      const first = fields[0], last = fields[fields.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { dialog.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus() }
  }, [])
  return ref
}

export function SshExportSheet({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  const dialog = useTransferDialog(onClose)
  const exported = useMemo(() => { try { return { content: exportSshConfig(servers), error: '' } } catch (error) { return { content: '', error: String(error) } } }, [servers])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true); setError('')
    try {
      if (api.isDesktop) {
        const path = await invoke<string>('save_ssh_export', { content: exported.content })
        setNotice(`已保存到 ${path}`)
      } else {
        const url = URL.createObjectURL(new Blob([exported.content], { type: 'text/plain;charset=utf-8' }))
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'RackTop_ssh_config.conf'; anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        setNotice('已下载 SSH 配置文件')
      }
    } catch (reason) { setError(String(reason)) } finally { setSaving(false) }
  }
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialog} className="sheet ssh-transfer-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-export-title">
    <header className="sheet__header"><div><p className="eyebrow">OpenSSH Config</p><h2 id="ssh-export-title">导出全部 {servers.length} 台服务器</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
    <div className="ssh-transfer-body"><p>包含名称、主机、端口、账号和跳板地址。不包含密码、私钥及本机私钥路径；接收者导入后自行设置认证。</p><label>SSH 配置预览<textarea readOnly value={exported.content} spellCheck={false} /></label>{(exported.error || error) && <p className="form-error" role="alert">{exported.error || error}</p>}{notice && <p role="status" className="ssh-transfer-notice">{notice}</p>}</div>
    <footer className="sheet__footer"><button className="button button--secondary" disabled={!exported.content} onClick={async () => { try { await navigator.clipboard.writeText(exported.content); setNotice('SSH 配置已复制'); setError('') } catch (reason) { setError(`复制失败：${String(reason)}`) } }}><Copy size={15} />复制配置</button><button className="button button--primary" disabled={!exported.content || saving} onClick={() => void save()}><Download size={15} />{saving ? '保存中…' : '保存配置文件'}</button></footer>
  </section></div>
}

export function SshImportSourceSheet({ onClose, onParsed, onReadLocal }: { onClose: () => void; onParsed: (drafts: ServerDraft[]) => void; onReadLocal: () => Promise<void> }) {
  const dialog = useTransferDialog(onClose)
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialog} className="sheet ssh-transfer-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-import-source-title">
    <header className="sheet__header"><div><p className="eyebrow">OpenSSH Config</p><h2 id="ssh-import-source-title">导入服务器连接</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
    <div className="ssh-transfer-body"><p>选择同事分享的 SSH 配置文件。导入后先预览服务器列表，再确认添加；密码和私钥需要在本机自行配置。</p><input ref={input} type="file" accept=".conf,.config,.txt,text/plain" aria-label="选择 SSH 配置文件" disabled={reading} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setReading(true); setError(''); try { if (file.size > 2 * 1024 * 1024) throw new Error('文件大小不能超过 2 MB'); const drafts = parseSharedSshConfig(await file.text()); if (!drafts.length) throw new Error('文件中没有可导入的具体 Host'); onParsed(drafts) } catch (reason) { setError(String(reason)); if (input.current) input.current.value = '' } finally { setReading(false) } }} />{error && <p className="form-error" role="alert">{error}</p>}</div>
    <footer className="sheet__footer"><button className="button button--secondary" disabled={reading || !api.isDesktop} onClick={async () => { setReading(true); try { await onReadLocal() } finally { setReading(false) } }}>读取本机 ~/.ssh/config</button><button className="button button--primary" disabled={reading} onClick={() => input.current?.click()}><FileUp size={15} />{reading ? '读取中…' : '选择配置文件'}</button></footer>
  </section></div>
}
