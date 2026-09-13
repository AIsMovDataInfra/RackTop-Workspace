import { ChevronRight, Clock3, Cpu, Plus, Server } from 'lucide-react'
import { InventoryStatus } from './InventoryStatus'
import { ResourceUsageStatus } from './ResourceUsageStatus'
import { GpuUsageLabel } from './GpuUsageLabel'
import { formatTime } from './time'
import { currentGpuRestriction, currentGpuUsage } from './resource-usage'
import { useAvailabilityTime } from './use-availability-time'
import type { BookingStartMode, Locale, Reservation, Resource, Translate } from './types'

export function ResourceCard({ resource, reservations, start, end, mode = 'now', userId, locale, t, complete, onReserve, onDetails, linked, linkedRef }: { linked?: boolean; linkedRef?: React.RefObject<HTMLElement | null>; resource: Resource; reservations: Reservation[]; start: string; end: string; mode?: BookingStartMode; userId?: string; locale: Locale; t: Translate; complete: boolean; onReserve: (gpu?: number, mode?: BookingStartMode) => void; onDetails: (id: string) => void }) {
  const now = useAvailabilityTime(resource, start)
  const devices = resource.gpus?.length ? resource.gpus : Array.from({ length: resource.gpuCount || 1 }, (_, index) => ({ index, id: '', model: '', memoryTotalMb: 0 }))
  const slots = devices.map((gpu) => ({ ...gpu, bookings: reservations.filter((reservation) => reservation.scope === 'machine' || (gpu.id && reservation.gpuIds?.length ? reservation.gpuIds.includes(gpu.id) : reservation.gpuIndices.includes(gpu.index))) }))
  const conflict = resource.inventoryState === 'conflict'
  const booked = slots.filter((slot) => slot.bookings.length).length
  const restrictionStart = mode === 'now' ? new Date(now).toISOString() : start
  const machineRestricted = currentGpuRestriction(resource, restrictionStart, undefined, now)
  const headerMode = mode === 'scheduled' || machineRestricted ? 'scheduled' : 'now'
  const startMs = Date.parse(start), duration = Math.max(1, Date.parse(end) - startMs)
  return <article ref={linkedRef} className={`resource-card${linked ? ' resource-card--linked' : ''}`}>
    <header><span className="resource-icon"><Server size={20} /></span><div><span className="resource-cluster">{resource.cluster}</span><h3>{resource.name}</h3>{linked && <small className="linked-resource-caption">{t('来自 RackTop 的资源', 'Resource opened from RackTop')}</small>}</div><button disabled={conflict} onClick={() => onReserve(undefined, headerMode)}>{!complete ? t('核对资源与时段', 'Check resource and time') : headerMode === 'scheduled' ? t('预约未来时段', 'Book a future slot') : t('现在使用', 'Use now')}<Plus size={15} /></button></header>
    <div className="resource-hardware"><Cpu size={15} /><span>{resource.gpuCount ? `${resource.gpuModel || 'GPU'} × ${resource.gpuCount}` : t('CPU 服务器 · 整机', 'CPU server · Whole machine')}</span><strong className="muted">{conflict ? t('待核验', 'Needs review') : !complete ? t('排期待核验', 'Schedule unverified') : resource.gpuCount ? `${slots.length - booked}/${slots.length} ${t('此时段未预约', 'unreserved in slot')}` : booked ? t('此时段已预约', 'Reserved in this slot') : t('此时段未预约', 'Unreserved in this slot')}</strong></div>
    <InventoryStatus resource={resource} locale={locale} t={t} />
    <ResourceUsageStatus resource={resource} locale={locale} t={t} summaryOnly={resource.gpuCount > 0} />
    <h4 className="slot-usage-heading">{mode === 'now' ? t('当前使用 · 同时查看预约安排', 'Use now · Check bookings alongside usage') : t('当前占用 · 所选未来时段预约', 'Current usage · Bookings for the future slot')}</h4>
    {!complete && <p className="field-help" role="status">{t('排期尚未核验，不代表没有预约。请刷新重试。', 'The schedule has not been verified. It may contain bookings; refresh to retry.')}</p>}
    <div className={`gpu-tiles${resource.gpuCount === 0 ? ' gpu-tiles--cpu' : ''}`}>
      {slots.map(({ index, id, model, memoryTotalMb, bookings }) => {
        const restriction = currentGpuRestriction(resource, restrictionStart, resource.gpuCount ? [index] : undefined, now)
        const usage = currentGpuUsage(resource, index, now)
        const usageLabel = !resource.gpuCount ? t('实际使用请人工确认', 'Confirm actual use manually') : usage.state === 'busy' ? `${t('当前被占用', 'Occupied now')} · ${usage.users.length ? usage.users.join('、') : t('匿名用户', 'Anonymous user')}` : usage.state === 'free' ? t('当前空闲', 'Idle now') : t('当前状态未知', 'Usage unknown')
        const owners = [...new Set(bookings.map(booking => booking.ownerName))].join('、')
        const bookingLabel = !complete ? t('排期待核验', 'Schedule unverified') : bookings.length ? owners : t('此时段未预约', 'Unreserved in this slot')
        return <button disabled={conflict || !complete || Boolean(restriction) || bookings.length > 0} key={id || index} className={`gpu-tile${bookings.length ? ' gpu-tile--reserved' : ''}${userId && bookings.some((booking) => booking.ownerId === userId) ? ' gpu-tile--mine' : ''}`} aria-label={`${resource.name} ${resource.gpuCount ? `GPU ${index}` : t('整机', 'Whole machine')}: ${usageLabel}; ${bookingLabel}`} onClick={() => onReserve(resource.gpuCount ? index : undefined, mode)}>
          <span>{resource.gpuCount ? `GPU ${index}` : t('整台服务器', 'Whole machine')}</span><Cpu size={21} />
          {model && <span className="gpu-model" title={model}>{model}</span>}{memoryTotalMb > 0 && <small>{(memoryTotalMb / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} GiB</small>}
          {resource.gpuCount > 0 ? <GpuUsageLabel resource={resource} index={index} now={now} t={t} /> : <span className="gpu-current-usage">{t('实际使用请人工确认', 'Confirm actual use manually')}</span>}
          <strong className="gpu-booking-label" title={bookingLabel}>{conflict ? t('待核验', 'Needs review') : bookingLabel}</strong>
          <small>{mode === 'scheduled' ? t('仅预约未来时段', 'Future booking only') : restriction === 'GPU_BUSY' ? t('暂不能现在使用', 'Cannot use now') : restriction ? t('确认状态后再使用', 'Verify usage before starting') : t('提交时再次核验', 'Checked again on submission')}</small>
        </button>
      })}
    </div>
    {resource.notes && <p className="resource-notes">{resource.notes}</p>}
    <div className="resource-schedule"><div className="schedule-heading"><Clock3 size={14} /><span>{t('预约安排', 'Reservation schedule')}</span><small>{!complete ? t('待核验', 'Unverified') : reservations.length ? `${reservations.length} ${t('条预约', 'bookings')}` : t('暂无预约', 'No bookings')}</small></div>
      {reservations.slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).slice(0, 4).map((reservation) => {
        const offset = Math.max(0, (Date.parse(reservation.startAt) - startMs) / duration) * 100
        const width = (Math.min(Date.parse(reservation.endAt), Date.parse(end)) - Math.max(Date.parse(reservation.startAt), startMs)) / duration * 100
        return <div className="schedule-row" key={reservation.id}><div><strong>{reservation.ownerName}</strong><span>{reservation.scope === 'machine' ? t('整机', 'Whole machine') : `GPU ${reservation.gpuIndices.join(', ')}`}</span></div><div className="schedule-track" aria-hidden="true"><i style={{ left: `${offset}%`, width: `${Math.max(1, width)}%` }} /></div><div className="schedule-row-footer"><small>{formatTime(reservation.startAt, locale)} → {formatTime(reservation.endAt, locale)}</small><button type="button" className="schedule-details" aria-label={`${t('查看预约详情', 'View reservation details')}: ${reservation.ownerName}`} onClick={() => onDetails(reservation.id)}>{t('详情', 'Details')}<ChevronRight size={13} /></button></div></div>
      })}
      {reservations.length > 4 && <p className="field-help">{t('另有', 'Plus')} {reservations.length - 4} {t('条预约，请缩小时段查看。', 'more bookings. Narrow the time slot to see them.')}</p>}
    </div>
  </article>
}
