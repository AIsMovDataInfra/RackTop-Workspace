import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Copy, FileKey2, FileUp, KeyRound, Laptop, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import { sshKeyManagerApi, type SshKeyAlgorithm, type SshKeyInfo } from '../services/sshKeyManager'

type View = 'details' | 'generate' | 'import'

const sourceNames: Record<SshKeyInfo['source'], string> = {
  discovered: '本机发现', generated: 'RackTop 生成', imported: '手动导入',
}

function availability(key: SshKeyInfo) {
  if (key.privateKeyPath && key.publicKey) return '公钥 + 私钥'
  return key.privateKeyPath ? '仅私钥' : '仅公钥'
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

export function SshKeyManager({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const dialog = useRef<HTMLElement>(null)
  const workArea = useRef<HTMLDivElement>(null)
  const loadRequest = useRef(0)
  const [keys, setKeys] = useState<SshKeyInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(sshKeyManagerApi.isDesktop)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<View>('details')
  const [name, setName] = useState('')
  const [algorithm, setAlgorithm] = useState<SshKeyAlgorithm>('ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [noPassphrase, setNoPassphrase] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)
  const selected = keys.find((key) => key.id === selectedId)
  const query = search.trim().toLocaleLowerCase()
  const visibleKeys = keys.filter((key) => [key.name, key.fingerprint, key.algorithm, key.privateKeyPath, key.publicKeyPath, ...key.usedBy].some((value) => value?.toLocaleLowerCase().includes(query)))

  function clearFeedback() { setError(''); setNotice('') }

  function resetForm() {
    setPassphrase(''); setConfirmation(''); setNoPassphrase(false)
    setName(''); setImportPath(''); setAlgorithm('ed25519')
    setRenaming(false); setConfirmForget(false)
  }

  function openView(next: View) {
    if (busy) return
    resetForm(); clearFeedback(); setView(next)
  }

  function dismiss() {
    if (busy) return
    if (confirmForget) { setConfirmForget(false); return }
    if (renaming) { setRenaming(false); return }
    if (view !== 'details') { openView('details'); return }
    onClose()
  }

  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    if (!element) return
    element.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); dismissRef.current(); return
      }
      if (event.key !== 'Tab') return
      const fields = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((field) => field.tabIndex >= 0 && !field.closest('[hidden]'))
      const first = fields[0], last = fields[fields.length - 1]
      if (!first) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      loadRequest.current += 1
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (view !== 'details' || renaming) workArea.current?.querySelector<HTMLInputElement>('input')?.focus()
    if (confirmForget) workArea.current?.querySelector<HTMLButtonElement>('[data-cancel-forget]')?.focus()
  }, [view, renaming, confirmForget])

  async function reload() {
    if (!sshKeyManagerApi.isDesktop) return
    const request = ++loadRequest.current
    setLoading(true); setError('')
    try {
      const result = await sshKeyManagerApi.list()
      if (request !== loadRequest.current) return
      setKeys(result)
      setSelectedId((current) => result.some((key) => key.id === current) ? current : result[0]?.id ?? null)
    } catch (reason) {
      if (request === loadRequest.current) setError(`读取密钥失败：${errorMessage(reason)}`)
    } finally { if (request === loadRequest.current) setLoading(false) }
  }

  useEffect(() => { void reload() }, [])

  function acceptKey(key: SshKeyInfo, message: string) {
    setKeys((current) => [...current.filter((item) => item.id !== key.id), key])
    setSelectedId(key.id); setSearch(''); resetForm(); setView('details'); setNotice(message)
    onChanged?.()
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !sshKeyManagerApi.isDesktop) return
    clearFeedback()
    if (!name.trim()) { setError('请为密钥填写一个名称。'); return }
    if (!noPassphrase && !passphrase) { setError('请设置保护口令，或明确选择不设置口令。'); return }
    if (!noPassphrase && passphrase !== confirmation) { setError('两次输入的保护口令不一致。'); return }
    setBusy(true)
    try {
      const key = await sshKeyManagerApi.generate({ name: name.trim(), algorithm, passphrase: noPassphrase ? '' : passphrase })
      acceptKey(key, `已生成「${key.name}」，可复制公钥或在服务器设置中选择此密钥。`)
    } catch (reason) { setError(`生成失败：${errorMessage(reason)}`) } finally { setBusy(false) }
  }

  async function importKey(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !sshKeyManagerApi.isDesktop) return
    clearFeedback()
    if (!importPath.trim()) { setError('请输入本机私钥或 .pub 公钥文件的路径。'); return }
    setBusy(true)
    try {
      const key = await sshKeyManagerApi.import({ path: importPath.trim(), name: name.trim() || null })
      acceptKey(key, `已将「${key.name}」加入管理列表。`)
    } catch (reason) { setError(`导入失败：${errorMessage(reason)}`) } finally { setBusy(false) }
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault()
    if (!selected || busy || !sshKeyManagerApi.isDesktop) return
    clearFeedback()
    const value = renameValue.trim()
    if (!value) { setError('密钥名称不能为空。'); return }
    setBusy(true)
    try {
      await sshKeyManagerApi.rename({ id: selected.id, name: value })
      setKeys((current) => current.map((key) => key.id === selected.id ? { ...key, name: value } : key))
      setRenaming(false); setNotice('名称已更新。'); onChanged?.()
    } catch (reason) { setError(`重命名失败：${errorMessage(reason)}`) } finally { setBusy(false) }
  }

  async function forget() {
    if (!selected || busy || !sshKeyManagerApi.isDesktop) return
    clearFeedback(); setBusy(true)
    try {
      await sshKeyManagerApi.forget({ id: selected.id })
      const remaining = keys.filter((key) => key.id !== selected.id)
      setKeys(remaining); setSelectedId(remaining[0]?.id ?? null); setConfirmForget(false)
      setNotice('已移出列表。密钥文件和服务器配置均已保留。'); onChanged?.()
    } catch (reason) { setError(`移出失败：${errorMessage(reason)}`) } finally { setBusy(false) }
  }

  async function copy(value: string, label: string) {
    clearFeedback()
    try { await navigator.clipboard.writeText(value); setNotice(`${label}已复制。`) }
    catch { setError('复制失败，请选择文本后手动复制。') }
  }

  return <div className="scrim ssh-key-manager-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss() }}>
    <section ref={dialog} className="sheet ssh-key-manager" role="dialog" aria-modal="true" aria-labelledby="ssh-key-manager-title" tabIndex={-1}>
      <header className="sheet__header ssh-key-manager__header">
        <div className="ssh-key-manager__heading"><span className="ssh-key-manager__mark"><KeyRound size={21} /></span><div><h2 id="ssh-key-manager-title">密钥管理</h2><p>在本机管理 SSH 公钥与私钥</p></div></div>
        <button className="icon-button" onClick={() => { if (!busy) onClose() }} disabled={busy} aria-label="关闭密钥管理"><X size={18} /></button>
      </header>
      {!sshKeyManagerApi.isDesktop && <div className="ssh-key-manager__preview" role="note"><Laptop size={18} /><span>浏览器预览无法读取本机密钥。请在 RackTop 桌面版中生成、导入和管理密钥。</span></div>}
      <div className="ssh-key-manager__toolbar">
        <label className="ssh-key-manager__search"><Search size={16} /><input aria-label="搜索密钥" placeholder="搜索名称、指纹或路径" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button type="button" aria-label="清除密钥搜索" onClick={() => setSearch('')}><X size={14} /></button>}</label>
        <div className="ssh-key-manager__actions"><button className="icon-button" aria-label="刷新密钥" title="重新读取本机密钥" disabled={loading || busy || view !== 'details' || !sshKeyManagerApi.isDesktop} onClick={() => void reload()}><RefreshCw size={16} /></button><button className="button button--secondary" disabled={busy || loading} onClick={() => openView('import')}><FileUp size={15} />导入已有密钥</button><button className="button button--primary" disabled={busy || loading} onClick={() => openView('generate')}><Plus size={16} />生成密钥</button></div>
      </div>
      {(error || notice) && <div className="ssh-key-manager__feedback">{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="ssh-key-manager__notice" role="status"><Check size={16} /><span>{notice}</span></p>}</div>}
      <div className="ssh-key-manager__body">
        <aside className="ssh-key-manager__list-pane" aria-label="本机密钥列表">
          <div className="ssh-key-manager__list-heading"><span>密钥</span><span>{loading ? '读取中…' : `${visibleKeys.length} 个`}</span></div>
          <div className="ssh-key-manager__list" aria-busy={loading}>
            {loading && !keys.length ? <p className="ssh-key-manager__list-empty" role="status">正在读取本机密钥…</p> : !visibleKeys.length ? <p className="ssh-key-manager__list-empty">{query ? '没有匹配的密钥' : error ? '暂时无法读取密钥，请重试' : sshKeyManagerApi.isDesktop ? '尚未发现密钥' : '本机密钥将在桌面版显示'}</p> : visibleKeys.map((key) => <button key={key.id} className={`ssh-key-manager__key${key.id === selectedId && view === 'details' ? ' is-selected' : ''}`} aria-pressed={key.id === selectedId && view === 'details'} disabled={busy} onClick={() => { openView('details'); setSelectedId(key.id) }}>
              <span className="ssh-key-manager__key-top"><KeyRound size={16} /><strong>{key.name}</strong></span><span className="ssh-key-manager__key-meta">{key.algorithm} · {sourceNames[key.source]}</span><code title={key.fingerprint}>{key.fingerprint || '指纹不可用'}</code><span className="ssh-key-manager__key-bottom"><span>{availability(key)}</span><span>{key.usedBy.length ? `${key.usedBy.length} 台服务器使用` : '未关联服务器'}</span></span>
            </button>)}
          </div>
        </aside>
        <div ref={workArea} className="ssh-key-manager__workspace">
          {view === 'generate' ? <form className="ssh-key-manager__form" onSubmit={(event) => void generate(event)}>
            <button type="button" className="ssh-key-manager__back" disabled={busy} onClick={() => openView('details')}><ArrowLeft size={15} />返回密钥</button>
            <div className="ssh-key-manager__section-heading"><h3>生成新的密钥对</h3><p>手动创建公钥和私钥，保存在本机独立文件中。</p></div>
            <label>密钥名称<input autoComplete="off" aria-label="密钥名称" maxLength={80} placeholder="例如：实验室服务器" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
            <label>密钥算法<select aria-label="密钥算法" value={algorithm} disabled={busy} onChange={(event) => setAlgorithm(event.target.value as SshKeyAlgorithm)}><option value="ed25519">Ed25519（推荐）</option><option value="rsa4096">RSA 4096（兼容旧服务器）</option></select></label>
            <div className="ssh-key-manager__form-pair"><label>保护口令<input type="password" aria-label="保护口令" autoComplete="new-password" value={passphrase} disabled={busy || noPassphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><label>确认保护口令<input type="password" aria-label="确认保护口令" autoComplete="new-password" value={confirmation} disabled={busy || noPassphrase} onChange={(event) => setConfirmation(event.target.value)} /></label></div>
            <label className="ssh-key-manager__checkbox"><input type="checkbox" checked={noPassphrase} disabled={busy} onChange={(event) => { setNoPassphrase(event.target.checked); setPassphrase(''); setConfirmation('') }} /><span>不设置口令，我了解任何能读取私钥的人都可以使用它</span></label>
            <div className="ssh-key-manager__hint"><ShieldCheck size={18} /><p>保护口令用于加密私钥。使用加密密钥连接前，请先将它解锁并加入 SSH Agent，再在服务器设置中选择 SSH Agent 认证。</p></div>
            <div className="ssh-key-manager__form-actions"><button type="button" className="button button--secondary" disabled={busy} onClick={() => openView('details')}>取消</button><button type="submit" className="button button--primary" disabled={busy || !sshKeyManagerApi.isDesktop}><Plus size={16} />{busy ? '正在生成…' : '创建密钥对'}</button></div>
          </form> : view === 'import' ? <form className="ssh-key-manager__form" onSubmit={(event) => void importKey(event)}>
            <button type="button" className="ssh-key-manager__back" disabled={busy} onClick={() => openView('details')}><ArrowLeft size={15} />返回密钥</button>
            <div className="ssh-key-manager__section-heading"><h3>导入已有密钥</h3><p>填写本机私钥或 .pub 公钥的路径，将它加入管理列表。</p></div>
            <label>密钥文件路径<input aria-label="密钥文件路径" className="mono" autoComplete="off" spellCheck={false} placeholder="~/.ssh/id_ed25519 或 ~/.ssh/id_ed25519.pub" value={importPath} disabled={busy} onChange={(event) => setImportPath(event.target.value)} /></label>
            <label>显示名称（可选）<input aria-label="导入密钥名称" autoComplete="off" maxLength={80} placeholder="留空时使用文件名" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
            <div className="ssh-key-manager__hint"><FileKey2 size={18} /><p>导入会引用原文件；请保留它的位置。仅有公钥时可以查看和复制，但连接服务器仍需要对应的私钥。</p></div>
            <div className="ssh-key-manager__form-actions"><button type="button" className="button button--secondary" disabled={busy} onClick={() => openView('details')}>取消</button><button type="submit" className="button button--primary" disabled={busy || !sshKeyManagerApi.isDesktop}><FileUp size={15} />{busy ? '正在导入…' : '加入管理列表'}</button></div>
          </form> : selected ? <div className="ssh-key-manager__details">
            <div className="ssh-key-manager__detail-heading"><div><h3>{selected.name}</h3><p>{sourceNames[selected.source]} · {availability(selected)}</p></div>{!renaming && <button className="button button--small button--secondary" disabled={busy || !sshKeyManagerApi.isDesktop} onClick={() => { clearFeedback(); setConfirmForget(false); setRenameValue(selected.name); setRenaming(true) }}>重命名</button>}</div>
            {renaming && <form className="ssh-key-manager__rename" onSubmit={(event) => void rename(event)}><label>显示名称<input aria-label="新的密钥名称" maxLength={80} value={renameValue} disabled={busy} onChange={(event) => setRenameValue(event.target.value)} /></label><div className="ssh-key-manager__actions"><button className="button button--small button--secondary" type="button" disabled={busy} onClick={() => setRenaming(false)}>取消</button><button className="button button--small button--primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存名称'}</button></div><p>修改显示名称会保留原有文件名和路径。</p></form>}
            {selected.warning && <p className="ssh-key-manager__warning" role="note">{selected.warning}</p>}
            <dl className="ssh-key-manager__metadata"><div><dt>算法</dt><dd>{selected.algorithm}</dd></div><div><dt>指纹</dt><dd className="mono">{selected.fingerprint || '暂不可用'}</dd></div><div><dt>公钥路径</dt><dd className="mono">{selected.publicKeyPath || '未找到公钥文件'}</dd></div><div><dt>私钥路径</dt><dd>{selected.privateKeyPath ? <><span className="mono">{selected.privateKeyPath}</span><button className="ssh-key-manager__copy-path" aria-label="复制私钥路径" title="复制私钥路径" onClick={() => void copy(selected.privateKeyPath!, '私钥路径')}><Copy size={14} /></button></> : '未找到对应私钥'}</dd></div></dl>
            <div className="ssh-key-manager__public-key"><div><label htmlFor="ssh-key-manager-public">公钥内容</label><button className="button button--small button--secondary" disabled={!selected.publicKey} onClick={() => void copy(selected.publicKey, '公钥')}><Copy size={14} />复制公钥</button></div><textarea id="ssh-key-manager-public" className="mono" readOnly spellCheck={false} value={selected.publicKey} placeholder="公钥内容暂不可用" rows={4} /><p>将公钥添加到服务器的授权列表后，即可使用对应私钥连接。</p></div>
            <div className="ssh-key-manager__usage"><h4>关联服务器</h4>{selected.usedBy.length ? <ul>{selected.usedBy.map((server, index) => <li key={`${server}-${index}`}>{server}</li>)}</ul> : <p>尚未被 RackTop 中的服务器配置引用。</p>}</div>
            <div className="ssh-key-manager__forget">{confirmForget ? <><p>将「{selected.name}」移出列表？</p><small>密钥文件、服务器配置及远端授权都会保留；需要时可以再次导入。</small><div className="ssh-key-manager__actions"><button type="button" data-cancel-forget className="button button--small button--secondary" disabled={busy} onClick={() => setConfirmForget(false)}>取消</button><button className="button button--small button--danger" disabled={busy} onClick={() => void forget()}>{busy ? '正在移出…' : '确认移出列表'}</button></div></> : <><p>文件保留在本机，RackTop 仅管理显示名称和引用。</p><button className="button button--small button--secondary" disabled={busy || !sshKeyManagerApi.isDesktop} onClick={() => { clearFeedback(); setRenaming(false); setConfirmForget(true) }}>移出列表</button></>}</div>
          </div> : <div className="ssh-key-manager__empty"><span><KeyRound size={30} /></span><h3>{loading ? '正在读取密钥' : '集中管理你的 SSH 密钥'}</h3><p>{sshKeyManagerApi.isDesktop ? '自动发现 ~/.ssh 下的已有密钥，也可以手动生成新密钥或导入其他位置的文件。' : '在桌面版查看已有密钥、创建密钥对，并为服务器选择对应的私钥。'}</p>{!loading && <button className="button button--primary" onClick={() => openView('generate')}><Plus size={16} />生成第一对密钥</button>}</div>}
        </div>
      </div>
      <footer className="ssh-key-manager__footer"><ShieldCheck size={14} /><span>私钥保留在本机，管理界面仅显示公钥和文件路径。</span></footer>
    </section>
  </div>
}
