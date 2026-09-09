import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, Check, ChevronRight, ClipboardList, LayoutGrid, FileText, HandHelping, LogOut, MapPin, Package, Pencil, Plus, QrCode, RefreshCw, Search, Settings, UserRound } from 'lucide-react'
import { api, ApiError } from './api'
import { EquipmentPhoto } from './EquipmentPhoto'
import { EquipmentThumbnail } from './EquipmentThumbnail'
import { MemberAvatar } from './MemberAvatar'
import { EquipmentLabel } from './AssetLabel'
export { EquipmentLabel, equipmentUrl } from './AssetLabel'
import { COMPANY_OPTIONS } from './types'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { SettingsDialog } from './SettingsDialog'
import { formatTime } from './time'
import type { PreferencesState } from './preferences'
import type { Equipment, EquipmentDraft, EquipmentHistory, EquipmentStatus, Session, Translate } from './types'

const statuses: EquipmentStatus[] = ['available', 'in_use', 'maintenance', 'retired']
const limits = { name: 120, model: 160, responsiblePerson: 80, currentUser: 80, notes: 4000 }
export const EQUIPMENT_CATEGORIES = ['机械臂', '台式主机', '显示屏', '摄像头模组', '实验物料', '小推车', '夹爪']
export const EQUIPMENT_LOCATIONS = ['上海', '太仓']
function categoryText(value: string, t: Translate) { return ({ '机械臂': t('机械臂', 'Robot arm'), '台式主机': t('台式主机', 'Desktop computer'), '显示屏': t('显示屏', 'Display'), '摄像头模组': t('摄像头模组', 'Camera module'), '实验物料': t('实验物料', 'Lab materials'), '小推车': t('小推车', 'Cart'), '夹爪': t('夹爪', 'Gripper') } as Record<string, string>)[value] || value }
function locationText(value: string, t: Translate) { return value === '上海' ? t('上海', 'Shanghai') : value === '太仓' ? t('太仓', 'Taicang') : value }
const fields = ['name', 'category', 'model', 'company', 'responsiblePerson', 'currentUser', 'location', 'notes', 'status'] as const
const emptyDraft: EquipmentDraft = { name: '', category: '', model: '', company: '', responsiblePerson: '', currentUser: '', location: '', notes: '', status: 'available' }
const draftOf = (item: Equipment): EquipmentDraft => Object.fromEntries(fields.map((field) => [field, item[field]])) as unknown as EquipmentDraft
const changesFrom = (draft: EquipmentDraft, base: Equipment) => Object.fromEntries(fields.filter((field) => draft[field] !== base[field]).map((field) => [field, draft[field]])) as Partial<EquipmentDraft>
function statusText(status: string, t: Translate) { return ({ available: t('可用', 'Available'), in_use: t('使用中', 'In use'), maintenance: t('维修中', 'Maintenance'), retired: t('已退役', 'Retired') } as Record<string, string>)[status] || status }
function fieldText(field: string, t: Translate) { return ({ company: t('公司名称', 'Company'), name: t('设备名称', 'Device name'), code: t('设备编号', 'Device code'), category: t('类别', 'Category'), model: t('型号', 'Model'), serialNumber: t('设备编号', 'Device number'), legacySerialNumber: t('原序列号', 'Previous serial number'), currentUser: t('使用人', 'Current user'), photo: t('照片', 'Photo'), responsiblePerson: t('负责人', 'Responsible person'), location: t('位置', 'Location'), notes: t('备注', 'Notes'), status: t('状态', 'Status') } as Record<string, string>)[field] || field }
function historyChangeText(change: EquipmentHistory['changes'][number], t: Translate) {
  if (change.field === 'photo') return !change.newValue ? t('已移除照片', 'Photo removed') : change.oldValue ? t('已更换照片', 'Photo replaced') : t('已上传照片', 'Photo uploaded')
  const valueText = (value: string | null) => !value ? t('未填写', 'Not recorded') : change.field === 'status' ? statusText(value, t) : change.field === 'category' ? categoryText(value, t) : change.field === 'location' ? locationText(value, t) : value
  return `${change.oldValue === null ? '' : `${valueText(change.oldValue)} → `}${valueText(change.newValue)}`
}
function Status({ value, t }: { value: EquipmentStatus; t: Translate }) { return <span className={`equipment-status equipment-status--${value}`}>{statusText(value, t)}</span> }
type Editor = { kind: 'create' | 'edit' | 'assign' | 'return'; base?: Equipment; draft: EquipmentDraft }
type Modal = 'editor' | 'label' | 'settings' | null

