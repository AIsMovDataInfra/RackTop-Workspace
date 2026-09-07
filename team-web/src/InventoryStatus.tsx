import { CircleAlert, Clock3 } from 'lucide-react'
import { formatTime } from './time'
import type { Locale, Resource, Translate } from './types'

export function InventoryStatus({ resource, locale, t }: { resource: Resource; locale: Locale; t: Translate }) {
  const synchronized = resource.inventoryState && resource.inventoryState !== 'manual'
  if (!synchronized) return <p className="inventory-status"><Clock3 size={13} />{t('手工登记 · 未连接硬件同步', 'Manual catalog · No hardware sync')}</p>
  const conflict = resource.inventoryState === 'conflict'
  return <div className={`inventory-status${conflict ? ' inventory-status--warning' : ''}`}><span><CircleAlert size={13} />{conflict ? t('GPU 清单待核验 · 暂停新预约', 'GPU inventory needs review · New bookings paused') : resource.status === 'online' ? t('最近同步在线', 'Online at last sync') : resource.status === 'offline' ? t('离线', 'Offline') : t('状态未知', 'Status unknown')}</span><small>{resource.lastSeenAt ? `${t('最后同步', 'Last sync')} ${formatTime(resource.lastSeenAt, locale)}` : t('尚无同步记录', 'No sync received')}{resource.observedAt && Math.abs(Date.parse(resource.observedAt) - Date.parse(resource.lastSeenAt || resource.observedAt)) > 60_000 ? ` · ${t('硬件采集', 'Hardware observed')} ${formatTime(resource.observedAt, locale)}` : ''}</small></div>
}
