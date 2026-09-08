import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, Check, ChevronRight, ClipboardList, Download, LayoutGrid, LogOut, MapPin, Package, Pencil, Plus, Printer, QrCode, RefreshCw, Search, Settings, UserRound } from 'lucide-react'
import QRCode from 'qrcode'
import { api, ApiError } from './api'
import { AuthDialog } from './AuthDialog'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { SettingsDialog } from './SettingsDialog'
import { formatTime } from './time'
import type { PreferencesState } from './preferences'
import type { Equipment, EquipmentDraft, EquipmentHistory, EquipmentStatus, Session, Translate } from './types'

const statuses: EquipmentStatus[] = ['available', 'in_use', 'maintenance', 'retired']
const limits = { name: 120, category: 80, model: 160, serialNumber: 160, responsiblePerson: 80, location: 160, notes: 4000 }
const fields = ['name', 'category', 'model', 'serialNumber', 'responsiblePerson', 'location', 'notes', 'status'] as const
const emptyDraft: EquipmentDraft = { name: '', category: '', model: '', serialNumber: '', responsiblePerson: '', location: '', notes: '', status: 'available' }
const draftOf = (item: Equipment): EquipmentDraft => Object.fromEntries(fields.map((field) => [field, item[field]])) as unknown as EquipmentDraft
const changesFrom = (draft: EquipmentDraft, base: Equipment) => Object.fromEntries(fields.filter((field) => draft[field] !== base[field]).map((field) => [field, draft[field]])) as Partial<EquipmentDraft>
export const equipmentUrl = (id: string) => `${window.location.origin}/equipment/${encodeURIComponent(id)}`
function statusText(status: string, t: Translate) { return ({ available: t('可用', 'Available'), in_use: t('使用中', 'In use'), maintenance: t('维修中', 'Maintenance'), retired: t('已退役', 'Retired') } as Record<string, string>)[status] || status }
function fieldText(field: string, t: Translate) { return ({ name: t('设备名称', 'Device name'), code: t('设备编号', 'Device code'), category: t('类别', 'Category'), model: t('型号', 'Model'), serialNumber: t('序列号', 'Serial number'), responsiblePerson: t('负责人', 'Responsible person'), location: t('位置', 'Location'), notes: t('备注', 'Notes'), status: t('状态', 'Status') } as Record<string, string>)[field] || field }
function Status({ value, t }: { value: EquipmentStatus; t: Translate }) { return <span className={`equipment-status equipment-status--${value}`}>{statusText(value, t)}</span> }
type Editor = { kind: 'create' | 'edit' | 'assign'; base?: Equipment; draft: EquipmentDraft }
type Modal = 'auth' | 'editor' | 'label' | 'settings' | null

