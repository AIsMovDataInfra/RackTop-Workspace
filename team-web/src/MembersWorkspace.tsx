import { Brand } from './Brand'
import { useEffect, useRef, useState } from 'react'
import { Building2, KeyRound, FileText, HandHelping, LayoutGrid, LogOut, Package, Plus, RefreshCw, Settings, ShieldCheck, Trash2, Users } from 'lucide-react'
import { MemberAvatar } from './MemberAvatar'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { SettingsDialog } from './SettingsDialog'
import { formatTime } from './time'
import { COMPANY_OPTIONS, type Company, type Member, type Session } from './types'
import type { PreferencesState } from './preferences'
import './members.css'

type Editor = { kind: 'create' | 'company' | 'reset' | 'delete'; member?: Member }
type Props = { session: Session; state: PreferencesState; navigate: (path: string) => void; onLogout: () => Promise<void>; onSessionChanged: (session: Session) => void; onSessionExpired: () => void }

export function MembersWorkspace({ session, state, navigate, onLogout, onSessionChanged, onSessionExpired }: Props) {
  const { t, preferences } = state
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [recoveryOnly, setRecoveryOnly] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<unknown>(null)
  const [conflict, setConflict] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [company, setCompany] = useState<Company | ''>('')
  const generation = useRef(0)
  const allowed = session.user?.isSuperAdmin === true

  function deny(reason: unknown) {
    if (!(reason instanceof ApiError) || ![401, 403].includes(reason.status)) return false
    generation.current++; setMembers([]); setEditor(null); setPassword(''); setLoading(false); setError(reason)
    if (reason.status === 401) onSessionExpired()
    return true
  }
  async function load() {
    if (!allowed) return
    const request = ++generation.current
    setLoading(true); setError(null)
    try { const value = await api.members(); if (generation.current === request) setMembers(value.members) }
    catch (reason) { if (generation.current === request && !deny(reason)) { setMembers([]); setError(reason) } }
    finally { if (generation.current === request) setLoading(false) }
  }
  useEffect(() => {
    if (allowed) void load()
    else { setMembers([]); setEditor(null); setPassword(''); setLoading(false) }
    return () => { generation.current++ }
  }, [session.user?.id, allowed])

  function open(value: Editor) {
    setEditor(value); setFormError(null); setConflict(false); setNotice('')
    setName(''); setPassword(''); setCompany(value.member?.company || '')
  }
  function close() { setEditor(null); setPassword(''); setFormError(null); setConflict(false) }
  async function save() {
    if (!editor || busy || !allowed) return
    if (editor.kind === 'create' && (!name.trim() || !password.trim() || !company) || editor.kind === 'company' && !company || editor.kind === 'reset' && !password.trim()) {
      setFormError(new Error(t('请填写所有必填项。', 'Complete all required fields.'))); return
    }
    const request = generation.current
    setBusy(true); setFormError(null); setConflict(false)
    try {
      if (editor.kind === 'create') {
        const value = await api.createMember({ name, password, company: company as Company })
        if (request !== generation.current) return
        setMembers((old) => [...old, value.member]); setNotice(t('员工账号已创建，请私下告知本人登录信息。', 'Account created. Share the sign-in details with the employee privately.'))
      } else if (editor.kind === 'company') {
        const value = await api.setMemberCompany(editor.member!, company as Company)
        if (request !== generation.current) return
        setMembers((old) => old.map((entry) => entry.id === value.member.id ? value.member : entry))
        if (value.member.id === session.user?.id) onSessionChanged({ ...session, user: value.member })
        setNotice(t('公司已更新，成员刷新页面后即可使用。', 'Company updated. The member can refresh their page to continue.'))
      } else if (editor.kind === 'reset') {
        const value = await api.resetMemberPassword(editor.member!, password)
        if (request !== generation.current) return
        setMembers((old) => old.map((entry) => entry.id === value.member.id ? value.member : entry))
        setNotice(t('密码已重置，旧会话已退出。请私下告知本人新密码。', 'Password reset and previous sessions revoked. Share the new password privately.'))
      } else {
        await api.deleteMember(editor.member!)
        if (request !== generation.current) return
        setMembers((old) => old.filter((entry) => entry.id !== editor.member!.id))
        setNotice(t('员工账号已删除，预约与设备记录已保留。', 'Account deleted. Booking and equipment records are retained.'))
      }
      close()
    } catch (reason) {
      if (request !== generation.current || deny(reason)) return
      if (reason instanceof ApiError && reason.status === 409 && reason.code === 'VERSION_CONFLICT' && editor.member) {
        try {
          const latest = await api.members()
          if (request !== generation.current) return
          setMembers(latest.members)
          const member = latest.members.find((entry) => entry.id === editor.member!.id)
          if (!member) { close(); setError(new Error(t('该员工账号已被删除。', 'This account has been deleted.'))); return }
          setEditor({ ...editor, member }); setConflict(true)
        } catch (reloadError) { if (request === generation.current && !deny(reloadError)) setFormError(reloadError) }
      } else if (reason instanceof ApiError && reason.status === 404) {
        setMembers((old) => old.filter((entry) => entry.id !== editor.member?.id)); close(); setError(reason)
      } else setFormError(reason)
    } finally { setBusy(false) }
  }
  if (!allowed) return null
  const filtered = members.filter((member) => {
    const memberCompany = member.isSuperAdmin ? '' : member.company || ''
    return (!companyFilter || (!member.isSuperAdmin && (companyFilter === 'pending' ? !memberCompany : memberCompany === companyFilter)))
      && (!recoveryOnly || Boolean(member.recoveryRequestedAt))
      && [member.name, member.username, memberCompany].some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  })
  const title = editor?.kind === 'create' ? t('增加员工账号', 'Add employee') : editor?.kind === 'company' ? t('分配公司', 'Assign company') : editor?.kind === 'reset' ? t('重置员工密码', 'Reset employee password') : t('删除员工账号', 'Delete employee account')
  return <>
    <div className="workspace-shell members-workspace" inert={Boolean(editor) || settings}>
      <aside className="sidebar">
        <Brand t={t} />
        <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}><button onClick={() => navigate('/')}><LayoutGrid size={18} />{t('算力预约', 'Compute bookings')}</button><button onClick={() => navigate('/equipment')}><Package size={18} />{t('设备管理', 'Equipment')}</button><button onClick={() => navigate('/reports')}><FileText size={18}/>{t('周报与绩效', 'Weekly reports')}</button><button onClick={() => navigate('/requests')}><HandHelping size={18}/>{t('设备申请与领取', 'Device requests')}</button><button className="is-active" aria-current="page"><Users size={18} />{t('成员管理', 'Members')}</button></nav>
        <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={18} /><p>{t('成员名册与账号管理仅超级管理员可访问。', 'Only the super administrator can access the member directory and account management.')}</p></div><button className="sidebar-settings" onClick={() => setSettings(true)}><Settings size={17} />{t('设置', 'Settings')}</button><div className="profile"><span className="profile-avatar"><MemberAvatar avatar={session.user?.avatar} size={19} /></span><div><strong>{session.user!.name}</strong><small>{t('超级管理员', 'Super administrator')}</small></div><button className="icon-button" aria-label={t('退出登录', 'Sign out')} disabled={busy} onClick={async () => { generation.current++; setMembers([]); setBusy(true); try { await onLogout() } catch (reason) { setError(reason) } finally { setBusy(false) } }}><LogOut size={16} /></button></div></div>
      </aside>
      <main className="main-workspace"><header className="page-header"><div><p>{t('团队账号', 'Team accounts')}</p><h1>{t('成员管理', 'Members')}</h1><span>{t('分配公司、处理找回申请和管理员工账号。', 'Assign companies, handle recovery requests and manage employee accounts.')}</span></div><div className="header-actions"><button disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16} />{t('刷新', 'Refresh')}</button><button className="primary" onClick={() => open({ kind: 'create' })}><Plus size={17} />{t('增加员工', 'Add employee')}</button></div></header>
        <div className="page-content">
          {Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}
          {notice && <div className="notice" role="status">{notice}</div>}
          <div className="member-filters"><label>{t('搜索成员', 'Search members')}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('姓名、用户名或公司', 'Name, username or company')} /></label><label>{t('公司', 'Company')}<select value={companyFilter} onChange={(event) => setCompanyFilter(event.target.value)}><option value="">{t('全部公司', 'All companies')}</option><option value="pending">{t('待分配公司', 'Company pending')}</option>{COMPANY_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={recoveryOnly} onChange={(event) => setRecoveryOnly(event.target.checked)} />{t('仅看找回申请', 'Recovery requests only')}</label></div>
          {loading ? <p className="loading-inline" role="status"><RefreshCw size={17} />{t('正在读取成员…', 'Loading members…')}</p> : !error && <section className="member-directory" aria-label={t('团队成员名册', 'Team member directory')}><div className="member-directory-heading"><strong>{t('成员', 'Members')} <span className="muted">{filtered.length}</span></strong><span>{t('员工公司由超级管理员分配', 'Employee companies are assigned by the super administrator')}</span></div>{filtered.length ? <div className="member-table-scroll" tabIndex={0} role="region" aria-label={t('成员表，可横向滚动', 'Members table, horizontally scrollable')}><table className="member-table"><thead><tr>{[t('成员名称', 'Member name'), t('公司', 'Company'), t('身份', 'Role'), t('注册时间', 'Registered'), t('找回申请', 'Recovery request'), t('操作', 'Actions')].map((value) => <th scope="col" key={value}>{value}</th>)}</tr></thead><tbody>{filtered.map((member) => <tr key={member.id}><td><strong><MemberAvatar avatar={member.avatar} size={17}/>{member.name}</strong>{member.username !== member.name && <span className="member-username">{t('原用户名：', 'Original username: ')}{member.username}</span>}</td><td>{member.isSuperAdmin ? t('跨公司管理，无需分配公司', 'Cross-company management; no company assignment needed') : member.company || <span className="member-pending">{t('待分配公司', 'Company pending')}</span>}</td><td>{member.isSuperAdmin ? t('超级管理员', 'Super administrator') : member.role === 'admin' ? t('资源管理员', 'Resource administrator') : t('团队成员', 'Team member')}</td><td><time dateTime={member.createdAt}>{formatTime(member.createdAt, preferences.locale)}</time></td><td>{member.recoveryRequestedAt ? <span className="member-pending">{t('待处理', 'Pending')}<time dateTime={member.recoveryRequestedAt}>{formatTime(member.recoveryRequestedAt, preferences.locale)}</time></span> : <span className="muted">—</span>}</td><td><div className="member-actions">{!member.isSuperAdmin && <><button aria-label={`${t('分配公司', 'Assign company')} · ${member.name}`} onClick={() => open({ kind: 'company', member })}><Building2 size={15} />{t('公司', 'Company')}</button><button aria-label={`${t('重置密码', 'Reset password')} · ${member.name}`} onClick={() => open({ kind: 'reset', member })}><KeyRound size={15} />{t('重置密码', 'Reset password')}</button><button className="danger" aria-label={`${t('删除账号', 'Delete account')} · ${member.name}`} onClick={() => open({ kind: 'delete', member })}><Trash2 size={15} />{t('删除', 'Delete')}</button></>}</div></td></tr>)}</tbody></table></div> : <p className="member-empty">{t('没有符合条件的成员。', 'No members match these filters.')}</p>}</section>}
        </div>
      </main>
    </div>
    {settings && <SettingsDialog state={state} session={session} onClose={() => setSettings(false)} onSessionChanged={onSessionChanged} />}
    {editor && <Dialog compact title={title} subtitle={editor.member ? editor.member.username === editor.member.name ? editor.member.name : `${editor.member.name} · ${editor.member.username}` : undefined} onClose={close} busy={busy} t={t}><form onSubmit={(event) => { event.preventDefault(); void save() }}><div className="dialog-body member-form">
      {editor.kind === 'create' && <label>{t('成员名称', 'Member name')}<input name="name" value={name} required autoComplete="off" disabled={busy} onChange={(event) => setName(event.target.value)} /></label>}
      {['create', 'reset'].includes(editor.kind) && <label>{editor.kind === 'create' ? t('初始密码', 'Initial password') : t('新密码', 'New password')}<input name="password" type="password" value={password} required autoComplete="new-password" disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>}
      {['create', 'company'].includes(editor.kind) && <label>{t('公司', 'Company')}<select name="company" required value={company} disabled={busy} onChange={(event) => setCompany(event.target.value as Company)}><option value="" disabled>{t('请选择公司', 'Choose a company')}</option>{COMPANY_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label>}
      {editor.kind === 'create' && <p className="field-help">{t('成员名称同时用于登录和团队显示，支持中英文，注册后固定使用且不可重名。密码填写非空内容即可。', 'One fixed member name is used for sign-in and team display. Chinese and English are supported and the name must be unique. Passwords only need to be non-empty.')}</p>}
      {editor.kind === 'reset' && <div className="callout"><KeyRound size={18} /><span>{t('请先与本人核实身份。重置后，该成员的网页和桌面登录会话将全部退出；请私下告知新密码。', 'Verify the employee’s identity first. Resetting revokes their web and desktop sessions. Share the new password privately.')}</span></div>}
      {editor.kind === 'delete' && <div className="callout"><Trash2 size={18} /><span>{t('删除后，该员工无法再登录，所有登录会话会失效。历史预约、设备与登记记录保留；重新创建同名账号也不会继承旧账号身份。', 'Deleting this account revokes all sessions. Booking, equipment and registration history are retained. Recreating the same username does not restore the old identity.')}</span></div>}
      {conflict && <div className="error" role="alert">{t('该账号刚刚有变化，已读取最新信息。你的输入已保留，请核对后再次提交。', 'This account changed. Latest details are loaded and your input is retained. Review them before submitting again.')}{editor.member && <span>{t('当前公司：', 'Current company: ')}{editor.member.company || t('待分配', 'Unassigned')}</span>}</div>}
      {Boolean(formError) && <div className="error" role="alert">{errorText(formError, t)}</div>}
    </div><footer><button type="button" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</button><button type="submit" className={editor.kind === 'delete' ? 'danger' : 'primary'} disabled={busy}>{busy ? t('保存中…', 'Saving…') : editor.kind === 'delete' ? t('确认删除账号', 'Delete account') : editor.kind === 'reset' ? t('确认重置密码', 'Reset password') : t('保存', 'Save')}</button></footer></form></Dialog>}
  </>
}
