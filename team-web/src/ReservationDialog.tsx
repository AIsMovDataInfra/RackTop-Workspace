import { useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Clock3 } from 'lucide-react'
import { api, ApiError } from './api'
import { InventoryStatus } from './InventoryStatus'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { beijingInput, bookingPayload, formatTime, inputToIso } from './time'
import type { Locale, Reservation, Resource, Translate } from './types'

export function ConflictNotice({ error, locale, t }: { error: unknown; locale: Locale; t: Translate }) {
  if (!error) return null
  const apiError = error instanceof ApiError ? error : null
  return <div className="error" role="alert"><strong><AlertCircle size={17} />{apiError?.status === 409 ? t('预约未保存，请调整后重试', 'Not saved. Adjust the booking and retry') : t('操作未完成', 'Could not complete the request')}</strong><span>{errorText(error, t)}</span>{apiError?.conflicts.length ? <ul className="conflict-list">{apiError.conflicts.map((conflict) => <li key={conflict.id}><strong>{conflict.ownerName} · {conflict.scope === 'machine' ? t('整机', 'Whole machine') : `GPU ${conflict.gpuIndices.join(', ')}`}</strong><span>{formatTime(conflict.startAt, locale)} → {formatTime(conflict.endAt, locale)}</span><span>{conflict.purpose}</span></li>)}</ul> : null}{apiError?.status === 409 && <small>{t('输入已保留。资源可能已被其他成员预约，或此预约已在别处更新；请刷新查看最新排期。', 'Your input is preserved. Another member may have booked the slot, or this booking changed elsewhere. Refresh to see the latest schedule.')}</small>}</div>
}

export function ReservationDialog({ resource, start, end, initialGpu, t, locale, onClose, onSaved }: { resource: Resource; start: string; end: string; initialGpu?: number; t: Translate; locale: Locale; onClose: () => void; onSaved: () => void }) {
  const devices = resource.gpus?.length ? resource.gpus : Array.from({ length: resource.gpuCount }, (_, index) => ({ index, id: '', model: '', memoryTotalMb: 0 }))
  const request = useRef<{ payload: string; id: string } | null>(null)
  const [scope, setScope] = useState<'machine' | 'gpus'>(initialGpu === undefined ? 'machine' : 'gpus')
  const [gpuIndices, setGpuIndices] = useState<number[]>(initialGpu === undefined ? [] : [initialGpu])
  const [startInput, setStartInput] = useState(start)
  const [endInput, setEndInput] = useState(end)
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    try {
      const payload = bookingPayload({ resourceId: resource.id, scope, gpuIndices, start: startInput, end: endInput, purpose })
      if (resource.inventoryState === 'conflict') throw new Error(t('GPU 清单待核验，请联系管理员后再预约。', 'The GPU inventory needs review. Contact your administrator before booking.'))
      if (resource.inventoryVersion) { payload.inventoryVersion = resource.inventoryVersion; payload.gpuIds = scope === 'machine' ? [] : devices.filter((gpu) => gpuIndices.includes(gpu.index)).map((gpu) => gpu.id) }
      const signature = JSON.stringify(payload)
      if (request.current?.payload !== signature) request.current = { payload: signature, id: crypto.randomUUID() }
      payload.requestId = request.current.id
      setBusy(true)
      await api.reserve(payload)
      onSaved()
    } catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  return <Dialog title={t('新建预约', 'New reservation')} subtitle={`${resource.cluster} · ${resource.name}`} onClose={onClose} busy={busy} t={t}><form onSubmit={(event) => void submit(event)}><div className="dialog-body"><div className="resource-summary"><span className="resource-icon"><Clock3 size={21} /></span><div><strong>{resource.name}</strong><p>{resource.gpuCount ? `${resource.gpuCount} × ${resource.gpuModel || 'GPU'}` : t('CPU 服务器 · 整机预约', 'CPU server · Whole machine')}</p></div></div><InventoryStatus resource={resource} locale={locale} t={t} /><fieldset disabled={busy || resource.inventoryState === 'conflict'}><legend>{t('预约范围', 'Scope')}</legend><div className="scope-options"><label><input type="radio" name="scope" value="machine" checked={scope === 'machine'} onChange={() => setScope('machine')} />{t('整台服务器', 'Whole machine')}</label>{resource.gpuCount > 0 && <label><input type="radio" name="scope" value="gpus" checked={scope === 'gpus'} onChange={() => setScope('gpus')} />{t('指定 GPU', 'Select GPUs')}</label>}</div>{scope === 'gpus' && <div className="gpu-picker">{devices.map(({ index, id, model, memoryTotalMb }) => <label key={id || index} className={gpuIndices.includes(index) ? 'is-selected' : ''}><input type="checkbox" checked={gpuIndices.includes(index)} onChange={(event) => setGpuIndices((previous) => event.target.checked ? [...previous, index] : previous.filter((gpu) => gpu !== index))} /><span>GPU {index}{model && <small>{model}{memoryTotalMb > 0 ? ` · ${(memoryTotalMb / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} GiB` : ''}</small>}</span></label>)}</div>}</fieldset><div className="field-pair"><label>{t('开始时间', 'Start time')}<input aria-label={t('开始时间', 'Start time')} type="datetime-local" required value={startInput} disabled={busy} onChange={(event) => setStartInput(event.target.value)} /></label><label>{t('结束时间', 'End time')}<input aria-label={t('结束时间', 'End time')} type="datetime-local" required value={endInput} disabled={busy} onChange={(event) => setEndInput(event.target.value)} /></label></div><p className="field-help">{t('北京时间（UTC+8）· 单次最长 7 天，可预约未来 90 天', 'Beijing time (UTC+8) · Up to 7 days per booking, within 90 days')}</p><label>{t('预约用途', 'Purpose')}<textarea aria-label={t('预约用途', 'Purpose')} required rows={3} maxLength={500} placeholder={t('例如：模型训练、实验验证', 'For example: model training or evaluation')} value={purpose} disabled={busy} onChange={(event) => setPurpose(event.target.value)} /></label><ConflictNotice error={error} t={t} locale={locale} /><p className="field-help">{t('提交时会检查最新排期。预约不会启动任务，也不代表 GPU 实际使用状态。', 'The latest schedule is checked on submission. A reservation does not start a job or indicate live GPU usage.')}</p></div><footer><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button><button className="primary" type="submit" disabled={busy || resource.inventoryState === 'conflict'}>{busy ? t('正在提交…', 'Submitting…') : t('确认预约', 'Reserve')}<ArrowRight size={16} /></button></footer></form></Dialog>
}

