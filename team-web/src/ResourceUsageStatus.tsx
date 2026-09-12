import { useEffect, useState } from 'react'
import { currentResourceUsage, USAGE_FRESHNESS_MS } from './resource-usage'
import { formatTime } from './time'
import type { Locale, Resource, Translate, UsageState } from './types'
import './resource-usage.css'

function usageText(state: UsageState, t: Translate) {
  return state === 'busy' ? t('被占用', 'Occupied') : state === 'free' ? t('空闲', 'Idle') : t('未知', 'Unknown')
}
function systemUsers(users: string[]) { return [...new Set(users.map(user => user.trim()).filter(Boolean))] }

export function ResourceUsageStatus({ resource, locale, t }: { resource: Resource; locale: Locale; t: Translate }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    refresh()
    const observed = resource.usage?.observedAt ? Date.parse(resource.usage.observedAt) : NaN
    const remaining = observed + USAGE_FRESHNESS_MS - Date.now()
    const timer = Number.isFinite(remaining) && remaining > 0 && remaining <= USAGE_FRESHNESS_MS
      ? window.setTimeout(refresh, remaining + 1) : undefined
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { if (timer !== undefined) window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [resource.usage])
  const usage = currentResourceUsage(resource, now)
  const observed = usage.observedAt ? Date.parse(usage.observedAt) : NaN
  const stale = Number.isFinite(observed) && now - observed >= USAGE_FRESHNESS_MS
  const users = systemUsers(usage.gpus.filter(gpu => gpu.state === 'busy').flatMap(gpu => gpu.users))
  return <section className={`resource-usage resource-usage--${usage.state}`} aria-label={t('当前实际占用', 'Current actual usage')}>
    <div className="resource-usage-heading"><strong>{t('当前实际占用', 'Current actual usage')}</strong><span className="resource-usage-state">{usageText(usage.state, t)}</span></div>
    {usage.state === 'busy' && <p>{t('系统用户', 'System users')}：{users.length ? users.join('、') : t('匿名用户', 'Anonymous user')}</p>}
    {usage.gpus.length > 0 && <ul>{usage.gpus.map(gpu => <li key={gpu.id || gpu.uuid || gpu.index}>
      <span>GPU {gpu.index}</span><strong className={`usage-text--${gpu.state}`}>{usageText(gpu.state, t)}</strong>
      {gpu.state === 'busy' && <span>{systemUsers(gpu.users).length ? systemUsers(gpu.users).join('、') : t('匿名用户', 'Anonymous user')}</span>}
      <small>{gpu.utilization != null ? `${t('利用率', 'Utilization')} ${gpu.utilization.toLocaleString(locale, { maximumFractionDigits: 1 })}%` : ''}{gpu.utilization != null && gpu.memoryUsedMb != null ? ' · ' : ''}{gpu.memoryUsedMb != null ? `${t('已用显存', 'Memory used')} ${(gpu.memoryUsedMb / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} GiB` : ''}</small>
    </li>)}</ul>}
    <small>{stale ? t('采样已超过 90 秒，当前占用未知。', 'The sample is over 90 seconds old; current usage is unknown.') : usage.state === 'unknown' ? t('暂无有效占用信息，请先确认实际使用情况。', 'No reliable usage information. Confirm actual use before starting.') : `${t('采集于', 'Observed at')} ${formatTime(usage.observedAt!, locale, { second: '2-digit' })}`}</small>
    {usage.state === 'busy' && <p className="resource-usage-advice">{t('开始前请与当前使用人协调；仍可预约未来时段，预约不会自动停止现有任务。', 'Coordinate with current users before starting. Future slots remain bookable; reservations never stop running jobs.')}</p>}
  </section>
}
