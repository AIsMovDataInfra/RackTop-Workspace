import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { parseSshImport } from './sshImport'
import { COMPANY_OPTIONS, type Company, type Translate } from './types'

type Parsed = ReturnType<typeof parseSshImport>
type Props = { company: Company; t: Translate; onClose: () => void; onSaved: (company: Company, added: number, skipped: number) => void; onFailure: (reason: unknown) => void }
const address = (host: string, port: number, username: string) => `${username}@${host.includes(':') ? `[${host}]` : host}:${port}`

export function SshImportDialog({ company: initialCompany, t, onClose, onSaved, onFailure }: Props) {
  const [company, setCompany] = useState(initialCompany)
  const [parsed, setParsed] = useState<Parsed>({ servers: [], issues: [] })
  const [selected, setSelected] = useState<number[]>([])
  const [filename, setFilename] = useState('')
  const [reading, setReading] = useState(false)
  const [members, setMembers] = useState<{ id: string; name: string; username: string }[]>([])
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersError, setMembersError] = useState<unknown>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const active = useRef(true), fileGeneration = useRef(0), saving = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false; fileGeneration.current++ } }, [])
  useEffect(() => {
    let current = true
    setMembers([]); setMemberIds([]); setMembersLoading(true); setMembersError(null)
    api.serverMembers(company).then(value => { if (current) setMembers(value.members) })
      .catch(reason => { if (current) setMembersError(reason) })
      .finally(() => { if (current) setMembersLoading(false) })
    return () => { current = false }
  }, [company])
  async function read(file: File | undefined) {
    if (!file || saving.current) return
    const attempt = ++fileGeneration.current
    setFilename(file.name); setError(null); setParsed({ servers: [], issues: [] }); setSelected([]); setReading(true)
    try {
      if (file.size > 1024 * 1024) throw new Error(t('配置文件不能超过 1 MB。', 'The configuration file must not exceed 1 MB.'))
      const result = parseSshImport(await file.text())
      if (active.current && attempt === fileGeneration.current) {
        setParsed(result); setSelected(result.servers.map((_, index) => index))
        if (!result.servers.length && !result.issues.length) setError(new Error(t('未找到可导入的 Host 配置。', 'No importable Host entries were found.')))
      }
    } catch (reason) { if (active.current && attempt === fileGeneration.current) setError(reason) }
    finally { if (active.current && attempt === fileGeneration.current) setReading(false) }
  }
  async function save() {
    if (saving.current || reading || membersLoading || membersError || !selected.length) return
    saving.current = true; setBusy(true); setError(null)
    try {
      const result = await api.importServers({ company, memberIds, servers: selected.map(index => {
        const { name, host, port, username, jump, enabled } = parsed.servers[index]
        return { name, host, port, username, jump, enabled }
      }) })
      if (active.current) onSaved(company, result.servers.length, result.skipped)
    } catch (reason) {
      if (active.current) {
        if (reason instanceof ApiError && [401, 403].includes(reason.status)) onFailure(reason)
        else setError(reason)
      }
    } finally { saving.current = false; if (active.current) setBusy(false) }
  }
  return <Dialog title={t('导入 SSH 配置', 'Import SSH configuration')} onClose={onClose} busy={busy} t={t}>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="dialog-body server-form">
        <p className="server-help">{t('选择 RackTop 导出的 .conf 文件，也支持独立的 SSH Host 配置。预览并勾选后，一次最多导入 50 台。', 'Choose a .conf file exported by RackTop or standalone SSH Host entries. Preview and select up to 50 servers per import.')}</p>
        <label>{t('SSH 配置文件', 'SSH configuration file')}<input type="file" accept=".conf,.txt,text/plain" disabled={busy} onChange={event => { void read(event.target.files?.[0]) }}/></label>
        {filename && <p className="server-import-filename">{filename}</p>}
        {reading && <p role="status">{t('正在读取配置…', 'Reading configuration…')}</p>}
        {parsed.issues.length > 0 && <div className="callout server-import-issues" role="status"><strong>{t('配置提示', 'Configuration notes')}</strong><ul>{parsed.issues.map((issue, index) => <li key={index}>{issue.line > 0 && t(`第 ${issue.line} 行：`, `Line ${issue.line}: `)}{t(issue.message, issue.messageEn)}</li>)}</ul></div>}
        {parsed.servers.length > 0 && <fieldset><legend>{t(`服务器预览 · 已选 ${selected.length} / ${parsed.servers.length}`, `Server preview · ${selected.length} / ${parsed.servers.length} selected`)}</legend>
          <label className="server-check"><input type="checkbox" disabled={busy} checked={selected.length === parsed.servers.length} onChange={event => setSelected(event.target.checked ? parsed.servers.map((_, index) => index) : [])}/>{t('全选', 'Select all')}</label>
          <div className="server-import-list">{parsed.servers.map((server, index) => <label className="server-check server-import-row" key={index}><input type="checkbox" checked={selected.includes(index)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, index] : previous.filter(item => item !== index))}/><span><strong>{server.name}</strong><code>{address(server.host, server.port, server.username)}</code>{server.jump && <small>{t('跳板机：', 'Jump host: ')}{address(server.jump.host, server.jump.port, server.jump.username)}</small>}</span></label>)}</div>
          <p className="server-help">{t('仅保存勾选的有效条目。相同组织下已存在的连接会跳过，保留原来的配置与授权。', 'Only selected valid entries are saved. Existing connections in the same organization are skipped, preserving their settings and access.')}</p>
        </fieldset>}
        <label>{t('所属组织', 'Organization')}<select value={company} disabled={busy} onChange={event => { setCompany(event.target.value as Company); setMemberIds([]); setMembers([]); setMembersLoading(true); setError(null) }}>{COMPANY_OPTIONS.map(item => <option key={item}>{item}</option>)}</select></label>
        <fieldset><legend>{t('授权成员', 'Member access')}</legend><p className="server-help">{t('以下成员可访问本次新增的所有服务器。组织管理员自动拥有访问权限。', 'Selected members can access every new server in this import. Organization administrators have access automatically.')}</p>
          {membersLoading ? <p role="status">{t('正在读取成员…', 'Loading members…')}</p> : membersError ? <div className="error" role="alert">{errorText(membersError, t)}</div> : !members.length ? <p className="server-help">{t('该组织暂无可授权成员。', 'There are no members to grant access to in this organization.')}</p> : members.map(member => <label className="server-check" key={member.id}><input type="checkbox" checked={memberIds.includes(member.id)} disabled={busy} onChange={event => setMemberIds(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))}/><span>{member.name}<small>{member.username}</small></span></label>)}
        </fieldset>
        <p className="server-help">{t('文件在浏览器中解析，只上传连接地址、用户名和跳板机信息；密码、私钥和本机文件路径不会上传。导入后可在“编辑”中填写共享密码。', 'The file is parsed in your browser. Only connection addresses, usernames and jump hosts are uploaded; passwords, private keys and local file paths stay on your computer. After importing, choose Edit to set a shared password.')}</p>
        {Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}
      </div>
      <footer className="dialog-footer"><button type="button" onClick={onClose} disabled={busy}>{t('取消', 'Cancel')}</button><button className="primary" type="submit" disabled={busy || reading || membersLoading || Boolean(membersError) || !selected.length}>{busy ? t('正在导入…', 'Importing…') : t(`导入 ${selected.length} 台服务器`, `Import ${selected.length} servers`)}</button></footer>
    </form>
  </Dialog>
}