export function RenewalDialog({ reservation, resource, onClose, onSaved, t, locale }: { reservation: Reservation; resource?: Resource; onClose: () => void; onSaved: () => void; t: Translate; locale: Locale }) {
  const [end, setEnd] = useState(beijingInput(Date.parse(reservation.endAt) + 3_600_000))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  return <Dialog compact title={t('延长预约', 'Extend reservation')} subtitle={reservation.resourceName} onClose={onClose} busy={busy} t={t}><form onSubmit={async (event) => { event.preventDefault(); if (busy) return; setError(null); try { const endAt = inputToIso(end); if (Date.parse(endAt) <= Date.parse(reservation.endAt)) throw new Error(t('新结束时间须晚于当前结束时间。', 'The new end must be later than the current end.')); setBusy(true); if (resource?.inventoryState === 'conflict') throw new Error(t('GPU 清单待核验，请联系管理员。', 'The GPU inventory needs review. Contact your administrator.')); if (resource) await api.renew(reservation, endAt, resource.inventoryVersion); else await api.renew(reservation, endAt); onSaved() } catch (reason) { setError(reason) } finally { setBusy(false) } }}><div className="dialog-body"><p className="muted">{t('当前时段', 'Current time slot')}<br /><strong>{formatTime(reservation.startAt, locale)} → {formatTime(reservation.endAt, locale)}</strong></p><label>{t('新的结束时间', 'New end time')}<input type="datetime-local" required aria-label={t('新的结束时间', 'New end time')} value={end} disabled={busy} onChange={(event) => setEnd(event.target.value)} /></label><p className="field-help">{t('北京时间（UTC+8）。开始时间及预约资源保持不变，续约会重新检查冲突。', 'Beijing time (UTC+8). Start and resources stay unchanged; conflicts are checked again.')}</p><ConflictNotice error={error} t={t} locale={locale} /></div><footer><button type="button" disabled={busy} onClick={onClose}>{t('返回', 'Back')}</button><button type="submit" className="primary" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('确认续约', 'Extend reservation')}</button></footer></form></Dialog>
}

export function ReservationActionDialog({ reservation, action, onClose, onSaved, locale, t }: { reservation: Reservation; action: 'cancel' | 'finish'; onClose: () => void; onSaved: () => void; locale: Locale; t: Translate }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const title = action === 'cancel' ? t('取消预约', 'Cancel reservation') : t('提前结束预约', 'Finish reservation early')
  return <Dialog compact title={title} onClose={onClose} busy={busy} t={t}><div className="dialog-body"><p><strong>{reservation.resourceName}</strong><br /><span className="muted">{formatTime(reservation.startAt, locale)} → {formatTime(reservation.endAt, locale)}</span></p><p>{action === 'cancel' ? t('取消后将释放预约时段，记录仍会保留。确认取消此预约？', 'This releases the booked time and keeps its history. Cancel this reservation?') : t('请先确认任务已经停止。提前结束会释放后续时段，但不会停止服务器上的进程。', 'Confirm your job has stopped. Finishing releases the remaining time; it does not stop server processes.')}</p><ConflictNotice error={error} t={t} locale={locale} /></div><footer><button disabled={busy} onClick={onClose}>{t('返回', 'Back')}</button><button className="danger" disabled={busy} onClick={async () => { if (busy) return; setBusy(true); setError(null); try { await api[action](reservation); onSaved() } catch (reason) { setError(reason) } finally { setBusy(false) } }}>{busy ? t('处理中…', 'Working…') : action === 'cancel' ? t('确认取消', 'Confirm cancellation') : t('确认结束', 'Confirm finish')}</button></footer></Dialog>
}
