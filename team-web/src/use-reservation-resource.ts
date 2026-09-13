import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api'
import type { Resource } from './types'

export function useReservationResource(id: string) {
  const [resource, setResource] = useState<Resource | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const active = useRef(false)
  const inFlight = useRef<Promise<Resource> | null>(null)
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current
    setLoading(true)
    const promise = api.resources().then(result => {
      if (!active.current) throw new Error('预约窗口已关闭 / The reservation dialog has closed')
      const current = result.resources.find(item => item.id === id && item.enabled)
      if (!current) throw new ApiError('此资源已停用或当前账号不再有预约权限 / This resource is disabled or no longer available to your account', 404, 'RESOURCE_UNAVAILABLE')
      setResource(current); setError(null)
      return current
    }).catch(reason => {
      if (active.current) { setResource(null); setError(reason) }
      throw reason
    }).finally(() => { inFlight.current = null; if (active.current) setLoading(false) })
    inFlight.current = promise
    return promise
  }, [id])
  useEffect(() => {
    active.current = true
    const poll = () => { if (!document.hidden) void refresh().catch(() => {}) }
    poll()
    const timer = window.setInterval(poll, 30_000)
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', poll)
    return () => { active.current = false; window.clearInterval(timer); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll) }
  }, [refresh])
  return { resource, loading, error, refresh }
}
