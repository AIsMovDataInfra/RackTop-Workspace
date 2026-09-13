import { useEffect, useState } from 'react'
import { USAGE_FRESHNESS_MS } from './resource-usage'
import type { Resource } from './types'

export function useAvailabilityTime(resource: Resource, start: string) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      const current = Date.now()
      setNow(current)
      const deadlines = [Date.parse(start), Date.parse(resource.usage?.observedAt || '') + USAGE_FRESHNESS_MS].filter(value => Number.isFinite(value) && value > current)
      if (deadlines.length) timer = window.setTimeout(refresh, Math.min(Math.min(...deadlines) - current + 1, 2_147_483_647))
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [resource.usage, start])
  return now
}