export function EquipmentWorkspace({ id, session, state, navigate, onSessionChanged, onSessionExpired, onLogout, bootstrapToken }: { id?: string; session: Session; state: PreferencesState; navigate: (path: string) => void; onSessionChanged: (session: Session) => void; onSessionExpired: () => void; onLogout: () => Promise<void>; bootstrapToken?: string }) {
  const { t, preferences } = state
  const [items, setItems] = useState<Equipment[]>([])
  const [detail, setDetail] = useState<{ equipment: Equipment; history: EquipmentHistory[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [modal, setModal] = useState<Modal>(bootstrapToken && !session.user ? 'auth' : null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [resumeEditor, setResumeEditor] = useState(false)
  const [notice, setNotice] = useState<'saved' | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const item = detail?.equipment

  useEffect(() => {
    let active = true
    setLoading(true); setError(null); setDetail(null)
    const load = id ? api.equipmentDetails(id).then((value) => { if (active) setDetail(value) }) : api.equipment().then((value) => { if (active) setItems(value.equipment) })
    void load.catch((reason) => { if (active) setError(reason) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id, revision])
  useEffect(() => { heading.current?.focus(); setNotice(null) }, [id])
  function openEditor(kind: Editor['kind']) {
    if (kind !== 'create' && !item) return
    setEditor({ kind, base: kind === 'create' ? undefined : item, draft: kind === 'create' ? { ...emptyDraft } : { ...draftOf(item!), ...(kind === 'assign' ? { responsiblePerson: session.user?.name || '', status: 'in_use' as const } : {}) } })
    if (session.user) setModal('editor')
    else { setResumeEditor(true); setModal('auth') }
  }
  function signedIn(value: Session) {
    onSessionChanged(value)
    if (resumeEditor) {
      setEditor((current) => current?.kind === 'assign' && !current.draft.responsiblePerson ? { ...current, draft: { ...current.draft, responsiblePerson: value.user?.name || '' } } : current)
      setModal('editor')
    } else setModal(null)
    setResumeEditor(false)
  }
  const filtered = items.filter((entry) => (!status || entry.status === status) && [entry.name, entry.code, entry.category, entry.model, entry.serialNumber, entry.responsiblePerson, entry.location].some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  const close = () => { setModal(null); setResumeEditor(false) }
  return <>
    <div className="workspace-shell equipment-workspace" inert={Boolean(modal)}>
      <aside className="sidebar">
        <div className="brand"><span><Activity size={24} /></span><div><strong>RackTop</strong><small>{t('团队工作台', 'Team workspace')}</small></div></div>
        <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}><button onClick={() => navigate('/')}><LayoutGrid size={18} />{t('资源看板', 'Resource board')}</button><button className="is-active" aria-current="page" onClick={() => navigate('/equipment')}><Package size={18} />{t('设备管理', 'Equipment')}</button></nav>
        <div className="sidebar-bottom"><div className="sidebar-note"><QrCode size={17} /><p>{t('贴上设备标签，扫码查看负责人、位置与登记记录。', 'Scan a device label to see its owner, location and registration history.')}</p></div><button className="sidebar-settings" onClick={() => setModal('settings')}><Settings size={17} />{t('设置', 'Settings')}</button><div className="profile"><span className="profile-avatar"><UserRound size={19} /></span><div><strong>{session.user?.name || t('访客', 'Guest')}</strong><small>{session.user ? t('团队成员', 'Team member') : t('扫码即可查看', 'Scan to view')}</small></div>{session.user ? <button className="icon-button" aria-label={t('退出登录', 'Sign out')} disabled={loggingOut} onClick={async () => { setLoggingOut(true); try { await onLogout() } catch (reason) { setError(reason) } finally { setLoggingOut(false) } }}><LogOut size={16} /></button> : <button onClick={() => setModal('auth')}>{t('登录', 'Sign in')}</button>}</div></div>
      </aside>
      <main className="main-workspace">
        <header className="page-header"><div><p>{t('团队设备台账', 'Team equipment inventory')}</p><h1 ref={heading} tabIndex={-1}>{id ? t('设备详情', 'Device details') : t('设备管理', 'Equipment')}</h1><span>{t('记录设备在哪里、由谁负责。', 'Know where your equipment is and who is responsible.')}</span></div><div className="header-actions"><button disabled={loading} aria-label={t('刷新设备', 'Refresh equipment')} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} />{t('刷新', 'Refresh')}</button>{!id && <button className="primary" onClick={() => openEditor('create')}><Plus size={17} />{t('新增设备', 'Add device')}</button>}</div></header>
        <div className="page-content">
          {id && <button className="equipment-back" onClick={() => navigate('/equipment')}><ArrowLeft size={16} />{t('全部设备', 'All equipment')}</button>}
          {Boolean(error) && <div className="error" role="alert">{error instanceof ApiError && error.status === 404 ? t('未找到这台设备，请核对标签链接或返回设备列表。', 'Device not found. Check the label link or return to the equipment list.') : errorText(error, t)}<button onClick={() => setRevision((value) => value + 1)}>{t('重新读取', 'Try again')}</button></div>}
          {notice && <div className="notice" role="status"><Check size={17} />{t('设备登记已保存。', 'Device registration saved.')}</div>}
          {loading ? <p role="status" className="loading-inline"><RefreshCw size={17} />{t('正在读取设备…', 'Loading equipment…')}</p> : id ? item && <>
            <section className="equipment-detail-card"><div className="equipment-detail-heading"><div><span className="equipment-code">{item.code}</span><h2>{item.name}</h2><p>{[item.category, item.model].filter(Boolean).join(' · ') || t('尚未填写类别和型号', 'Category and model not recorded')}</p></div><Status value={item.status} t={t} /></div><div className="equipment-detail-actions"><button className="primary" onClick={() => openEditor('assign')}><ClipboardList size={17} />{t('领用登记', 'Register use')}</button><button onClick={() => openEditor('edit')}><Pencil size={16} />{t('编辑信息', 'Edit details')}</button><button onClick={() => setModal('label')}><QrCode size={17} />{t('设备标签', 'Device label')}</button></div><dl className="equipment-facts">{(['responsiblePerson', 'location', 'serialNumber', 'category', 'model'] as const).map((field) => <div key={field}><dt>{fieldText(field, t)}</dt><dd>{item[field] || t('未填写', 'Not recorded')}</dd></div>)}<div><dt>{t('最近更新', 'Last updated')}</dt><dd>{formatTime(item.updatedAt, preferences.locale)}</dd></div></dl>{item.notes && <div className="equipment-notes"><h3>{t('备注', 'Notes')}</h3><p>{item.notes}</p></div>}{!session.user && <p className="field-help">{t('查看无需登录。登录后即可登记领用或修改设备信息。', 'No sign-in is needed to view. Sign in to register use or update this device.')}</p>}</section>
            <section className="equipment-history"><div className="equipment-section-title"><h2>{t('登记记录', 'Registration history')}</h2><span>{t('最近 30 条', 'Latest 30 entries')}</span></div>{detail.history.length ? <ol>{detail.history.map((entry, index) => <li key={`${entry.at}-${index}`}><div><strong>{entry.actorName}</strong><span>{entry.action === 'created' ? t('新增设备', 'Added device') : t('更新登记', 'Updated registration')}</span><time dateTime={entry.at}>{formatTime(entry.at, preferences.locale)}</time></div><ul>{entry.changes.filter((change) => change.oldValue !== null || change.newValue !== '').map((change) => <li key={change.field}><span>{fieldText(change.field, t)}</span><span>{change.oldValue === null ? '' : `${change.field === 'status' ? statusText(change.oldValue, t) : change.oldValue || t('未填写', 'Not recorded')} → `}{change.field === 'status' ? statusText(change.newValue, t) : change.newValue || t('未填写', 'Not recorded')}</span></li>)}</ul></li>)}</ol> : <p className="muted">{t('暂无登记记录。', 'No registration history yet.')}</p>}</section>
          </> : !error && <>
            <form className="equipment-filters" onSubmit={(event) => event.preventDefault()}><label className="equipment-search"><span>{t('搜索设备', 'Search equipment')}</span><div><Search size={18} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('名称、编号、负责人或位置', 'Name, code, person or location')} /></div></label><label>{t('状态', 'Status')}<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t('全部状态', 'All statuses')}</option>{statuses.map((value) => <option key={value} value={value}>{statusText(value, t)}</option>)}</select></label></form>
            <div className="equipment-section-title"><h2>{t('设备目录', 'Equipment catalog')}</h2><span>{filtered.length} / {items.length} {t('台设备', 'devices')}</span></div>
            {filtered.length ? <div className="equipment-list">{filtered.map((entry) => <a className="equipment-row" href={`/equipment/${encodeURIComponent(entry.id)}`} key={entry.id} onClick={(event) => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(`/equipment/${encodeURIComponent(entry.id)}`) } }}><span className="resource-icon"><Package size={21} /></span><div className="equipment-row-name"><small>{entry.code}</small><h3>{entry.name}</h3><span>{entry.model || entry.category || t('型号未填写', 'Model not recorded')}</span></div><div className="equipment-row-meta"><span><UserRound size={14} />{entry.responsiblePerson || t('负责人未填写', 'No responsible person')}</span><span><MapPin size={14} />{entry.location || t('位置未填写', 'No location')}</span></div><Status value={entry.status} t={t} /><ChevronRight size={17} /></a>)}</div> : <div className="empty-state"><span><Package size={28} /></span><h3>{items.length ? t('没有匹配的设备', 'No matching equipment') : t('还没有设备', 'No equipment yet')}</h3><p>{items.length ? t('试试其他关键词或状态。', 'Try another search or status.') : t('新增第一台设备，生成可贴在设备上的二维码标签。', 'Add your first device and create its QR label.')}</p><button onClick={() => items.length ? (setSearch(''), setStatus('')) : openEditor('create')}>{items.length ? t('清除筛选', 'Clear filters') : t('新增设备', 'Add device')}</button></div>}
          </>}
        </div>
      </main>
    </div>
    {modal === 'auth' && <AuthDialog session={session} bootstrapToken={bootstrapToken} t={t} onClose={close} onSignedIn={signedIn} />}
    {modal === 'settings' && <SettingsDialog session={session} state={state} onClose={close} onSessionChanged={onSessionChanged} />}
    {modal === 'editor' && editor && <EquipmentEditor editor={editor} setEditor={setEditor} t={t} onClose={close} onAuthRequired={() => { setResumeEditor(true); setModal('auth'); onSessionExpired() }} onSaved={(saved) => { setModal(null); setEditor(null); if (id !== saved.id) navigate(`/equipment/${encodeURIComponent(saved.id)}`); else setRevision((value) => value + 1); setNotice('saved') }} />}
    {modal === 'label' && item && <EquipmentLabel equipment={item} t={t} onClose={close} />}
  </>
}