export function EquipmentWorkspace({ id, session, state, navigate, onSessionChanged, onSessionExpired, onLogout, bootstrapToken }: { id?: string; session: Session; state: PreferencesState; navigate: (path: string) => void; onSessionChanged: (session: Session) => void; onSessionExpired: () => void; onLogout: () => Promise<void>; bootstrapToken?: string }) {
  const { t, preferences } = state
  const [items, setItems] = useState<Equipment[]>([])
  const [detail, setDetail] = useState<{ equipment: Equipment; history: EquipmentHistory[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [notice, setNotice] = useState<'saved' | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const item = detail?.equipment

  useEffect(() => {
    let active = true
    if (!session.user) { setItems([]); setDetail(null); setLoading(false); return }
    setLoading(true); setError(null); setDetail(null)
    const load = id ? api.equipmentDetails(id).then((value) => { if (active) setDetail(value) }) : api.equipment().then((value) => { if (active) setItems(value.equipment) })
    void load.catch((reason) => { if (active) { if (reason instanceof ApiError && reason.status === 401) { setItems([]); setDetail(null); onSessionExpired() } else setError(reason) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id, revision, session.user?.id])
  useEffect(() => { heading.current?.focus(); setNotice(null) }, [id])
  function openEditor(kind: Editor['kind']) {
    if (!session.user) { onSessionExpired(); return }
    if (kind !== 'create' && !item) return
    setEditor({ kind, base: kind === 'create' ? undefined : item, draft: kind === 'create' ? { ...emptyDraft, company: session.user.isSuperAdmin ? '' : session.user.company || '', responsiblePerson: session.user.name } : { ...draftOf(item!), ...(kind === 'assign' ? { currentUser: session.user.name, status: 'in_use' as const } : kind === 'return' ? { currentUser: '', status: 'available' as const } : {}) } })
    setModal('editor')
  }
  function photoChanged(value: Equipment) {
    setDetail((old) => old ? { ...old, equipment: value } : old)
    void api.equipmentDetails(value.id).then((latest) => setDetail((old) => old?.equipment.id === latest.equipment.id && latest.equipment.version >= old.equipment.version ? latest : old)).catch((reason) => { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); else setError(reason) })
  }
  const filtered = items.filter((entry) => (!status || entry.status === status) && [entry.name, entry.code, entry.category, entry.model, entry.company || '', entry.serialNumber, entry.responsiblePerson, entry.currentUser, entry.location].some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  const close = () => setModal(null)
  if (!session.user) return null
  return <>
    <div className="workspace-shell equipment-workspace" inert={Boolean(modal)}>
      <aside className="sidebar">
        <div className="brand"><span><Activity size={24} /></span><div><strong>AIsMov RackTop</strong><small>{t('团队工作台', 'Team workspace')}</small></div></div>
        <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}><button onClick={() => navigate('/')}><LayoutGrid size={18} />{t('算力预约', 'Compute bookings')}</button><button onClick={() => navigate('/reports')}><FileText size={18}/>{t('周报与绩效', 'Weekly reports')}</button><button onClick={() => navigate('/requests')}><HandHelping size={18}/>{t('设备申请与领取', 'Device requests')}</button><button className="is-active" aria-current="page" onClick={() => navigate('/equipment')}><Package size={18} />{t('设备管理', 'Equipment')}</button>{session.user?.isSuperAdmin && <button onClick={() => navigate('/members')}><UserRound size={18} />{t('成员管理', 'Members')}</button>}</nav>
        <div className="sidebar-bottom"><div className="sidebar-note"><QrCode size={17} /><p>{t('贴上设备标签，成员登录后扫码查看与登记。', 'Members can scan a label to view and register equipment after signing in.')}</p></div><button className="sidebar-settings" onClick={() => setModal('settings')}><Settings size={17} />{t('设置', 'Settings')}</button><div className="profile"><MemberAvatar avatar={session.user?.avatar} /><div><strong>{session.user?.name || t('访客', 'Guest')}</strong><small>{session.user.company || t('跨公司管理', 'Across companies')} · {session.user?.isSuperAdmin ? t('超级管理员', 'Super administrator') : session.user?.role === 'admin' ? t('资源管理员', 'Resource administrator') : t('团队成员', 'Team member')}</small></div>{session.user ? <button className="icon-button" aria-label={t('退出登录', 'Sign out')} disabled={loggingOut} onClick={async () => { setLoggingOut(true); try { await onLogout() } catch (reason) { setError(reason) } finally { setLoggingOut(false) } }}><LogOut size={16} /></button> : <button onClick={onSessionExpired}>{t('登录', 'Sign in')}</button>}</div></div>
      </aside>
      <main className="main-workspace">
        <header className="page-header"><div><p>{t('团队设备台账', 'Team equipment inventory')}</p><h1 ref={heading} tabIndex={-1}>{id ? t('设备详情', 'Device details') : t('设备管理', 'Equipment')}</h1><span>{t('记录设备在哪里、由谁负责。', 'Know where your equipment is and who is responsible.')}</span></div><div className="header-actions"><button disabled={loading} aria-label={t('刷新设备', 'Refresh equipment')} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} />{t('刷新', 'Refresh')}</button>{!id && <button className="primary" onClick={() => openEditor('create')}><Plus size={17} />{t('新增设备', 'Add device')}</button>}</div></header>
        <div className="page-content">
          {id && <button className="equipment-back" onClick={() => navigate('/equipment')}><ArrowLeft size={16} />{t('全部设备', 'All equipment')}</button>}
          {Boolean(error) && <div className="error" role="alert">{error instanceof ApiError && error.status === 404 ? t('未找到这台设备，请核对标签链接或返回设备列表。', 'Device not found. Check the label link or return to the equipment list.') : errorText(error, t)}<button onClick={() => setRevision((value) => value + 1)}>{t('重新读取', 'Try again')}</button></div>}
          {notice && <div className="notice" role="status"><Check size={17} />{t('设备登记已保存。', 'Device registration saved.')}</div>}
          {loading ? <p role="status" className="loading-inline"><RefreshCw size={17} />{t('正在读取设备…', 'Loading equipment…')}</p> : id ? item && <>
            <section className="equipment-detail-card"><div className="equipment-detail-heading"><div><span className="equipment-code">{item.serialNumber}</span><h2>{item.name}</h2><p>{[categoryText(item.category, t), item.model].filter(Boolean).join(' · ') || t('尚未填写类别和型号', 'Category and model not recorded')}</p></div><Status value={item.status} t={t} /></div><div className="equipment-detail-actions"><button className="primary" onClick={() => openEditor('assign')}><ClipboardList size={17} />{t('领用登记', 'Register use')}</button>{item.currentUser && <button onClick={() => openEditor('return')}><ArrowLeft size={16} />{t('归还登记', 'Return device')}</button>}<button onClick={() => openEditor('edit')}><Pencil size={16} />{t('编辑信息', 'Edit details')}</button><button onClick={() => setModal('label')}><QrCode size={17} />{t('设备标签', 'Device label')}</button></div><dl className="equipment-facts">{(['company', 'responsiblePerson', 'currentUser', 'location', 'serialNumber', 'category', 'model'] as const).map((field) => <div key={field}><dt>{fieldText(field, t)}</dt><dd>{(field === 'category' ? categoryText(item[field], t) : field === 'location' ? locationText(item[field], t) : item[field]) || (field === 'company' ? t('待分配', 'Unassigned') : t('未填写', 'Not recorded'))}{((field === 'category' && !EQUIPMENT_CATEGORIES.includes(item.category)) || (field === 'location' && !EQUIPMENT_LOCATIONS.includes(item.location))) && <small className="equipment-legacy">{t('旧记录，编辑时请重新选择。', 'Legacy value. Select a supported value when editing.')}</small>}</dd></div>)}<div><dt>{t('最近更新', 'Last updated')}</dt><dd>{formatTime(item.updatedAt, preferences.locale)}</dd></div>{item.legacySerialNumber && <div><dt>{t('原序列号', 'Previous serial number')}</dt><dd>{item.legacySerialNumber}</dd></div>}</dl><EquipmentPhoto equipment={item} t={t} onChanged={photoChanged} onSessionExpired={onSessionExpired} />{item.notes && <div className="equipment-notes"><h3>{t('备注', 'Notes')}</h3><p>{item.notes}</p></div>}</section>
            <section className="equipment-history"><div className="equipment-section-title"><h2>{t('登记记录', 'Registration history')}</h2><span>{t('最近 30 条', 'Latest 30 entries')}</span></div>{detail.history.length ? <ol>{detail.history.map((entry, index) => <li key={`${entry.at}-${index}`}><div><strong>{entry.actorName}</strong><span>{entry.action === 'created' ? t('新增设备', 'Added device') : t('更新登记', 'Updated registration')}</span><time dateTime={entry.at}>{formatTime(entry.at, preferences.locale)}</time></div><ul>{entry.changes.filter((change) => change.field !== 'code' && (change.oldValue !== null || Boolean(change.newValue))).map((change) => <li key={change.field}><span>{fieldText(change.field, t)}</span><span>{historyChangeText(change, t)}</span></li>)}</ul></li>)}</ol> : <p className="muted">{t('暂无登记记录。', 'No registration history yet.')}</p>}</section>
          </> : !error && <>
            <form className="equipment-filters" onSubmit={(event) => event.preventDefault()}><label className="equipment-search"><span>{t('搜索设备', 'Search equipment')}</span><div><Search size={18} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('名称、编号、负责人或使用人', 'Name, number, owner or current user')} /></div></label><label>{t('状态', 'Status')}<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t('全部状态', 'All statuses')}</option>{statuses.map((value) => <option key={value} value={value}>{statusText(value, t)}</option>)}</select></label></form>
            <div className="equipment-section-title"><h2>{t('设备目录', 'Equipment catalog')}</h2><span>{filtered.length} / {items.length} {t('台设备', 'devices')}</span></div>
            {filtered.length ? <div className="equipment-list">{filtered.map((entry) => <a className="equipment-row" href={`/equipment/${encodeURIComponent(entry.id)}`} key={entry.id} onClick={(event) => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(`/equipment/${encodeURIComponent(entry.id)}`) } }}><EquipmentThumbnail equipment={entry} t={t}/><div className="equipment-row-name"><small>{entry.serialNumber}</small><h3>{entry.name}</h3><span>{entry.model || categoryText(entry.category, t) || t('型号未填写', 'Model not recorded')}</span></div><div className="equipment-row-meta"><span><UserRound size={14} />{entry.responsiblePerson || t('负责人未填写', 'No responsible person')}</span><span><UserRound size={14} />{t('使用人：', 'In use by: ')}{entry.currentUser || t('未登记', 'Not assigned')}</span><span><MapPin size={14} />{locationText(entry.location, t) || t('位置未填写', 'No location')}</span></div><Status value={entry.status} t={t} /><ChevronRight size={17} /></a>)}</div> : <div className="empty-state"><span><Package size={28} /></span><h3>{items.length ? t('没有匹配的设备', 'No matching equipment') : t('还没有设备', 'No equipment yet')}</h3><p>{items.length ? t('试试其他关键词或状态。', 'Try another search or status.') : t('新增第一台设备，生成可贴在设备上的二维码标签。', 'Add your first device and create its QR label.')}</p><button onClick={() => items.length ? (setSearch(''), setStatus('')) : openEditor('create')}>{items.length ? t('清除筛选', 'Clear filters') : t('新增设备', 'Add device')}</button></div>}
          </>}
        </div>
      </main>
    </div>
    {modal === 'settings' && <SettingsDialog session={session} state={state} onClose={close} onSessionChanged={onSessionChanged} />}
    {modal === 'editor' && editor && <EquipmentEditor isSuperAdmin={Boolean(session.user?.isSuperAdmin)} ownCompany={session.user.company || undefined} editor={editor} setEditor={setEditor} t={t} onClose={close} onAuthRequired={onSessionExpired} onSaved={(saved) => { setModal(null); setEditor(null); if (id !== saved.id) navigate(`/equipment/${encodeURIComponent(saved.id)}`); else setRevision((value) => value + 1); setNotice('saved') }} />}
    {modal === 'label' && item && <EquipmentLabel equipment={item} t={t} onClose={close} />}
  </>
}

