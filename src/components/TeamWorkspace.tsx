import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, ExternalLink, LogIn, LogOut, RefreshCw, Server as ServerIcon, X } from 'lucide-react'
import { openExternalUrl } from '../services/external'
import type { Server, Snapshot } from '../types/models'
import { teamApi, TEAM_URL, type TeamCompany, type TeamData, type TeamStatus } from '../services/team'

const emptyStatus: TeamStatus = { url: TEAM_URL, authenticated: false, user: null, bindings: {} }
const emptyData: TeamData = { resources: [], reservations: [] }
const isMember = (value: TeamStatus) => value.authenticated && !!value.user && ['member', 'admin'].includes(value.user.role)
// A missing field is an older service; an explicit null means a company is still pending.
const needsCompany = (value: TeamStatus) => isMember(value) && !value.user?.isSuperAdmin && value.user?.company === null
const canUseTeam = (value: TeamStatus) => isMember(value) && !needsCompany(value)
const formatTime = (value: string | number | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未同步'
export function TeamWorkspace({ servers, snapshots }: { servers: Server[]; snapshots: Record<string, Snapshot> }) {
  const [status, setStatus] = useState<TeamStatus>(emptyStatus)
  const [data, setData] = useState<TeamData>(emptyData)
  const [usageNow, setUsageNow] = useState(Date.now)
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
  const waitingForCompany = needsCompany(status)
  const allowed = canUseTeam(status)
  const admin = allowed && status.user?.role === 'admin'
  const personalServers = servers.filter(server => !server.managed)
  const visibleResources = data.resources.filter(resource => resource.enabled)
  useEffect(() => {
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      const now = Date.now(); setUsageNow(now)
      const deadlines = data.resources.map(resource => Date.parse(resource.usage?.observedAt || '') + 90_000).filter(value => Number.isFinite(value) && value > now)
      if (deadlines.length) timer = window.setTimeout(refresh, Math.min(Math.min(...deadlines) - now + 1, 2_147_483_647))
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [data.resources])

  function clearPrivateData() {
    accountId.current = null
    setStatus(emptyStatus); setData(emptyData); setSelected([]); setDirty(false)
  }
  async function loadMemberData(current: TeamStatus, attempt: number, active = () => true, resetSelection = false) {
    if (attempt !== generation.current || !active()) return
    if (!isMember(current)) { clearPrivateData(); return }
    const accountScope = `${current.user!.id}:${current.user!.company ?? ''}:${Boolean(current.user!.isSuperAdmin)}`
    if (accountScope !== accountId.current) setData(emptyData)
    accountId.current = accountScope
    setStatus(current)
    if (needsCompany(current)) { setData(emptyData); setSelected([]); setDirty(false); return }
    if (resetSelection || !dirty) setSelected(Object.keys(current.bindings))
    try {
      const next = await teamApi.data()
      if (attempt === generation.current && active()) setData(next)
    } catch (e) {
      if (attempt === generation.current && active()) {
        if (String(e).includes('COMPANY_REQUIRED')) {
          setStatus({ ...current, user: { ...current.user!, company: null, isSuperAdmin: false } })
          setData(emptyData); setSelected([]); setDirty(false)
          return
        }
        clearPrivateData()
      }
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
    const current = await teamApi.select(selected.filter(id => personalServers.some(server => server.id === id)))
    if (attempt !== generation.current) return
    setDirty(false)
    await loadMemberData(current, attempt, () => true, true)
    if (attempt === generation.current && !needsCompany(current)) setNotice(!isMember(current) ? '已停止本机资源同步。' : [...Object.values(current.bindings), ...Object.values(current.usageSync ?? {})].some(b => b.error) ? '已保存选择；部分资源需要处理下方提示。' : '资源已同步，网页与桌面使用同一份资源目录。')
  }
  async function switchCompany(company: TeamCompany) {
    const attempt = ++generation.current
    setData(emptyData); setSelected([]); setDirty(false)
    const current = await teamApi.switchCompany(company)
    if (attempt !== generation.current) return
    await loadMemberData(current, attempt, () => true, true)
    if (attempt === generation.current) setNotice(`已切换至${company}，同步选择按组织分别保存。`)
  }
  async function connect() {
    const attempt = ++generation.current
    const current = await teamApi.login(username.trim(), password)
    setPassword('')
    if (attempt !== generation.current) return
    if (!isMember(current)) { clearPrivateData(); throw new Error('团队登录未完成，请重新登录。') }
    setDirty(false); setLogin(false)
    await loadMemberData(current, attempt, () => true, true)
    if (attempt === generation.current) setNotice(needsCompany(current) ? '团队账号已连接，等待超级管理员分配公司。' : '团队账号已连接。')
  }
  async function openWeb(resourceId?: string, recover = false) {
    const url = `${TEAM_URL}/${recover ? '?auth=recover' : resourceId ? `?resource=${encodeURIComponent(resourceId)}` : ''}`
    try {
      await openExternalUrl(url)
    } catch { setError(`打开网页失败，请在浏览器访问 ${TEAM_URL}`) }
  }
  const bookings = data.reservations.filter(r => r.status === 'confirmed' && Date.parse(r.endAt) > Date.now()).sort((a,b) => Date.parse(a.startAt) - Date.parse(b.startAt))
  return <div className="team-workspace">
    <div className="team-toolbar">
      <p>管理员在线维护服务器和授权，成员登录后自动接收连接配置，也可查看同一份预约排期。</p>
      <div className="team-actions"><button className="button button--secondary" disabled={!!busy} onClick={() => void run('刷新中', refresh)}><RefreshCw size={15}/>刷新</button><button className="button button--primary" onClick={() => void openWeb()}><ExternalLink size={15}/>打开预约网页</button></div>
    </div>
    {loading && <p className="team-footnote" role="status">正在检查团队登录状态…</p>}
    {error && <div className="team-error" role="alert">{error}</div>}
    {notice && <div className="team-notice" role="status"><Check size={16}/>{notice}</div>}
    <div className="team-account"><div><strong>{authenticated ? status.user?.name : '尚未连接团队账号'}</strong><p>{authenticated ? `${status.user?.username} · ${status.user?.isSuperAdmin ? '超级管理员' : status.user?.role === 'admin' ? '管理员' : '团队成员'}` : '登录团队账号后查看资源与排期；管理员可以同步本机资源。首次使用请在网页注册，注册后即成为成员，由超级管理员分配公司。'}</p>{authenticated && <dl className="team-account-company"><div><dt>所属公司</dt><dd>{status.user?.isSuperAdmin ? '跨公司管理' : status.user?.company || '等待分配'}</dd></div></dl>}</div>
      <div className="team-actions">{authenticated && !status.user?.isSuperAdmin && (status.user?.companies?.length ?? 0) > 1 && <label className="team-company-switch">当前组织<select aria-label="切换当前组织" value={status.user?.company ?? ''} disabled={!!busy || loggingOut} onChange={event => { const company = event.target.value as TeamCompany; void run('切换组织中', () => switchCompany(company)) }}>{status.user?.companies?.map(company => <option key={company} value={company}>{company}</option>)}</select></label>}
      {authenticated ? <button className="button button--secondary" disabled={loggingOut} onClick={() => void signOut()}><LogOut size={15}/>退出账号</button> : <button ref={loginButton} className="button button--secondary" onClick={() => setLogin(true)}><LogIn size={15}/>账号登录</button>}</div>
    </div>
    {waitingForCompany && <section className="team-panel" role="status"><div className="team-section-title"><h2>等待分配公司</h2></div><p className="team-footnote">请联系超级管理员为你分配 A公司、B公司、C公司或西浦。分配后点击“刷新”，即可查看团队资源和预约。你也可以打开网页或退出账号。</p></section>}
    {allowed && <section className="team-panel"><div className="team-section-title"><div><h2>团队服务器</h2><p>获授权的服务器每 30 秒自动同步到左侧列表。管理员已设置共享密码时，连接会自动使用；未设置时，请打开“编辑配置”填写本机密码或密钥。</p></div><button className="button button--secondary" onClick={() => void openExternalUrl(`${TEAM_URL}/servers`).catch(() => setError(`请在浏览器访问 ${TEAM_URL}/servers`))}><ExternalLink size={15}/>{admin ? '管理服务器与授权' : '查看服务器资源'}</button></div></section>}
    {admin && <section className="team-panel"><div className="team-section-title"><div><h2>同步本机资源</h2><p>每 30 秒同步所选个人服务器的硬件清单，并自动上报已授权团队 GPU 服务器的占用摘要。SSH 采集仍走本机网络；退出管理员客户端后，过期数据会显示状态未知。</p></div><button className="button button--primary" disabled={!!busy} onClick={() => void run('同步中', synchronize)}>{busy === '同步中' ? busy : dirty ? '保存并同步' : '立即同步'}</button></div>
      <div className="team-local-list">{servers.filter(server => server.managed?.available && server.managed.accountId === status.user?.id && (status.user?.isSuperAdmin || server.managed.company === status.user?.company)).map(server => { const usage = status.usageSync?.[server.id]; return <div key={server.id} className="team-local-row"><ServerIcon size={17}/><div><strong>{server.name}</strong><small>团队服务器 · 自动同步 GPU 占用</small>{usage?.error && <span className="team-inline-error">{usage.error}</span>}</div><span>{usage?.lastSyncedAt ? formatTime(usage.lastSyncedAt) : '等待有效采样'}</span></div> })}</div>
      <div className="team-local-list">{personalServers.map(server => { const binding = status.bindings[server.id]; const snapshot = snapshots[server.id]; return <label key={server.id} className="team-local-row"><input type="checkbox" checked={selected.includes(server.id)} disabled={!!busy} onChange={e => { setDirty(true); setSelected(s => e.target.checked ? [...s,server.id] : s.filter(id => id !== server.id)) }}/><ServerIcon size={17}/><div><strong>{server.name}</strong><small>{snapshot ? `${snapshot.gpus.length} 张 GPU · ${snapshot.gpus[0]?.name ?? 'CPU 服务器'}` : '尚无硬件采样'}</small>{binding?.error && <span className="team-inline-error">{binding.error}</span>}</div><span>{binding ? formatTime(binding.lastSyncedAt) : '未加入'}</span></label>})}{!personalServers.length && <p className="team-empty">组织服务器请在上方连接并等待采样；CPU 服务器可在网页手工登记。</p>}</div>
    </section>}
    {allowed && <><section className="team-panel"><div className="team-section-title"><h2>团队资源 <span>{visibleResources.length}</span></h2></div><div className="team-resource-grid">{visibleResources.map(resource => <article className="team-resource" key={resource.id}><div><strong>{resource.name}</strong><span className={`team-status ${resource.status === 'online' ? 'is-online' : ''}`}>{resource.inventoryState === 'conflict' ? '硬件变化待核验' : resource.status === 'online' ? '采集在线' : '状态未知'}</span></div><p>{resource.gpuCount ? 'GPU集群' : 'CPU集群'}{resource.cluster && !['GPU集群', 'CPU集群'].includes(resource.cluster) ? ` · ${resource.cluster}` : ''}{resource.gpuCount ? ` · ${resource.gpuCount} 张 GPU` : ' · 整机预约'}</p><small>{resource.gpuModel || 'CPU 服务器'}</small><small>{resource.usage?.observedAt && usageNow - Date.parse(resource.usage.observedAt) >= 0 && usageNow - Date.parse(resource.usage.observedAt) < 90_000 ? resource.usage.state === 'busy' ? '当前被占用' : resource.usage.state === 'free' ? '当前空闲' : '占用状态未知' : '占用状态未知'}</small><small>最近上报：{formatTime(resource.lastSeenAt)}</small><button className="button button--secondary" onClick={() => void openWeb(resource.id)}><CalendarDays size={15}/>查看与预约</button></article>)}</div>{!loading && !visibleResources.length && <p className="team-empty">当前组织暂无已启用的预约资源。已有 SSH 权限时，请联系管理员核对预约资源关联。</p>}</section>
    <section className="team-panel"><div className="team-section-title"><h2>当前与即将开始的预约</h2><span>北京时间 · 未来 30 天 · 最多 50 条</span></div>{bookings.length ? <div className="team-booking-list">{bookings.slice(0,50).map(r => <div className="team-booking" key={r.id}><div><strong>{r.resourceName}</strong><small>{r.scope === 'machine' ? '整机' : `GPU ${r.gpuIndices.join('、')}`}</small></div><span>{r.ownerName}</span><span>{formatTime(r.startAt)} — {formatTime(r.endAt)}</span><button className="button button--secondary" onClick={() => void openWeb(r.resourceId)}>查看</button></div>)}</div> : <p className="team-empty">{loading ? '正在读取预约…' : '当前没有预约。点击“打开预约网页”选择机器和时间。'}</p>}<p className="team-footnote">预约用于协调使用时段。当前占用请查看资源看板；已有任务不会因预约而被自动停止。</p></section></>}
    {login && <div className="team-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) { setLogin(false); setPassword('') } }}><div className="team-login" role="dialog" aria-modal="true" aria-labelledby="team-login-title" ref={dialog} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) { setLogin(false); setPassword('') }
      if (e.key === 'Tab') { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') ?? []); const first=items[0],last=items[items.length-1]; if(e.shiftKey && document.activeElement===first) {e.preventDefault();last?.focus()} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus()} }
    }}><div className="team-section-title"><h2 id="team-login-title">连接团队账号</h2><button className="icon-button" aria-label="关闭登录" disabled={!!busy} onClick={() => {setLogin(false);setPassword('')}}><X size={18}/></button></div><form onSubmit={e => { e.preventDefault(); if (busy) return; if (!username.trim()) { setError('请输入用户名'); return }; if (!password) { setError('请输入密码'); return }; void run('登录中', connect) }}><label>用户名<input type="text" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required disabled={!!busy}/></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required disabled={!!busy}/></label><p>使用预约网页注册的账号。登录凭据保存在本机系统钥匙串。</p>{error && <div role="alert" className="team-error">{error}</div>}<button className="button button--primary" disabled={!!busy}>{busy || '登录'}</button><button type="button" className="button button--secondary" onClick={()=>void openWeb(undefined, true)}>忘记密码</button><button type="button" className="button button--secondary" onClick={()=>void openWeb()}>打开网页注册</button></form></div></div>}
  </div>
}