function EquipmentEditor({ editor, setEditor, t, onClose, onSaved, onAuthRequired }: { editor: Editor; setEditor: React.Dispatch<React.SetStateAction<Editor | null>>; t: Translate; onClose: () => void; onSaved: (equipment: Equipment) => void; onAuthRequired: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [refreshed, setRefreshed] = useState(false)
  const conflict = error instanceof ApiError && error.code === 'VERSION_CONFLICT'
  const visibleFields = editor.kind === 'assign' ? ['responsiblePerson', 'location'] as const : ['name', 'category', 'model', 'serialNumber', 'responsiblePerson', 'location'] as const
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return
    if (!editor.draft.name.trim()) { setError(new Error(t('请输入设备名称。', 'Enter a device name.'))); return }
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
  return <Dialog title={editor.kind === 'create' ? t('新增设备', 'Add device') : editor.kind === 'assign' ? t('领用登记', 'Register use') : t('编辑设备', 'Edit device')} subtitle={editor.base ? `${editor.base.code} · ${editor.base.name}` : t('只需填写设备名称，其他信息可稍后补充。', 'Only a device name is required. Add other details later.')} t={t} onClose={onClose} busy={busy}>
    <form onSubmit={(event) => void save(event)}><div className="dialog-body"><div className="field-pair">{visibleFields.map((field) => <label key={field}>{fieldText(field, t)}{field === 'name' ? t('（必填）', ' (required)') : ''}<input name={field} value={editor.draft[field]} maxLength={limits[field]} required={field === 'name'} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} /></label>)}</div><label>{t('状态', 'Status')}<select name="status" value={editor.draft.status} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, status: event.target.value as EquipmentStatus } })}>{statuses.map((value) => <option key={value} value={value}>{statusText(value, t)}</option>)}</select></label>{editor.kind !== 'assign' && <label>{t('备注', 'Notes')}<textarea name="notes" maxLength={limits.notes} value={editor.draft.notes} disabled={busy} onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, notes: event.target.value } })} /></label>}{Boolean(error) && <div className="error" role="alert">{conflict ? t('设备已被其他人更新。你的输入已保留，请读取最新版本，核对后再保存。', 'Someone updated this device. Your input is preserved. Load the latest version, review it, then save again.') : errorText(error, t)}{conflict && <button type="button" disabled={busy} onClick={() => void refreshVersion()}>{t('读取最新版本', 'Load latest version')}</button>}</div>}{refreshed && <div className="callout" role="status">{t('已读取最新版本并保留你的修改，请核对后保存。最新负责人：', 'Latest version loaded with your changes preserved. Review before saving. Latest responsible person: ')}{editor.base?.responsiblePerson || t('未填写', 'Not recorded')}{t('；位置：', '; location: ')}{editor.base?.location || t('未填写', 'Not recorded')}</div>}</div><footer><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button><button type="submit" className="primary" disabled={busy || conflict}>{busy ? t('保存中…', 'Saving…') : t('保存登记', 'Save registration')}</button></footer></form>
  </Dialog>
}

