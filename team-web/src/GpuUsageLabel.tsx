import { currentGpuUsage } from './resource-usage'
import type { Resource, Translate } from './types'

export function GpuUsageLabel({ resource, index, now, t }: { resource: Resource; index: number; now: number; t: Translate }) {
  const usage = currentGpuUsage(resource, index, now)
  return <span className={`gpu-current-usage usage-text--${usage.state}`}>
    <span>{usage.state === 'busy' ? t('当前被占用', 'Occupied now') : usage.state === 'free' ? t('当前空闲', 'Idle now') : t('当前状态未知', 'Usage unknown')}</span>
    {usage.state === 'busy' && <small>{usage.users.length ? usage.users.join('、') : t('匿名用户', 'Anonymous user')}</small>}
  </span>
}
