import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { workspaceErrorText as errorText } from './workspace-errors'
import { formatTime } from './time'
import { EQUIPMENT_CATEGORIES } from './EquipmentWorkspace'
import { WorkModuleFrame } from './WorkModuleFrame'
import { workspaceApi } from './workspace-api'
import type { Equipment, Translate } from './types'
import type { EquipmentRequest, RequestStatus, WorkAudit, WorkModuleProps } from './workspace-types'

function statusText(status: RequestStatus, t: Translate) { return ({ pending: t('待处理', 'Pending'), approved: t('已批准', 'Approved'), rejected: t('已拒绝', 'Rejected'), collected: t('已领取', 'Collected') })[status] }

export function RequestWorkspace(props: WorkModuleProps) {
  const { session, state, onSessionExpired } = props
  const { t, preferences } = state
  const user = session.user
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [requests, setRequests] = useState<EquipmentRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [formError, setFormError] = useState<unknown>(null)
  const [category, setCategory] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [purpose, setPurpose] = useState('')
  const [equipmentId, setEquipmentId] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState<EquipmentRequest | null>(null)
  const [history, setHistory] = useState<WorkAudit[]>([])
  const [comment, setComment] = useState('')
  const generation = useRef(0)
  const conflict = formError instanceof ApiError && formError.status === 409

  function denied(reason: unknown) {
    if (!(reason instanceof ApiError) || ![401, 403].includes(reason.status)) return false
    generation.current++; setRequests([]); setEquipment([]); setDetail(null); setHistory([]); setComment(''); setPurpose(''); setLoading(false); setError(reason)
    if (reason.status === 401) onSessionExpired()
    return true
  }
  async function load() {
    if (!user) return
    const request = ++generation.current
    setLoading(true); setError(null)
    try {
      const [catalog, result] = await Promise.all([api.equipment(), user.isSuperAdmin ? workspaceApi.requests() : Promise.resolve({ requests: [] })])
      if (request !== generation.current) return
      setEquipment(catalog.equipment.filter(item => item.company === user.company && item.status === 'available' && !item.currentUser))
      setRequests(result.requests)
    } catch (reason) { if (request === generation.current && !denied(reason)) { setEquipment([]); setRequests([]); setError(reason) } }
    finally { if (request === generation.current) setLoading(false) }
  }
  useEffect(() => {
    setEquipment([]); setRequests([]); setDetail(null); setHistory([]); setComment(''); setPurpose(''); setSubmitted(false); setEquipmentId('')
    if (user) void load()
    return () => { generation.current++ }
  }, [user?.id, user?.company, user?.isSuperAdmin])
  function chooseEquipment(id: string) {
    setEquipmentId(id)
    const item = equipment.find(value => value.id === id)
    if (item) { setCategory(item.category); setQuantity(1) }
  }
  async function submit() {
    if (busy || !user || !user.company) return
    setBusy(true); setFormError(null)
    const request = generation.current
    try {
      await workspaceApi.createRequest({ category, quantity, purpose, equipmentId: equipmentId || null })
      if (request !== generation.current) return
      setSubmitted(true); setCategory(''); setQuantity(1); setPurpose(''); setEquipmentId('')
      if (user.isSuperAdmin) { const value = await workspaceApi.requests(); if (request === generation.current) setRequests(value.requests) }
    } catch (reason) { if (request === generation.current && !denied(reason)) setFormError(reason) }
    finally { setBusy(false) }
  }
  async function openRequest(id: string) {
    if (!user?.isSuperAdmin) return
    const request = generation.current
    setBusy(true); setFormError(null)
    try {
      const value = await workspaceApi.deviceRequest(id)
      if (request === generation.current) { setDetail(value.request); setHistory(value.history); setComment(value.request.decisionComment) }
    } catch (reason) { if (request === generation.current && !denied(reason)) { setError(reason); if (reason instanceof ApiError && reason.status === 404) setDetail(null) } }
    finally { setBusy(false) }
  }
  async function decide(status: Exclude<RequestStatus, 'pending'>) {
    if (!detail || busy || !user?.isSuperAdmin) return
    const request = generation.current
    setBusy(true); setFormError(null)
    try {
      const value = await workspaceApi.updateRequest(detail.id, detail.version, status, comment)
      if (request !== generation.current) return
      setDetail(value.request); setRequests(old => old.map(item => item.id === value.request.id ? value.request : item)); setComment(value.request.decisionComment)
      const latest = await workspaceApi.deviceRequest(value.request.id); if (request === generation.current) setHistory(latest.history)
    } catch (reason) { if (request === generation.current && !denied(reason)) setFormError(reason) }
    finally { setBusy(false) }
  }
  if (!user) return null
  const shown = requests.filter(item => !filter || item.status === filter)
  return <>
    <WorkModuleFrame {...props} section="requests" title={t('设备申请与领取', 'Device requests')} subtitle={t('填写设备需求，交由超级管理员审批与登记领取。', 'Submit equipment needs for the super administrator to review and record collection.')} modal={Boolean(detail)} actions={<button disabled={loading || busy} onClick={() => void load()}><RefreshCw size={16}/>{t('刷新', 'Refresh')}</button>}>
      {Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}
      {submitted ? <section className="work-success" role="status"><Check size={24}/><h2>{t('申请已提交', 'Request submitted')}</h2><p>{t('超级管理员将查看申请并处理。此页面不提供员工申请历史。', 'The super administrator will review your request. Employee request history is not available on this page.')}</p><button onClick={() => { setSubmitted(false); setFormError(null) }}>{t('继续提交申请', 'Submit another request')}</button></section> : user.company ? <form className="work-record work-request-form" onSubmit={event => { event.preventDefault(); void submit() }}>
        <h2>{t('新申请', 'New request')}</h2><p>{user.name} · {user.company}</p>
        <label>{t('关联现有设备（可选）', 'Existing equipment (optional)')}<select name="equipmentId" disabled={busy || loading} value={equipmentId} onChange={event => chooseEquipment(event.target.value)}><option value="">{t('不关联设备，提交设备需求', 'Submit a need without linking equipment')}</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.serialNumber} · {item.name}</option>)}</select><span className="field-help">{t('只显示本公司当前可领取的设备。', 'Only available equipment in your company is listed.')}</span></label>
        <div className="field-pair"><label>{t('设备类别', 'Equipment category')}<select name="category" required disabled={busy || Boolean(equipmentId)} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t('请选择类别', 'Choose a category')}</option>{EQUIPMENT_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select></label><label>{t('数量', 'Quantity')}<input name="quantity" type="number" min={1} max={999} step={1} required disabled={busy || Boolean(equipmentId)} value={quantity} onChange={event => setQuantity(Number(event.target.value))}/></label></div>
        <label>{t('用途与申请内容', 'Purpose and request details')}<textarea name="purpose" required maxLength={4000} disabled={busy} value={purpose} onChange={event => setPurpose(event.target.value)}/></label>
        {Boolean(formError) && !detail && <div className="error" role="alert">{errorText(formError, t)}</div>}
        <p className="field-help">{t('提交后由超级管理员查看和处理。申请本身不会预留或领用设备。', 'Only the super administrator can view and process submitted requests. Submitting does not reserve or collect equipment.')}</p>
        <div className="work-inline-actions"><button type="submit" className="primary" disabled={busy || loading}>{busy ? t('正在提交…', 'Submitting…') : t('提交申请', 'Submit request')}</button></div>
      </form> : <div className="callout">{t('查看申请不要求超级管理员有公司；如需提交自己的申请，请先在成员管理中给自己分配公司。', 'A super administrator can review requests without a company. Assign your own company in Members before submitting a request yourself.')}</div>}
      {user.isSuperAdmin && <section className="work-request-section" aria-label={t('全部设备申请', 'All equipment requests')}><h2>{t('申请处理', 'Review requests')}</h2><div className="work-filters"><label>{t('申请状态', 'Request status')}<select value={filter} onChange={event => setFilter(event.target.value)}><option value="">{t('全部状态', 'All statuses')}</option>{(['pending', 'approved', 'rejected', 'collected'] as const).map(value => <option key={value} value={value}>{statusText(value, t)}</option>)}</select></label></div>{loading ? <p role="status">{t('正在读取申请…', 'Loading requests…')}</p> : shown.length ? <div className="work-module-grid">{shown.map(item => <article className="work-record" key={item.id}><header><h2>{item.applicantName}</h2><span className={`work-module-status work-module-status--${item.status}`}>{statusText(item.status, t)}</span></header><p>{item.company} · {item.category} × {item.quantity}</p><small className="muted">{formatTime(item.createdAt, preferences.locale)}</small><button disabled={busy} onClick={() => void openRequest(item.id)}>{t('查看申请', 'View request')}</button></article>)}</div> : !error && <p className="muted">{t('暂无符合条件的申请。', 'No requests match this filter.')}</p>}</section>}
    </WorkModuleFrame>
    {detail && user.isSuperAdmin && <Dialog title={t('设备申请详情', 'Equipment request')} subtitle={`${detail.applicantName} · ${detail.company}`} onClose={() => { setDetail(null); setFormError(null) }} busy={busy} t={t}><div className="dialog-body">
      <dl className="work-request-facts"><div><dt>{t('类别与数量', 'Category and quantity')}</dt><dd>{detail.category} × {detail.quantity}</dd></div><div><dt>{t('状态', 'Status')}</dt><dd>{statusText(detail.status, t)}</dd></div><div><dt>{t('提交时间', 'Submitted')}</dt><dd>{formatTime(detail.createdAt, preferences.locale)}</dd></div>{detail.equipmentId && <div><dt>{t('关联设备', 'Linked equipment')}</dt><dd>{detail.equipmentSerial} · {detail.equipmentName}</dd></div>}</dl>
      <section><h3>{t('原始申请内容', 'Original request')}</h3><p className="work-prose">{detail.purpose}</p></section>
      {detail.status === 'collected' ? <p className="notice" role="status">{detail.equipmentUpdated ? t('领取已登记，关联设备台账已同步更新。', 'Collection recorded and the linked equipment inventory updated.') : t('领取状态已登记；本次仅登记领取状态，没有自动更新设备台账。', 'Collection status recorded. This entry did not automatically update equipment inventory.')}</p> : <label>{t('处理说明', 'Decision note')}<textarea name="decisionComment" maxLength={4000} value={comment} disabled={busy} onChange={event => setComment(event.target.value)}/></label>}
      {Boolean(formError) && <div className="error" role="alert">{conflict ? t('申请或设备状态已有变化。你的说明已保留，请读取最新记录后核对。', 'The request or equipment changed. Your note is retained. Load the latest record before continuing.') : errorText(formError, t)}{conflict && <button disabled={busy} onClick={() => void openRequest(detail.id)}>{t('载入最新记录（替换说明）', 'Load latest record (replace note)')}</button>}</div>}
      {history.length > 0 && <details><summary>{t('处理记录', 'Decision history')}</summary><ol className="work-report-history">{history.map((entry, index) => <li key={`${entry.at}-${index}`}><strong>{entry.actorName}</strong><span>{entry.action === 'request-created' ? t('提交申请', 'Submitted request') : t('处理申请', 'Processed request')}</span><time dateTime={entry.at}>{formatTime(entry.at, preferences.locale)}</time>{entry.action === 'request-decided' && <p>{statusText(entry.details.before as RequestStatus, t)} → {statusText(entry.details.after as RequestStatus, t)} · {String(entry.details.comment || '—')}</p>}</li>)}</ol></details>}
    </div><footer><button disabled={busy} onClick={() => setDetail(null)}>{t('关闭', 'Close')}</button>{detail.status !== 'collected' && <>{detail.status !== 'rejected' && <button className="danger" disabled={busy || conflict} onClick={() => void decide('rejected')}>{t('拒绝申请', 'Reject request')}</button>}{detail.status !== 'approved' ? <button className="primary" disabled={busy || conflict} onClick={() => void decide('approved')}>{t('批准申请', 'Approve request')}</button> : <button className="primary" disabled={busy || conflict} onClick={() => void decide('collected')}>{t('登记已领取', 'Record collection')}</button>}</>}</footer></Dialog>}
  </>
}