export function EquipmentLabel({ equipment, t, onClose }: { equipment: Equipment; t: Translate; onClose: () => void }) {
  const [image, setImage] = useState('')
  const [error, setError] = useState(false)
  const url = equipmentUrl(equipment.id)
  useEffect(() => {
    let active = true
    void QRCode.toDataURL(url, { width: 640, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then((value) => { if (active) setImage(value) }).catch(() => { if (active) setError(true) })
    document.body.classList.add('equipment-label-open')
    return () => { active = false; document.body.classList.remove('equipment-label-open') }
  }, [url])
  return <Dialog compact title={t('设备标签', 'Device label')} t={t} onClose={onClose}><div className="dialog-body"><div className="equipment-print-label"><strong>{equipment.name}</strong><span>{equipment.code}</span>{equipment.model && <small>{equipment.model}</small>}{image ? <img width="240" height="240" src={image} alt={t('扫码查看此设备', 'Scan to view this device')} /> : <p role={error ? 'alert' : 'status'}>{error ? t('二维码生成失败，请关闭后重试。', 'Could not generate the QR code. Close and try again.') : t('正在生成二维码…', 'Generating QR code…')}</p>}<small>{t('扫码查看设备信息', 'Scan for device details')}</small></div><a className="equipment-label-url" href={url}>{url}</a><p className="field-help">{t('设备信息更新后仍使用这张标签。扫码查看无需登录。', 'This label keeps working after details change. Viewing does not require sign-in.')}</p></div><footer>{image && <a className="button" href={image} download={`${equipment.code}-QR.png`}><Download size={16} />{t('下载二维码', 'Download QR')}</a>}<button className="primary" disabled={!image} onClick={() => window.print()}><Printer size={16} />{t('打印标签', 'Print label')}</button></footer></Dialog>
}
