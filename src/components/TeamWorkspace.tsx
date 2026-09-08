import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, ExternalLink, LogIn, LogOut, RefreshCw, Server as ServerIcon, X } from 'lucide-react'
import { openExternalUrl } from '../services/external'
import type { Server, Snapshot } from '../types/models'
import { teamApi, TEAM_URL, type TeamData, type TeamStatus } from '../services/team'

const emptyStatus: TeamStatus = { url: TEAM_URL, authenticated: false, user: null, bindings: {} }
const emptyData: TeamData = { resources: [], reservations: [] }
const isMember = (value: TeamStatus) => value.authenticated && !!value.user && ['member', 'admin'].includes(value.user.role)
const formatTime = (value: string | number | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未同步'
export function TeamWorkspace({ servers, snapshots }: { servers: Server[]; snapshots: Record<string, Snapshot> }) {
  const [status, setStatus] = useState<TeamStatus>(emptyStatus)
  const [data, setData] = useState<TeamData>(emptyData)
  const [selected, setSelected] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [login, setLogin] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const loginButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const accountId = useRef<string | null>(null)
  const authenticated = isMember(status)
  const admin = authenticated && status.user?.role === 'admin'

  function clearPrivateData() {
    accountId.current = null
    setStatus(emptyStatus); setData(emptyData); setSelected([]); setDirty(false)
  }
  async function loadMemberData(current: TeamStatus, attempt: number, active = () => true, resetSelection = false) {
    if (attempt !== generation.current || !active()) return
    if (!isMember(current)) { clearPrivateData(); return }
    if (current.user!.id !== accountId.current) setData(emptyData)
    accountId.current = current.user!.id
    setStatus(current)
    if (resetSelection || !dirty) setSelected(Object.keys(current.bindings))
    try {
      const next = await teamApi.data()
      if (attempt === generation.current && active()) setData(next)
    } catch (e) {
      if (attempt === generation.current && active()) clearPrivateData()
      throw e
    }
  }
  async function refresh() {
    const attempt = ++generation.current
    try { await loadMemberData(await teamApi.status(), attempt) }
    catch (e) { if (attempt === generation.current) clearPrivateData(); throw e }
  }
  useEffect(() => {
    if (busy || loggingOut) return
    let active = true
    const poll = async () => {
      const attempt = ++generation.current
      try { await loadMemberData(await teamApi.status(), attempt, () => active) }
      catch (e) { if (active && attempt === generation.current) { clearPrivateData(); setError(String(e)) } }
      finally { if (active) setLoading(false) }
    }
    void poll()
    const interval = window.setInterval(() => { if (!document.hidden) void poll() }, 30_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [dirty, busy, loggingOut])
  useEffect(() => {
    if (!login) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => previous?.focus()
  }, [login])
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (e) { setError(String(e)) } finally { setBusy('') }
  }
  async function signOut() {
    if (loggingOut) return
    ++generation.current
    clearPrivateData()
    setLoggingOut(true); setError(''); setNotice('')
    try { await teamApi.logout(); setNotice('已停止本机同步，云端预约记录继续保留。') }
    catch (e) { setError(String(e)) }
    finally { setLoggingOut(false) }
  }
  async function synchronize() {
    const attempt = ++generation.current
    const current = await teamApi.select(selected)
    if (attempt !== generation.current) return
    setDirty(false)
    await loadMemberData(current, attempt, () => true, true)
    if (attempt === generation.current) setNotice(!isMember(current) ? '已停止本机资源同步。' : Object.values(current.bindings).some(b => b.error) ? '已保存选择；部分资源需要处理下方提示。' : '资源已同步，网页与桌面使用同一份资源目录。')
  }
  async function connect() {
    const attempt = ++generation.current
    const current = await teamApi.login(username.trim(), password)
    setPassword('')
    if (attempt !== generation.current) return
    if (!isMember(current)) { clearPrivateData(); throw new Error('团队登录未完成，请重新登录。') }
    setDirty(false); setLogin(false)
    await loadMemberData(current, attempt, () => true, true)
    if (attempt === generation.current) setNotice('团队账号已连接。')
  }
  async function openWeb(resourceId?: string) {
    const url = `${TEAM_URL}/${resourceId ? `?resource=${encodeURIComponent(resourceId)}` : ''}`
    try {
      await openExternalUrl(url)
    } catch { setError(`打开网页失败，请在浏览器访问 ${TEAM_URL}`) }
  }
  const bookings = data.reservations.filter(r => r.status === 'confirmed' && Date.parse(r.endAt) > Date.now()).sort((a,b) => Date.parse(a.startAt) - Date.parse(b.startAt))
  return <div className="team-workspace">
    <div className="team-toolbar">
      <p>同事可直接在浏览器预约。这里查看同一份排期，并同步你选定的服务器。</p>
      <div className="team-actions"><button className="button button--secondary" disabled={!!busy} onClick={() => void run('刷新中', refresh)}><RefreshCw size={15}/>刷新</button><button className="button button--primary" onClick={() => void openWeb()}><ExternalLink size={15}/>打开预约网页</button></div>
    </div>
    {loading && <p className="team-footnote" role="status">正在检查团队登录状态…</p>}
    {error && <div className="team-error" role="alert">{error}</div>}
    {notice && <div className="team-notice" role="status"><Check size={16}/>{notice}</div>}
    <div className="team-account"><div><strong>{authenticated ? status.user?.name : '尚未连接团队账号'}</strong><p>{authenticated ? `${status.user?.username} · ${admin ? '管理员' : '团队成员'}` : '登录团队账号后查看资源与排期；管理员可以同步本机资源。首次使用请在网页注册，注册后即成为成员。'}</p></div>
      {authenticated ? <button className="button button--secondary" disabled={loggingOut} onClick={() => void signOut()}><LogOut size={15}/>退出账号</button> : <button ref={loginButton} className="button button--secondary" onClick={() => setLogin(true)}><LogIn size={15}/>账号登录</button>}
    </div>
    {admin && <section className="team-panel"><div className="team-section-title"><div><h2>同步本机资源</h2><p>每 30 秒同步已选资源。取消勾选会停止上报，已有在线资源及预约不会被删除。</p></div><button className="button button--primary" disabled={!!busy} onClick={() => void run('同步中', synchronize)}>{busy === '同步中' ? busy : dirty ? '保存并同步' : '立即同步'}</button></div>
      <div className="team-local-list">{servers.map(server => { const binding = status.bindings[server.id]; const snapshot = snapshots[server.id]; return <label key={server.id} className="team-local-row"><input type="checkbox" checked={selected.includes(server.id)} disabled={!!busy} onChange={e => { setDirty(true); setSelected(s => e.target.checked ? [...s,server.id] : s.filter(id => id !== server.id)) }}/><ServerIcon size={17}/><div><strong>{server.name}</strong><small>{snapshot ? `${snapshot.gpus.length} 张 GPU · ${snapshot.gpus[0]?.name ?? 'CPU 服务器'}` : '尚无硬件采样'}</small>{binding?.error && <span className="team-inline-error">{binding.error}</span>}</div><span>{binding ? formatTime(binding.lastSyncedAt) : '未加入'}</span></label>})}{!servers.length && <p className="team-empty">先在 RackTop 添加并连接服务器，再加入团队预约。</p>}</div>
    </section>}
    {authenticated && <><section className="team-panel"><div className="team-section-title"><h2>团队资源 <span>{data.resources.filter(r => r.enabled).length}</span></h2></div><div className="team-resource-grid">{data.resources.filter(r => r.enabled).map(resource => <article className="team-resource" key={resource.id}><div><strong>{resource.name}</strong><span className={`team-status ${resource.status === 'online' ? 'is-online' : ''}`}>{resource.inventoryState === 'conflict' ? '硬件变化待核验' : resource.status === 'online' ? '采集在线' : '状态未知'}</span></div><p>{resource.cluster} · {resource.gpuCount} 张 GPU</p><small>{resource.gpuModel || 'CPU 服务器'}</small><small>最近上报：{formatTime(resource.lastSeenAt)}</small><button className="button button--secondary" onClick={() => void openWeb(resource.id)}><CalendarDays size={15}/>查看与预约</button></article>)}</div>{!loading && !data.resources.length && <p className="team-empty">还没有团队资源。管理员同步服务器后，大家即可在这里和网页预约。</p>}</section>
    <section className="team-panel"><div className="team-section-title"><h2>当前与即将开始的预约</h2><span>北京时间</span></div>{bookings.length ? <div className="team-booking-list">{bookings.slice(0,50).map(r => <div className="team-booking" key={r.id}><div><strong>{r.resourceName}</strong><small>{r.scope === 'machine' ? '整机' : `GPU ${r.gpuIndices.join('、')}`}</small></div><span>{r.ownerName}</span><span>{formatTime(r.startAt)} — {formatTime(r.endAt)}</span><button className="button button--secondary" onClick={() => void openWeb(r.resourceId)}>查看</button></div>)}</div> : <p className="team-empty">{loading ? '正在读取预约…' : '当前没有预约。点击“打开预约网页”选择机器和时间。'}</p>}<p className="team-footnote">预约是团队排期，不代表实时 GPU 空闲，也不会终止服务器上的任务。</p></section></>}
    {login && <div className="team-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) { setLogin(false); setPassword('') } }}><div className="team-login" role="dialog" aria-modal="true" aria-labelledby="team-login-title" ref={dialog} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) { setLogin(false); setPassword('') }
      if (e.key === 'Tab') { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') ?? []); const first=items[0],last=items[items.length-1]; if(e.shiftKey && document.activeElement===first) {e.preventDefault();last?.focus()} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus()} }
    }}><div className="team-section-title"><h2 id="team-login-title">连接团队账号</h2><button className="icon-button" aria-label="关闭登录" disabled={!!busy} onClick={() => {setLogin(false);setPassword('')}}><X size={18}/></button></div><form onSubmit={e => { e.preventDefault(); if (busy) return; if (!username.trim()) { setError('请输入用户名'); return }; if (!password) { setError('请输入密码'); return }; void run('登录中', connect) }}><label>用户名<input type="text" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required disabled={!!busy}/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required disabled={!!busy}/></label><p>使用预约网页注册的账号。登录凭据保存在本机系统钥匙串。</p>{error && <div role="alert" className="team-error">{error}</div>}<button className="button button--primary" disabled={!!busy}>{busy || '登录'}</button><button type="button" className="button button--secondary" onClick={()=>void openWeb()}>打开网页注册</button></form></div></div>}
  </div>
}
