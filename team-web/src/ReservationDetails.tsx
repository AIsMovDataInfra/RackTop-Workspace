import { useEffect, useState } from 'react'
import { ArrowRight, Clock3, RefreshCw, UserRound } from 'lucide-react'
import { api } from './api'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { formatTime, reservationStatus } from './time'
import type { Locale, Reservation, Translate, User } from './types'

export function ReservationDetails({ id, user, onClose, onAction, t, locale }: { id: string; user: User; onClose: () => void; onAction: (action: 'renew' | 'cancel' | 'finish', reservation: Reservation) => void; t: Translate; locale: Locale }) {
  const [reservation, setReservation] = useState<Reservation | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    void api.reservation(id).then((result) => { if (alive) setReservation(result.reservation) }).catch((reason) => { if (alive) setError(reason) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [id, revision])
  const active = reservation?.status === 'confirmed' && Date.parse(reservation.endAt) > Date.now()
  const editable = reservation && (reservation.ownerId === user.id || user.role === 'admin')
  const ongoing = reservation && Date.parse(reservation.startAt) <= Date.now()
  return <Dialog title={t('预约详情', 'Reservation details')} subtitle={t('北京时间 · UTC+8', 'Beijing time · UTC+8')} onClose={onClose} t={t}><div className="dialog-body">{loading ? <p className="loading-inline" role="status"><RefreshCw size={17} />{t('正在读取预约…', 'Loading reservation…')}</p> : error ? <div className="error" role="alert">{errorText(error, t)}<button onClick={() => setRevision((value) => value + 1)}>{t('重试', 'Retry')}</button></div> : reservation && <><div className="detail-title"><div><p className="field-help">{reservation.cluster}</p><h3>{reservation.resourceName}</h3></div><span className="status-label">{reservationStatus(reservation, t)}</span></div><p className="reservation-time"><UserRound size={17} />{reservation.ownerName}</p><p className="reservation-time"><Clock3 size={17} />{formatTime(reservation.startAt, locale)}<ArrowRight size={14} />{formatTime(reservation.endAt, locale)}</p><div className="reservation-scope">{reservation.scope === 'machine' ? <span>{t('整机预约', 'Whole machine')}</span> : reservation.gpuIndices.map((index) => <span key={index}>GPU {index}</span>)}</div><p className="reservation-purpose">{reservation.purpose}</p>{reservation.plannedEndAt && <p className="field-help">{t('原计划结束', 'Originally planned to end')} {formatTime(reservation.plannedEndAt, locale)}</p>}<p className="field-help">{!editable ? t('这是团队成员的预约，仅预约人或管理员可以修改。', 'Only the owner or an administrator can change this reservation.') : t('预约不会启动或停止服务器任务。', 'A reservation does not start or stop server jobs.')}</p></>}</div><footer><button onClick={onClose}>{t('关闭', 'Close')}</button>{reservation && active && editable && !loading && !error ? <><button onClick={() => onAction('renew', reservation)}>{t('续约', 'Extend')}</button><button onClick={() => onAction(ongoing ? 'finish' : 'cancel', reservation)}>{ongoing ? t('提前结束', 'Finish early') : t('取消预约', 'Cancel booking')}</button></> : null}</footer></Dialog>
}
