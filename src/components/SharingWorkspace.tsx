import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowLeft, Check, Copy, Download, File, Folder, Link2, Monitor, Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, Upload, Users, X } from 'lucide-react'
import type { Server, Snapshot } from '../types/models'
import type { OwnedShare, ReceivedShare, ShareCapabilities, ShareInvite, SharedFileList, SharingStatus, ShareTransfer } from '../types/sharing'
import { DEFAULT_RELAY_URL, emptySharingStatus, isSharingDesktop, sharingApi, sharingError } from '../services/sharingApi'
import { MetricBar } from './MetricBar'
const SharingTerminal = lazy(() => import('./SharingTerminal').then(module => ({ default: module.SharingTerminal })))

const date = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚无记录'
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`
const capabilityLabels: Record<keyof ShareCapabilities, string> = { monitor: '实时监控', terminal: '终端命令', files: '文件传输' }
const connectionLabels: Record<ReceivedShare['state'], string> = { offline: '未连接', connecting: '正在连接', online: '已连接', error: '连接异常' }
function Capabilities({ value }: { value: ShareCapabilities }) { return <div className="sharing-capabilities">{Object.entries(capabilityLabels).filter(([key]) => value[key as keyof ShareCapabilities]).map(([key, label]) => <span key={key}>{label}</span>)}</div> }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="sharing-empty"><Link2 size={32}/><h3>{title}</h3><p>{children}</p></div> }

function Modal({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector<HTMLElement>('[data-sharing-autofocus]')?.focus(); return () => element?.close() }, [])
  return <dialog ref={dialog} className="sharing-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={18}/></button></header>{children}</dialog>
}

export function SharingWorkspace({ servers, currentServerId }: { servers: Server[]; currentServerId?: string | null }) {
  const [status, setStatus] = useState<SharingStatus>(emptySharingStatus)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const lock = useRef(false)
  const alive = useRef(true)
  const [page, setPage] = useState<'owner' | 'guest'>('owner')
  const [modal, setModal] = useState<'settings' | 'create' | 'accept' | null>(null)
  const [invite, setInvite] = useState<ShareInvite | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [now, setNow] = useState(Date.now())
  const refresh = useCallback(async () => {
    const next = await sharingApi.status()
    if (alive.current) setStatus(next)
  }, [])
  useEffect(() => {
    alive.current = true
    let active = false
    const load = async () => {
      if (active) return
      active = true
      try { await refresh() } catch (reason) { if (alive.current) setError(sharingError(reason)) }
      finally { active = false; if (alive.current) setLoading(false) }
    }
    void load()
    const timer = window.setInterval(() => { setNow(Date.now()); void load() }, 5000)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [refresh])
  const run = async (label: string, action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(label); setError(''); setNotice('')
    try { await action(); await refresh() }
    catch (reason) { if (alive.current) setError(sharingError(reason)) }
    finally { lock.current = false; if (alive.current) setBusy('') }
  }
  const guest = status.received.find(resource => resource.id === selected) ?? status.received[0]
  const issueInvite = async (shareId: string) => { const next = await sharingApi.invite(shareId); setCopied(false); setInvite(next) }
  const showConfirm = (title: string, body: string, action: () => Promise<void>) => setConfirm({ title, body, action })
  const desktop = isSharingDesktop()
  return <div className="sharing-workspace">
    <header className="sharing-page-header"><div><p>通过你的电脑，把已有资源分享给协作者。</p></div><div className="sharing-actions"><button className="button button--secondary" disabled={!!busy || loading} onClick={() => void run('刷新', refresh)} aria-label="刷新共享状态"><RefreshCw size={15}/></button><button className="button button--secondary" onClick={() => setModal('settings')}><Settings2 size={15}/>中继设置</button></div></header>
    {!desktop && <div className="sharing-preview" role="note"><Monitor size={16}/><span>界面预览 · 共享连接、邀请码和文件传输需要在桌面 App 中操作。</span></div>}
    <nav className="sharing-tabs" aria-label="资源共享类型"><button aria-pressed={page === 'owner'} onClick={() => setPage('owner')}>我共享的资源 <span>{status.shares.length}</span></button><button aria-pressed={page === 'guest'} onClick={() => setPage('guest')}>别人共享的资源 <span>{status.received.length}</span></button></nav>
    {error && <div className="sharing-error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><X size={15}/></button></div>}
    {notice && <div className="sharing-notice" role="status"><Check size={16}/>{notice}</div>}
    {loading ? <div className="sharing-empty" role="status">正在读取共享状态…</div> : page === 'owner' ? <>
      <div className="sharing-section-heading"><div className="sharing-status-line"><span className={`sharing-dot ${status.ownerOnline ? 'is-online' : ''}`}/>{status.ownerOnline ? '本机共享入口在线' : status.configured ? '本机共享入口未连接' : '先配置共享入口'}<small>有活跃共享时，关闭窗口会保留托盘后台；完全退出或电脑休眠后离线。</small></div><button className="button button--primary" disabled={!status.configured || !servers.length || !!busy} onClick={() => setModal('create')}><Plus size={16}/>共享资源</button></div>
      {!status.configured && <section className="sharing-setup"><ShieldCheck size={30}/><div><h2>配置一次，即可邀请协作者</h2><p>选择你已连接的资源。协作者通过邀请码加入，无需添加服务器公钥。</p></div><button className="button button--primary" onClick={() => setModal('settings')}>配置中继</button></section>}
      {status.configured && !servers.length && <Empty title="还没有可共享的资源">先在 RackTop 中添加并连接一台服务器。</Empty>}
      {status.configured && !!servers.length && !status.shares.length && <Empty title="选择一台资源，开始共享">你可以设置有效期和访问能力，并随时暂停或撤销访问。</Empty>}
      <div className="sharing-owned-list">{status.shares.map(share => {
        const expired = share.expiresAt <= now
        return <section className="sharing-owned-card" key={share.id}>
          <header><div><h2>{share.name}</h2><p>{servers.find(server => server.id === share.serverId)?.name ?? '原资源已移除'} · {expired ? '已过期' : `${date(share.expiresAt)} 到期`}</p></div><span className={`sharing-badge ${!share.paused && !expired ? 'is-online' : ''}`}>{expired ? '已过期' : share.paused ? '已暂停' : '共享中'}</span></header>
          <Capabilities value={share.capabilities}/><p className="sharing-hint">默认目录 <code>{share.defaultPath}</code>{share.capabilities.terminal ? ' · 使用共享远端账号，无多人强隔离。' : ''}</p>
          <div className="sharing-actions"><button className="button button--primary" disabled={!!busy || share.paused || expired || !status.ownerOnline} onClick={() => void run('生成邀请码', () => issueInvite(share.id))}><Link2 size={15}/>生成邀请码</button><button className="button button--secondary" disabled={!!busy || expired} onClick={() => void run('更新共享状态', () => sharingApi.pause(share.id, !share.paused))}>{share.paused ? <Play size={14}/> : <Pause size={14}/>} {share.paused ? '恢复共享' : '暂停共享'}</button><button className="button button--secondary sharing-danger" disabled={!!busy} onClick={() => showConfirm('删除这项分享？', '所有成员将失去访问权限。原服务器配置和远端文件会保留。', () => sharingApi.delete(share.id))}><Trash2 size={14}/>删除分享</button></div>
          <div className="sharing-members"><h3><Users size={15}/>已授权设备 <span>{share.members.length}</span></h3>{share.members.length ? share.members.map(member => <div className="sharing-member" key={member.id}><div><strong>{member.deviceName}</strong><small>{member.connected ? '已连接' : `最近访问 ${date(member.lastSeenAt)}`} · {date(member.pairedAt)} 加入</small></div><button className="button button--secondary" disabled={!!busy} onClick={() => showConfirm(`撤销「${member.deviceName}」？`, '该设备的会话将断开，重新加入需要新邀请码。已脱离终端的远端后台任务不会被终止。', () => sharingApi.revokeMember(share.id, member.id))}>撤销访问</button></div>) : <p className="sharing-hint">还没有成员。邀请码仅用于首次配对，每台设备独立授权。</p>}</div>
        </section>
      })}</div>
    </> : <>
      <div className="sharing-section-heading"><p className="sharing-hint">输入对方发来的邀请码，加入共享资源。</p><button className="button button--primary" disabled={!!busy} onClick={() => setModal('accept')}><Plus size={16}/>加入共享</button></div>
      {!status.received.length ? <Empty title="还没有加入共享">对方保持 RackTop 在线后，你就可以在这里使用获准的监控、终端和文件功能。</Empty> : <div className="sharing-guest-layout"><aside className="sharing-resource-list" aria-label="别人共享的资源">{status.received.map(resource => <button key={resource.id} aria-pressed={guest?.id === resource.id} onClick={() => setSelected(resource.id)}><strong>{resource.name}</strong><span>{resource.ownerLabel || '资源分享者'}</span><small><i className={`sharing-dot ${resource.state === 'online' ? 'is-online' : ''}`}/>{resource.expiresAt <= now ? '授权已过期' : connectionLabels[resource.state]}</small></button>)}</aside><div className="sharing-resource-detail">{guest && <>
        <header className="sharing-detail-header"><div><h2>{guest.name}</h2><p>{guest.ownerLabel || '资源分享者'} · {date(guest.expiresAt)} 到期</p></div><div className="sharing-actions"><button className="button button--primary" disabled={!!busy || guest.state === 'connecting' || guest.expiresAt <= now} onClick={() => void run('更新连接', () => guest.state === 'online' ? sharingApi.disconnect(guest.id) : sharingApi.connect(guest.id))}>{guest.state === 'online' ? '断开连接' : guest.state === 'connecting' ? '正在连接…' : '连接资源'}</button><button className="button button--secondary" disabled={!!busy} aria-label="从本机移除共享资源" onClick={() => showConfirm('从本机移除资源？', '当前会话将断开。再次加入需要分享者提供新的邀请码。', () => sharingApi.forget(guest.id))}><Trash2 size={15}/></button></div></header>
        {guest.lastError && <p className="sharing-error" role="alert">{sharingError(guest.lastError)}</p>}<Capabilities value={guest.capabilities}/><GuestTools key={guest.id} resource={guest}/>
      </>}</div></div>}
    </>}
    {busy && <span className="sharing-working" role="status">{busy}…</span>}
    {modal === 'settings' && <SettingsForm status={status} busy={!!busy} error={error} onClose={() => setModal(null)} onSubmit={(url, token) => void run('保存设置', async () => { await sharingApi.configure(url, token); setModal(null); setNotice('共享入口设置已保存。') })}/>}
    {modal === 'create' && <CreateForm servers={servers} initialServer={currentServerId} busy={!!busy} error={error} onClose={() => setModal(null)} onSubmit={draft => void run('创建分享', async () => { const share = await sharingApi.create(draft); setModal(null); await issueInvite(share.id) })}/>}
    {modal === 'accept' && <AcceptForm busy={!!busy} error={error} onClose={() => setModal(null)} onSubmit={(code, device) => void run('加入共享', async () => { const resource = await sharingApi.accept(code, device); setSelected(resource.id); setModal(null); setNotice('设备已授权，选择连接资源即可使用。') })}/>}
    {invite && <Modal title="邀请协作者" onClose={() => setInvite(null)}><div className="sharing-form"><p>把邀请码发给你信任的协作者。成功配对后，该邀请码不能再次使用。</p><textarea aria-label="一次性邀请码" readOnly value={invite.code} rows={4} data-sharing-autofocus/><p className="sharing-hint">{invite.expiresAt <= now ? '邀请码已过期，请重新生成。' : `${date(invite.expiresAt)} 过期`}</p><div className="sharing-form-actions"><button className="button button--secondary" onClick={() => setInvite(null)}>完成</button><button className="button button--primary" disabled={invite.expiresAt <= now} onClick={() => { void navigator.clipboard.writeText(invite.code).then(() => setCopied(true)).catch(() => setError('复制失败，请选中邀请码并手动复制。')) }}>{copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? '已复制' : '复制邀请码'}</button></div></div></Modal>}
    {confirm && <Modal title={confirm.title} busy={!!busy} onClose={() => setConfirm(null)}><div className="sharing-form"><p>{confirm.body}</p>{error && <p className="sharing-error" role="alert">{error}</p>}<div className="sharing-form-actions"><button className="button button--secondary" disabled={!!busy} onClick={() => setConfirm(null)}>取消</button><button className="button button--primary" disabled={!!busy} onClick={() => void run('正在处理', async () => { await confirm.action(); setConfirm(null) })}>确认</button></div></div></Modal>}
  </div>
}

function SettingsForm({ status, busy, error, onClose, onSubmit }: { status: SharingStatus; busy: boolean; error: string; onClose: () => void; onSubmit: (url: string, token: string) => void }) {
  const [url] = useState(status.relayUrl || DEFAULT_RELAY_URL)
  const [token, setToken] = useState('')
  const validUrl = (() => { try { const value = new URL(url); return value.protocol === 'https:' && !value.username && !value.password && !value.search && !value.hash && value.pathname === '/' } catch { return false } })()
  return <Modal title="中继设置" busy={busy} onClose={onClose}><form className="sharing-form" onSubmit={event => { event.preventDefault(); if (validUrl && token.trim()) onSubmit(url.trim(), token.trim()) }}><p>当前使用已部署的中继地址。访问令牌用于管理你的共享入口。</p><label>中继地址<input type="url" value={url} readOnly aria-describedby="sharing-relay-explanation"/></label><label>{status.configured ? '替换访问令牌' : '访问令牌'}<input type="password" data-sharing-autofocus autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder={status.configured ? '已安全保存；输入新的令牌以替换' : '输入分享者访问令牌'} required/></label><p className="sharing-hint" id="sharing-relay-explanation">此版本使用固定中继地址。已保存的令牌不会显示；接收他人资源无需配置此项。</p>{error && <p className="sharing-error" role="alert">{error}</p>}<div className="sharing-form-actions"><button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>取消</button><button className="button button--primary" disabled={busy || !validUrl || !token.trim()}>保存设置</button></div></form></Modal>
}
function CreateForm({ servers, initialServer, busy, error, onClose, onSubmit }: { servers: Server[]; initialServer?: string | null; busy: boolean; error: string; onClose: () => void; onSubmit: (draft: Parameters<typeof sharingApi.create>[0]) => void }) {
  const [serverId, setServerId] = useState(servers.find(server => server.id === initialServer)?.id ?? servers[0]?.id ?? '')
  const [name, setName] = useState(servers.find(server => server.id === serverId)?.name ?? '')
  const [hours, setHours] = useState(24)
  const [path, setPath] = useState('~')
  const [capabilities, setCapabilities] = useState<ShareCapabilities>({ monitor: true, terminal: true, files: true })
  return <Modal title="共享现有资源" busy={busy} onClose={onClose}><form className="sharing-form" onSubmit={event => { event.preventDefault(); if (name.trim() && path.trim() && Object.values(capabilities).some(Boolean)) onSubmit({ serverId, name: name.trim(), expiresInHours: hours, defaultPath: path.trim(), capabilities }) }}><label>选择资源<select value={serverId} onChange={event => { setServerId(event.target.value); setName(servers.find(server => server.id === event.target.value)?.name ?? '') }} data-sharing-autofocus>{servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label><label>共享名称<input maxLength={80} value={name} onChange={event => setName(event.target.value)} required/></label><div className="sharing-form-grid"><label>访问有效期<select value={hours} onChange={event => setHours(Number(event.target.value))}><option value={1}>1 小时</option><option value={24}>24 小时</option><option value={168}>7 天</option></select></label><label>默认目录<input value={path} onChange={event => setPath(event.target.value)} required spellCheck={false}/></label></div><fieldset><legend>允许的能力</legend>{Object.entries(capabilityLabels).map(([key, label]) => <label className="sharing-checkbox" key={key}><input type="checkbox" checked={capabilities[key as keyof ShareCapabilities]} onChange={event => setCapabilities(value => ({ ...value, [key]: event.target.checked }))}/>{label}</label>)}</fieldset>{capabilities.terminal && <p className="sharing-warning">终端允许任意命令，使用同一个远端账号。默认目录是起始位置，不能隔离文件和任务。撤销访问不会终止已脱离终端的远端后台任务。</p>}{error && <p className="sharing-error" role="alert">{error}</p>}<div className="sharing-form-actions"><button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>取消</button><button className="button button--primary" disabled={busy || !name.trim() || !path.trim() || !serverId || !Object.values(capabilities).some(Boolean)}>创建并生成邀请码</button></div></form></Modal>
}
function AcceptForm({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (code: string, name: string) => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('我的电脑')
  return <Modal title="加入共享资源" busy={busy} onClose={onClose}><form className="sharing-form" onSubmit={event => { event.preventDefault(); if (code.trim() && name.trim()) onSubmit(code.trim(), name.trim()) }}><label>邀请码<textarea value={code} onChange={event => setCode(event.target.value)} placeholder="粘贴分享者提供的完整邀请码" required data-sharing-autofocus spellCheck={false} rows={4}/></label><label>设备显示名称<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required/></label><p className="sharing-hint">分享者会看到这个名称，可单独撤销这台设备的权限。</p>{error && <p className="sharing-error" role="alert">{error}</p>}<div className="sharing-form-actions"><button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>取消</button><button className="button button--primary" disabled={busy || !code.trim() || !name.trim()}>加入共享</button></div></form></Modal>
}

function GuestTools({ resource }: { resource: ReceivedShare }) {
  const available = (Object.keys(capabilityLabels) as (keyof ShareCapabilities)[]).filter(key => resource.capabilities[key])
  const [selected, setSelected] = useState<keyof ShareCapabilities>(available[0] ?? 'monitor')
  const tool = available.includes(selected) ? selected : available[0]
  const online = resource.state === 'online' && resource.expiresAt > Date.now()
  return <><nav className="sharing-tool-tabs" aria-label="共享资源工具">{available.map(key => <button key={key} aria-pressed={tool === key} onClick={() => setSelected(key)}>{capabilityLabels[key]}</button>)}</nav>{!online ? <Empty title={resource.state === 'connecting' ? '正在连接共享资源' : '连接后开始使用'}>分享者的电脑和 RackTop 需要保持在线。</Empty> : tool === 'monitor' ? <SharedMonitor id={resource.id}/> : tool === 'terminal' ? <Suspense fallback={<p className="sharing-hint" role="status">正在加载终端…</p>}><SharingTerminal id={resource.id} enabled={online && resource.capabilities.terminal}/></Suspense> : tool === 'files' ? <SharedFiles id={resource.id} initialPath={resource.defaultPath}/> : <Empty title="当前没有已授权的能力">请联系分享者调整授权。</Empty>}</>
}
function SharedMonitor({ id }: { id: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true; let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try { const next = await sharingApi.snapshot(id); if (active) { setSnapshot(next); setError('') } }
      catch (reason) { if (active) setError(sharingError(reason)) }
      finally { pending = false }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [id])
  return <section className="sharing-monitor" aria-label="共享资源实时监控">{error && <p role="alert" className="sharing-error">{error}{snapshot ? ' · 以下为最近一次成功读取的数据。' : ''}</p>}{!snapshot ? <p className="sharing-hint" role="status">{error ? '暂时无法读取监控。' : '正在读取监控…'}</p> : <><div className="sharing-section-heading"><h3>资源概况</h3><small>采样于 {date(snapshot.timestamp * 1000)}</small></div><div className="sharing-metric-grid"><MetricBar label="CPU" value={snapshot.system.cpuUtilization}/><MetricBar label="内存" value={snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0} detail={`${bytes(snapshot.system.memoryUsedBytes)} / ${bytes(snapshot.system.memoryTotalBytes)}`}/></div><h3>加速卡 <span className="sharing-hint">{snapshot.gpus.length} 张</span></h3>{snapshot.gpus.length ? <div className="sharing-gpu-grid">{snapshot.gpus.map(gpu => <section className="sharing-gpu" key={gpu.uuid}><h4>GPU {gpu.index} · {gpu.name}</h4><MetricBar label="利用率" value={gpu.utilization}/><MetricBar label="显存" value={gpu.memoryTotalMb ? gpu.memoryUsedMb / gpu.memoryTotalMb * 100 : 0} detail={`${Math.round(gpu.memoryUsedMb)} / ${Math.round(gpu.memoryTotalMb)} MB`} accent="purple"/><p>{gpu.temperatureCelsius} °C · {Math.round(gpu.powerWatts)} W</p></section>)}</div> : <p className="sharing-hint">暂无加速卡数据。</p>}</>}</section>
}
function SharedFiles({ id, initialPath }: { id: string; initialPath: string }) {
  const [files, setFiles] = useState<SharedFileList | null>(null)
  const [path, setPath] = useState(initialPath || '.')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [transfers, setTransfers] = useState<ShareTransfer[]>([])
  const requestId = useRef(0)
  const currentPath = useRef(initialPath || '.')
  const alive = useRef(true)
  const load = useCallback(async (requested: string) => {
    if (requested.startsWith('/') || requested.split('/').includes('..') || requested.includes('\\')) { setError('请输入共享目录内的相对路径，不能使用绝对路径或 ..。'); return }
    const sequence = ++requestId.current; setLoading(true); setError('')
    try { const result = await sharingApi.listFiles(id, requested); if (alive.current && sequence === requestId.current) { setFiles(result); setPath(result.path); currentPath.current = result.path } }
    catch (reason) { if (alive.current && sequence === requestId.current) setError(sharingError(reason)) }
    finally { if (alive.current && sequence === requestId.current) setLoading(false) }
  }, [id])
  useEffect(() => {
    alive.current = true; void load(initialPath || '.')
    let unsubscribe: (() => void) | undefined
    void sharingApi.onTransfer(event => {
      if (!alive.current || event.resourceId !== id) return
      setTransfers(previous => [event, ...previous.filter(item => item.transferId !== event.transferId)].slice(0, 20))
      if (event.status === 'completed' && event.direction === 'upload') void load(currentPath.current)
    }).then(stop => { if (!alive.current) stop(); else unsubscribe = stop }).catch(reason => setError(sharingError(reason)))
    return () => { alive.current = false; requestId.current++; unsubscribe?.() }
  }, [id, initialPath, load])
  const transfer = async (action: () => Promise<{ transferId: string } | null>) => {
    if (busy) return
    setBusy(true); setError('')
    try { const result = await action(); if (result && alive.current) await load(files?.path ?? path) }
    catch (reason) { if (alive.current) setError(sharingError(reason)) }
    finally { if (alive.current) setBusy(false) }
  }
  const navigate = (event: FormEvent) => { event.preventDefault(); if (path.trim()) void load(path.trim()) }
  return <section className="sharing-files" aria-label="共享资源文件"><form className="sharing-file-toolbar" onSubmit={navigate}><button type="button" className="button button--secondary" aria-label="上级目录" disabled={loading || !files?.parent} onClick={() => files?.parent && void load(files.parent)}><ArrowLeft size={15}/></button><input aria-label="共享目录" value={path} onChange={event => setPath(event.target.value)} spellCheck={false}/><button className="button button--secondary" disabled={loading || !path.trim()}>前往</button><button type="button" className="button button--secondary" aria-label="刷新文件" disabled={loading} onClick={() => void load(files?.path ?? path)}><RefreshCw size={15}/></button><button type="button" className="button button--primary" disabled={busy || loading || !files} onClick={() => void transfer(() => sharingApi.upload(id, files!.path))}><Upload size={15}/>上传</button></form>{error && <p className="sharing-error" role="alert">{error}</p>}{busy && <p className="sharing-hint" role="status">正在选择文件或传输，请在系统对话框中操作…</p>}{loading ? <p className="sharing-hint" role="status">正在读取目录…</p> : files && <div className="sharing-file-table"><table><thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th><span className="sharing-sr-only">操作</span></th></tr></thead><tbody>{files.entries.map(entry => <tr key={entry.path}><td>{entry.isDir ? <button className="sharing-file-name" onClick={() => void load(entry.path)}><Folder size={16}/><span>{entry.name}</span>{entry.isSymlink && <small>链接</small>}</button> : <span className="sharing-file-name"><File size={16}/><span>{entry.name}</span>{entry.isSymlink && <small>链接</small>}</span>}</td><td>{entry.isDir ? '—' : bytes(entry.size)}</td><td>{date(entry.modified)}</td><td>{!entry.isDir && <button className="icon-button" aria-label={`下载 ${entry.name}`} disabled={busy} onClick={() => void transfer(() => sharingApi.download(id, entry.path))}><Download size={15}/></button>}</td></tr>)}</tbody></table>{files.truncated && <p className="sharing-warning" role="status">目录内容已达到显示上限，部分条目未列出。可在上方输入已知的子目录路径继续浏览。</p>}{!files.entries.length && !files.truncated && <p className="sharing-empty">此目录为空。</p>}</div>}{!!transfers.length && <div className="sharing-transfers"><h3>文件传输</h3>{transfers.map(item => <div className="sharing-transfer" key={item.transferId}><div><strong>{item.direction === 'upload' ? '上传' : '下载'} · {item.name}</strong><small>{item.status === 'completed' ? '已完成' : item.status === 'cancelled' ? '已取消' : item.status === 'error' ? sharingError(item.error ?? '传输失败') : `${bytes(item.transferred)}${item.total !== null ? ` / ${bytes(item.total)}` : ''}`}</small>{item.status === 'running' && <progress aria-label={`${item.name} 传输进度`} max={item.total || 1} value={item.total ? item.transferred : undefined}/>}</div>{item.status === 'running' && <button className="button button--secondary" onClick={() => void sharingApi.cancelTransfer(item.transferId).catch(reason => setError(sharingError(reason)))}>取消</button>}</div>)}</div>}</section>
}
export default SharingWorkspace
