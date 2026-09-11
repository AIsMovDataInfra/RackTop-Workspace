import { useEffect, useRef, useState } from 'react'
import { Copy, Pencil, Plus, RefreshCw, Server, Upload, Users } from 'lucide-react'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { formatTime } from './time'
import { COMPANY_OPTIONS, type Company, type ManagedServer, type ManagedServerDraft, type Session } from './types'
import type { PreferencesState } from './preferences'
import { WorkModuleFrame } from './WorkModuleFrame'
import { SshImportDialog } from './SshImportDialog'
import './servers.css'

type Props = { session: Session; state: PreferencesState; navigate: (path: string) => void; onLogout: () => Promise<void>; onSessionChanged: (session: Session) => void; onSessionExpired: () => void }
type Editor = { mode: 'create' | 'edit' | 'grants'; base?: ManagedServer; draft: ManagedServerDraft }
const draftOf = (server: ManagedServer): ManagedServerDraft => ({ company: server.company, name: server.name, host: server.host, port: server.port, username: server.username, jump: server.jump, enabled: server.enabled, memberIds: server.memberIds ?? [] })
const endpoint = (host: string, port: number, username: string) => username + '@' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port

export function ServersWorkspace(props: Props) {
  const { session, state, onSessionExpired } = props
  const { t, preferences } = state
  const [servers, setServers] = useState<ManagedServer[]>([])
  const [company, setCompany] = useState<Company | ''>('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [importing, setImporting] = useState(false)
  const [members, setMembers] = useState<{ id: string; name: string; username: string }[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState(false)
  const [formError, setFormError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const admin = session.user?.role === 'admin'
  const superAdmin = session.user?.isSuperAdmin === true
  function failed(reason: unknown) {
    if (reason instanceof ApiError && [401,403].includes(reason.status)) {
      setServers([]); setEditor(null); setImporting(false)
      if (reason.status === 401) onSessionExpired()
    }
    setError(reason)
  }
  async function load() {
    const attempt = ++generation.current
    setLoading(true); setError(null)
    try { const value = await api.servers(company || undefined); if (attempt === generation.current) setServers(value.servers) }
    catch (reason) { if (attempt === generation.current) failed(reason) }
    finally { if (attempt === generation.current) setLoading(false) }
  }
  useEffect(() => {
    setServers([]); setEditor(null); setImporting(false); void load()
    return () => { generation.current++ }
  }, [session.user?.id, session.user?.company, session.user?.role, session.user?.isSuperAdmin, company])
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden && !editor && !importing && !busy) void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [company, editor, importing, busy])
  useEffect(() => {
    const selectedCompany = editor?.draft.company
    if (!editor || editor.mode === 'edit' || !selectedCompany) { setMembers([]); return }
    let active = true
    setMembers([]); setMembersLoading(true); setMembersError(false); setFormError(null)
    api.serverMembers(selectedCompany).then(value => { if (active) setMembers(value.members) })
      .catch(reason => { if (active) { setFormError(reason); setMembersError(true) } }).finally(() => { if (active) setMembersLoading(false) })
    return () => { active = false }
  }, [editor?.mode, editor?.draft.company, editor?.base?.id])
  function open(mode: Editor['mode'], base?: ManagedServer) {
    setFormError(null); setNotice('')
    setEditor({ mode, base, draft: base ? draftOf(base) : { company: company || session.user?.company || COMPANY_OPTIONS[0], name: '', host: '', port: 22, username: '', jump: null, enabled: true, memberIds: [] } })
  }
  function change(patch: Partial<ManagedServerDraft>) { setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...patch } } : null) }
  async function save() {
    if (!editor || busy || !admin || (editor.mode !== 'edit' && (membersLoading || membersError))) return
    const attempt = generation.current
    setBusy(true); setFormError(null)
    try {
      let value: { server: ManagedServer }
      if (editor.mode === 'create') value = await api.createServer(editor.draft)
      else if (editor.mode === 'grants') value = await api.grantServer(editor.base!.id, editor.base!.version, editor.draft.memberIds ?? [])
      else {
        const { company: _company, memberIds: _members, ...draft } = editor.draft
        value = await api.updateServer(editor.base!.id, { ...draft, version: editor.base!.version })
      }
      if (attempt !== generation.current) return
      setServers(previous => [...previous.filter(item => item.id !== value.server.id), value.server])
      setEditor(null); setNotice(t('已保存，获授权成员刷新后即可看到。', 'Saved. Authorized members can refresh to receive this change.'))
    } catch (reason) {
      if (attempt === generation.current) {
        if (reason instanceof ApiError && [401,403].includes(reason.status)) failed(reason)
        else setFormError(reason)
      }
    } finally { setBusy(false) }
  }
  async function copy(server: ManagedServer) {
    try { await navigator.clipboard.writeText(endpoint(server.host, server.port, server.username)); setNotice(t('连接地址已复制。', 'Connection address copied.')) }
    catch { setError(new Error(t('无法复制，请选择并复制页面上的连接地址。', 'Select and copy the connection address on this page.'))) }
  }
  const filtered = servers.filter(server => [server.name,server.host,server.username,server.company].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const form = editor?.draft
  return <>
    <WorkModuleFrame {...props} section="servers" title={t('服务器', 'Servers')} subtitle={t('统一维护 SSH 地址、用户名和访问成员。', 'Maintain SSH addresses, usernames and member access in one place.')} modal={Boolean(editor) || importing} actions={<><button disabled={loading} onClick={() => void load()}><RefreshCw size={16}/>{t('刷新', 'Refresh')}</button>{superAdmin && <button onClick={() => { setNotice(''); setImporting(true) }}><Upload size={16}/>{t('导入 SSH 配置', 'Import SSH configuration')}</button>}{admin && <button className="primary" onClick={() => open('create')}><Plus size={17}/>{t('添加服务器', 'Add server')}</button>}</>}>
          {Boolean(error) && <div className="error" role="alert">{errorText(error,t)}</div>}
          {notice && <div className="callout" role="status">{notice}</div>}
          <div className="server-filters"><label>{t('搜索服务器', 'Search servers')}<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('名称、地址或用户名', 'Name, address or username')}/></label>{superAdmin && <label>{t('组织', 'Organization')}<select value={company} onChange={event => setCompany(event.target.value as Company | '')}><option value="">{t('全部组织', 'All organizations')}</option>{COMPANY_OPTIONS.map(item => <option key={item}>{item}</option>)}</select></label>}<span role="status">{loading ? t('正在读取…', 'Loading…') : t(`${filtered.length} 台服务器`, `${filtered.length} ${filtered.length === 1 ? 'server' : 'servers'}`)}</span></div>
          <div className="server-directory">{filtered.map(server => <article className="server-entry" key={server.id}>
            <div className="server-entry-title"><Server size={21}/><div><h2>{server.name}</h2><span>{server.company} · {server.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</span></div></div>
            <dl><div><dt>{t('SSH 地址', 'SSH address')}</dt><dd><code>{endpoint(server.host, server.port, server.username)}</code></dd></div>{server.jump && <div><dt>{t('跳板机', 'Jump host')}</dt><dd><code>{endpoint(server.jump.host, server.jump.port, server.jump.username)}</code></dd></div>}<div><dt>{t('最近更新', 'Updated')}</dt><dd>{formatTime(server.updatedAt, preferences.locale)}</dd></div>{admin && <div><dt>{t('成员授权', 'Member access')}</dt><dd>{(server.memberIds?.length ?? 0) + t(' 人', ' members')}</dd></div>}</dl>
            <div className="server-entry-actions"><button onClick={() => void copy(server)}><Copy size={15}/>{t('复制地址', 'Copy address')}</button>{admin && <><button onClick={() => open('edit',server)}><Pencil size={15}/>{t('编辑', 'Edit')}</button><button onClick={() => open('grants',server)}><Users size={15}/>{t('授权', 'Access')}</button></>}</div>
          </article>)}</div>
          {!loading && !filtered.length && <div className="empty-state"><Server size={28}/><h2>{search ? t('没有匹配的服务器', 'No matching servers') : t('暂无可访问的服务器', 'No servers available')}</h2><p>{admin ? t('添加服务器后，为需要使用的成员授权。', 'Add a server and grant access to its members.') : t('请管理员将服务器授权给你。', 'Ask your administrator to grant server access.')}</p></div>}
          <p className="server-help">{t('目录只保存连接信息。SSH 密码和私钥由使用者在本机管理。', 'The directory stores connection details. SSH passwords and private keys are managed on each member’s computer.')}</p>
    </WorkModuleFrame>
    {importing && superAdmin && <SshImportDialog company={company || session.user?.company || COMPANY_OPTIONS[0]} t={t} onClose={() => setImporting(false)} onFailure={failed} onSaved={(importCompany, added, skipped) => {
      setImporting(false); setNotice(t(`已导入 ${added} 台服务器${skipped ? `，跳过 ${skipped} 个重复连接` : ''}。获授权成员刷新后即可看到。`, `Imported ${added} servers${skipped ? `; skipped ${skipped} duplicate connections` : ''}. Authorized members can refresh to see them.`))
      if (company === importCompany) void load(); else setCompany(importCompany)
    }}/>}
    {editor && form && <Dialog title={editor.mode === 'create' ? t('添加服务器', 'Add server') : editor.mode === 'edit' ? t('编辑服务器', 'Edit server') : t('服务器授权', 'Server access')} subtitle={editor.base?.name} onClose={() => setEditor(null)} busy={busy} t={t}>
      <form onSubmit={event => { event.preventDefault(); void save() }}><div className="dialog-body server-form">
        {editor.mode === 'create' && superAdmin && <button type="button" disabled={busy} onClick={() => { setEditor(null); setImporting(true) }}><Upload size={16}/>{t('从 SSH 配置文件导入', 'Import from an SSH configuration file')}</button>}
        {editor.mode !== 'grants' && <><label>{t('组织', 'Organization')}<select required value={form.company} disabled={busy || editor.mode === 'edit' || !superAdmin} onChange={event => change({company:event.target.value as Company,memberIds:[]})}>{COMPANY_OPTIONS.filter(item => superAdmin || item === session.user?.company).map(item => <option key={item}>{item}</option>)}</select></label>
          <label>{t('服务器名称', 'Server name')}<input required maxLength={24} value={form.name} disabled={busy} onChange={event => change({name:event.target.value})}/></label>
          <div className="server-form-grid"><label>{t('主机地址', 'Host')}<input required autoComplete="off" value={form.host} disabled={busy} onChange={event => change({host:event.target.value})}/></label><label>{t('端口', 'Port')}<input required type="number" min={1} max={65535} value={form.port} disabled={busy} onChange={event => change({port:event.target.valueAsNumber})}/></label></div>
          <label>{t('SSH 用户名', 'SSH username')}<input required autoComplete="off" value={form.username} disabled={busy} onChange={event => change({username:event.target.value})}/></label>
          <label className="server-check"><input type="checkbox" checked={!!form.jump} disabled={busy} onChange={event => change({jump:event.target.checked ? {host:'',port:22,username:''} : null})}/>{t('通过跳板机连接', 'Connect through a jump host')}</label>
          {form.jump && <fieldset><legend>{t('跳板机', 'Jump host')}</legend><div className="server-form-grid"><label>{t('主机地址', 'Host')}<input required value={form.jump.host} disabled={busy} onChange={event => change({jump:{...form.jump!,host:event.target.value}})}/></label><label>{t('端口', 'Port')}<input required type="number" min={1} max={65535} value={form.jump.port} disabled={busy} onChange={event => change({jump:{...form.jump!,port:event.target.valueAsNumber}})}/></label></div><label>{t('SSH 用户名', 'SSH username')}<input required value={form.jump.username} disabled={busy} onChange={event => change({jump:{...form.jump!,username:event.target.value}})}/></label></fieldset>}
          <label className="server-check"><input type="checkbox" checked={form.enabled} disabled={busy} onChange={event => change({enabled:event.target.checked})}/>{t('启用服务器', 'Enable server')}</label>
        </>}
        {editor.mode !== 'edit' && <fieldset><legend>{t('可访问成员', 'Authorized members')}</legend><p className="server-help">{t('同组织管理员可维护该服务器；其他成员需要单独勾选。', 'Administrators in this organization can maintain the server. Select other members individually.')}</p>{membersLoading ? <p role="status">{t('正在读取成员…', 'Loading members…')}</p> : members.map(member => <label className="server-check" key={member.id}><input type="checkbox" checked={form.memberIds?.includes(member.id) ?? false} disabled={busy} onChange={event => change({memberIds:event.target.checked ? [...(form.memberIds ?? []),member.id] : (form.memberIds ?? []).filter(id => id !== member.id)})}/><span>{member.name}{member.username !== member.name && <small>{member.username}</small>}</span></label>)}{!membersLoading && !members.length && <p>{t('该组织暂无成员。', 'No members in this organization.')}</p>}</fieldset>}
        {Boolean(formError) && <div className="error" role="alert">{errorText(formError,t)}{formError instanceof ApiError && formError.code === 'VERSION_CONFLICT' && <button type="button" onClick={() => {setEditor(null);void load()}}>{t('关闭并读取最新配置', 'Close and load latest settings')}</button>}</div>}
      </div><footer><button type="button" disabled={busy} onClick={() => setEditor(null)}>{t('取消', 'Cancel')}</button><button type="submit" className="primary" disabled={busy || (editor.mode !== 'edit' && (membersLoading || membersError))}>{busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button></footer></form>
    </Dialog>}
  </>
}