function EquipmentEditor({ isSuperAdmin, ownCompany, editor, setEditor, t, onClose, onSaved, onAuthRequired }: { isSuperAdmin: boolean; ownCompany?: string; editor: Editor; setEditor: React.Dispatch<React.SetStateAction<Editor | null>>; t: Translate; onClose: () => void; onSaved: (equipment: Equipment) => void; onAuthRequired: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [refreshed, setRefreshed] = useState(false)
  const conflict = error instanceof ApiError && error.code === 'VERSION_CONFLICT'
  const usageOnly = editor.kind === 'assign' || editor.kind === 'return'
  const visibleFields = usageOnly ? editor.kind === 'assign' ? ['currentUser'] as const : [] : ['name', 'model', 'responsiblePerson', 'currentUser'] as const
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return
    if (!editor.draft.name.trim()) { setError(new Error(t('请输入设备名称。', 'Enter a device name.'))); return }
    if (!editor.base && !COMPANY_OPTIONS.some((company) => company === editor.draft.company)) { setError(new Error(t('请选择公司。未分配公司的成员请联系超级管理员。', 'Choose a company. Members without a company should contact the super administrator.'))); return }
    if (!EQUIPMENT_CATEGORIES.includes(editor.draft.category) || !EQUIPMENT_LOCATIONS.includes(editor.draft.location)) { setError(new Error(t('请选择设备类别和位置。旧记录也需要重新选择。', 'Choose a supported category and location, including for legacy records.'))); return }
    setBusy(true); setError(null)
    try {
      const result = editor.base ? await api.updateEquipment(editor.base.id, { ...changesFrom(editor.draft, editor.base), version: editor.base.version }) : await api.createEquipment(editor.draft)
      onSaved(result.equipment)
    } catch (reason) { if (reason instanceof ApiError && reason.status === 401) onAuthRequired(); else setError(reason) } finally { setBusy(false) }
  }
  async function refreshVersion() {
    if (!editor.base || busy) return
    setBusy(true)
    try {
      const changes = changesFrom(editor.draft, editor.base)
      const result = await api.equipmentDetails(editor.base.id)
      setEditor({ ...editor, base: result.equipment, draft: { ...draftOf(result.equipment), ...changes } }); setError(null); setRefreshed(true)
    } catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  return <Dialog title={editor.kind === 'create' ? t('新增设备', 'Add device') : editor.kind === 'assign' ? t('领用登记', 'Register use') : editor.kind === 'return' ? t('归还登记', 'Return device') : t('编辑设备', 'Edit device')} subtitle={editor.base ? `${editor.base.serialNumber} · ${editor.base.name}` : t('填写名称、类别和位置，编号会自动生成。', 'Enter a name, category and location. The device number is generated automatically.')} t={t} onClose={onClose} busy={busy}>
    <form onSubmit={(event) => void save(event)}><div className="dialog-body"><p className="field-help">{t('设备编号：', 'Device number: ')}{editor.base?.serialNumber || t('保存后自动生成', 'Generated when saved')}</p>{!usageOnly ? <label>{t('公司名称', 'Company')}{!editor.base && t('（必填）', ' (required)')}<select name="company" value={editor.draft.company} required={!editor.base} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, company: event.target.value } })}><option value="" disabled={Boolean(editor.base?.company)}>{editor.base ? t('待分配', 'Unassigned') : t('请选择公司', 'Choose a company')}</option>{COMPANY_OPTIONS.filter(company => isSuperAdmin || company === ownCompany).map((company) => <option key={company} value={company}>{company}</option>)}</select></label> : <p className="field-help">{t('公司名称：', 'Company: ')}{editor.draft.company || t('待分配', 'Unassigned')}</p>}{usageOnly && <p className="field-help">{t('负责人：', 'Responsible person: ')}{editor.draft.responsiblePerson || t('未填写', 'Not recorded')}{editor.kind === 'return' && t('。归还后使用人将清空。', '. Returning clears the current user.')}</p>}<div className="field-pair">{visibleFields.map((field) => <label key={field}>{fieldText(field, t)}{field === 'name' ? t('（必填）', ' (required)') : ''}<input name={field} value={editor.draft[field]} maxLength={limits[field]} required={field === 'name'} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} /></label>)}</div><div className="field-pair">{(!usageOnly || !EQUIPMENT_CATEGORIES.includes(editor.draft.category)) && <EquipmentSelect field="category" value={editor.draft.category} options={EQUIPMENT_CATEGORIES} t={t} disabled={busy} onChange={(value) => setEditor({ ...editor, draft: { ...editor.draft, category: value } })} />}<EquipmentSelect field="location" value={editor.draft.location} options={EQUIPMENT_LOCATIONS} t={t} disabled={busy} onChange={(value) => setEditor({ ...editor, draft: { ...editor.draft, location: value } })} /></div><label>{t('状态', 'Status')}<select name="status" value={editor.draft.status} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, status: event.target.value as EquipmentStatus } })}>{statuses.map((value) => <option key={value} value={value}>{statusText(value, t)}</option>)}</select></label>{!usageOnly && <label>{t('备注', 'Notes')}<textarea name="notes" maxLength={limits.notes} value={editor.draft.notes} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, notes: event.target.value } })} /></label>}{Boolean(error) && <div className="error" role="alert">{conflict ? t('设备已被其他人更新。你的输入已保留，请读取最新版本，核对后再保存。', 'Someone updated this device. Your input is preserved. Load the latest version, review it, then save again.') : errorText(error, t)}{conflict && <button type="button" disabled={busy} onClick={() => void refreshVersion()}>{t('读取最新版本', 'Load latest version')}</button>}</div>}{refreshed && <div className="callout" role="status">{t('已读取最新版本并保留你的修改，请核对后保存。最新负责人：', 'Latest version loaded with your changes preserved. Review before saving. Latest responsible person: ')}{editor.base?.responsiblePerson || t('未填写', 'Not recorded')}{t('；使用人：', '; current user: ')}{editor.base?.currentUser || t('未登记', 'Not assigned')}{t('；位置：', '; location: ')}{editor.base?.location || t('未填写', 'Not recorded')}</div>}</div><footer><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button><button type="submit" className="primary" disabled={busy || conflict}>{busy ? t('保存中…', 'Saving…') : t('保存登记', 'Save registration')}</button></footer></form>
  </Dialog>
}

function EquipmentSelect({ field, value, options, disabled, onChange, t }: { field: 'category' | 'location'; value: string; options: string[]; disabled: boolean; onChange: (value: string) => void; t: Translate }) {
  const legacy = Boolean(value) && !options.includes(value)
  return <label>{fieldText(field, t)}{t('（必填）', ' (required)')}<select name={field} required value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">{t('请选择', 'Select an option')}</option>{legacy && <option value={value} disabled>{value} {t('（旧值，请重新选择）', '(legacy; select a supported value)')}</option>}{options.map((option) => <option value={option} key={option}>{field === 'category' ? categoryText(option, t) : locationText(option, t)}</option>)}</select>{legacy && <span className="equipment-legacy">{t('保留了旧记录，请选择正确的类别或位置。', 'The legacy value is preserved. Choose the correct category or location.')}</span>}</label>
}
