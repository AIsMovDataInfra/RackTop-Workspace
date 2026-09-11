import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, acceptSession, ApiError, ACCOUNT_CHANGED_EVENT, request, SESSION_EXPIRED_EVENT } from './api'
import { errorText } from './errors'
import type { Session } from './types'

const accountSession: Session = { user: { id: 'member', name: '成员', role: 'member', company: 'A公司', companies: ['A公司', '西浦'] }, csrfToken: 'fixture', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
afterEach(() => { acceptSession({ ...accountSession, user: null, csrfToken: null }); vi.useRealTimers(); vi.unstubAllGlobals() })

function hangingFetch(signals: AbortSignal[]) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) { reject(new Error('missing request signal')); return }
    signals.push(signal)
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  }))
}

describe('authenticated reservation API', () => {
  it('scopes business reads, writes and photos to the active organization and sends no scope on the switch endpoint', async () => {
    acceptSession(accountSession)
    const switched = { ...accountSession, user: { ...accountSession.user!, company: '西浦' } }
    const fetch = vi.fn().mockImplementation(async (path: string) => new Response(JSON.stringify(path === '/api/auth/company' ? switched : {})))
    vi.stubGlobal('fetch', fetch)
    await api.resources(); await api.createMember({ name: '成员', password: 'test', companies: ['A公司'] }); await api.equipmentPhoto('photo', 1)
    for (const [, init] of fetch.mock.calls) expect((init as RequestInit).headers).toMatchObject({ 'X-RackTop-Company': encodeURIComponent('A公司') })
    await api.switchCompany({ company: '西浦' })
    expect(fetch.mock.calls[3][1].headers).not.toHaveProperty('X-RackTop-Company')
    expect(fetch.mock.calls[3][1].headers).toHaveProperty('X-CSRF-Token', 'fixture')
    await api.servers('西浦')
    expect(fetch.mock.lastCall![1].headers).toHaveProperty('X-RackTop-Company', encodeURIComponent('西浦'))
    acceptSession({ ...accountSession, user: { ...accountSession.user!, isSuperAdmin: true, company: null, companies: [] } })
    await api.members(); expect(fetch.mock.lastCall![1].headers).toHaveProperty('X-RackTop-Company', '')
  })

  it('does not let an earlier session read overwrite a completed organization switch', async () => {
    acceptSession(accountSession)
    let finish!: (value: Response) => void
    const switched = { ...accountSession, user: { ...accountSession.user!, company: '西浦' } }
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify(switched))).mockResolvedValueOnce(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const earlier = api.session(); await api.switchCompany({ company: '西浦' })
    finish(new Response(JSON.stringify(accountSession))); await earlier; await api.resources()
    expect(fetch.mock.lastCall![1].headers).toHaveProperty('X-RackTop-Company', encodeURIComponent('西浦'))
  })

  it('does not retry a previous organization request after the active session changes', async () => {
    acceptSession(accountSession)
    let reject!: (error: unknown) => void
    const changed = vi.fn(); window.addEventListener(ACCOUNT_CHANGED_EVENT, changed)
    const fetch = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.stubGlobal('fetch', fetch)
    try {
      const outcome = api.resources().catch(error => error)
      acceptSession({ ...accountSession, user: { ...accountSession.user!, company: '西浦' } })
      reject(new TypeError('connection reset'))
      expect(await outcome).toBeInstanceOf(TypeError)
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0][1].headers['X-RackTop-Company']).toBe(encodeURIComponent('A公司'))
      expect(changed).not.toHaveBeenCalled()
    } finally { window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed) }
  })

  it('refreshes the current session on a stale organization conflict without retrying', async () => {
    acceptSession(accountSession)
    const changed = vi.fn(); window.addEventListener(ACCOUNT_CHANGED_EVENT, changed)
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'COMPANY_CHANGED' } }), { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(api.resources()).rejects.toMatchObject({ status: 409, code: 'COMPANY_CHANGED' })
      expect(changed).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed) }
  })

  it.each([
    [401, 'UNAUTHENTICATED'], [401, null], [403, 'SUPERADMIN_REQUIRED'], [409, 'COMPANY_CHANGED'],
  ] as const)('ignores a previous import response %s/%s after a new login without clearing its authentication', async (status, code) => {
    acceptSession({ ...accountSession, user: { ...accountSession.user!, isSuperAdmin: true, role: 'admin', company: null } })
    let finish!: (value: Response) => void
    const nextSession = { ...accountSession, user: { ...accountSession.user!, id: 'new-account', company: '西浦' }, csrfToken: 'next-csrf' }
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextSession)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [], skipped: 0 })))
    vi.stubGlobal('fetch', fetch)
    const changed = vi.fn(), expired = vi.fn()
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed); window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      const outcome = api.importServers({ company: 'A公司', memberIds: [], servers: [] }).catch(reason => reason)
      await api.login({ username: 'new-account', password: 'fixture-only' })
      finish(new Response(code ? JSON.stringify({ error: { code } }) : '<html>Unauthorized</html>', { status }))
      expect(await outcome).toMatchObject({ status, code: code ?? 'INVALID_RESPONSE' })
      expect(expired).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
      await api.importServers({ company: '西浦', memberIds: [], servers: [] })
      expect(fetch.mock.lastCall![1].headers).toMatchObject({ 'X-CSRF-Token': 'next-csrf', 'X-RackTop-Company': encodeURIComponent('西浦') })
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally { window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed); window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })

  it.each([[401, 'UNAUTHENTICATED'], [401, null], [403, 'COMPANY_REQUIRED']] as const)('ignores an old photo denial %s/%s after an organization switch', async (status, code) => {
    acceptSession(accountSession)
    let finish!: (value: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const changed = vi.fn(), expired = vi.fn()
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed); window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      const outcome = api.equipmentPhoto('old-photo', 1).catch(reason => reason)
      acceptSession({ ...accountSession, user: { ...accountSession.user!, company: '西浦' }, csrfToken: 'next-csrf' })
      finish(new Response(code ? JSON.stringify({ error: { code } }) : 'Unauthorized', { status }))
      expect(await outcome).toMatchObject({ status })
      expect(expired).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
      await api.updateEquipment('new-photo', { version: 1, name: '设备' })
      expect(fetch.mock.lastCall![1].headers).toMatchObject({ 'X-CSRF-Token': 'next-csrf', 'X-RackTop-Company': encodeURIComponent('西浦') })
    } finally { window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed); window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })
  it('refreshes account permissions on photo access denial without treating it as a failed login', async () => {
    const changed = vi.fn(), expired = vi.fn()
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed); window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'COMPANY_REQUIRED' } }), { status: 403 })))
    try { await expect(api.equipmentPhoto('fixture', 1)).rejects.toMatchObject({ status: 403, code: 'COMPANY_REQUIRED' }); expect(changed).toHaveBeenCalledOnce(); expect(expired).not.toHaveBeenCalled() }
    finally { window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed); window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })
  it('uses anonymous CSRF for demo sign-in and rotates it for booking without sending owner or role', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ user: null, csrfToken: 'anonymous-token' }))).mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 'demo-lin', role: 'member' }, csrfToken: 'signed-in-token' }))).mockResolvedValueOnce(new Response(JSON.stringify({ reservation: { id: 'reservation-1' } })))
    vi.stubGlobal('fetch', fetch)
    await api.session()
    await api.demoLogin('demo-lin')
    await api.reserve({ resourceId: 'server-1', scope: 'gpus', gpuIndices: [1], startAt: '2026-09-09T02:00:00Z', endAt: '2026-09-09T03:00:00Z', purpose: 'test' })
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('anonymous-token')
    expect(fetch.mock.calls[2][1].headers['X-CSRF-Token']).toBe('signed-in-token')
    expect(fetch.mock.calls[2][1].credentials).toBe('same-origin')
    expect(JSON.parse(fetch.mock.calls[2][1].body)).not.toHaveProperty('ownerId')
    expect(JSON.parse(fetch.mock.calls[2][1].body)).not.toHaveProperty('role')
  })
  it('preserves structured conflict records instead of returning a fake success', async () => {
    const conflicts = [{ id: 'conflicting-booking', ownerName: 'Example member' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Slot reserved', conflicts } }), { status: 409 })))
    await expect(api.reserve({ resourceId: 'server-1', scope: 'machine', gpuIndices: [], startAt: '2026-09-09T02:00:00Z', endAt: '2026-09-09T03:00:00Z', purpose: 'test' })).rejects.toMatchObject({ status: 409, conflicts })
    await expect(api.resources()).rejects.toBeInstanceOf(ApiError)
  })
  it('sends an authenticated JSON body when signing out', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 'member' }, csrfToken: 'logout-token' }))).mockResolvedValueOnce(new Response(JSON.stringify({ user: null, csrfToken: 'new-anonymous-token' })))
    vi.stubGlobal('fetch', fetch)
    await api.session()
    await api.logout()
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST', body: '{}', credentials: 'same-origin',
      headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'logout-token' }),
    }))
  })
  it('expires protected sessions on 401 but keeps credential errors in the sign-in form', async () => {
    const expired = vi.fn(); window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } }), { status: 401 })))
    try {
      await expect(api.login({ username: 'member', password: 'wrong' })).rejects.toBeInstanceOf(ApiError)
      await expect(api.changePassword({ oldPassword: 'wrong', newPassword: 'new' })).rejects.toBeInstanceOf(ApiError)
      expect(expired).not.toHaveBeenCalled()
      await expect(api.equipment()).rejects.toBeInstanceOf(ApiError)
      expect(expired).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(SESSION_EXPIRED_EVENT, expired) }
  })
  it('sends the current version and CSRF when saving or deleting a photo and bypasses read caches', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 'member' }, csrfToken: 'photo-csrf' }))).mockResolvedValueOnce(new Response(JSON.stringify({ equipment: { id: 'photo-device' } }))).mockResolvedValueOnce(new Response(JSON.stringify({ equipment: { id: 'photo-device' } }))).mockResolvedValueOnce(new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetch)
    await api.session(); await api.setEquipmentPhoto('photo-device', 4, 'data:image/jpeg;base64,cGhvdG8='); await api.deleteEquipmentPhoto('photo-device', 5); await api.equipmentPhoto('photo-device', 6)
    expect(fetch.mock.calls[1]).toEqual(['/api/equipment/photo-device/photo', expect.objectContaining({ method: 'POST', body: JSON.stringify({ version: 4, dataUrl: 'data:image/jpeg;base64,cGhvdG8=' }), headers: expect.objectContaining({ 'X-CSRF-Token': 'photo-csrf' }) })])
    expect(fetch.mock.calls[2]).toEqual(['/api/equipment/photo-device/photo', expect.objectContaining({ method: 'DELETE', body: '{"version":5}', headers: expect.objectContaining({ 'X-CSRF-Token': 'photo-csrf' }) })])
    expect(fetch).toHaveBeenLastCalledWith('/api/equipment/photo-device/photo?v=6', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('gives GET two bounded attempts and reports a bilingual retryable timeout without leaking timers', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [], fetch = hangingFetch(signals)
    vi.stubGlobal('fetch', fetch)
    const outcome = api.equipment().then(() => null, reason => reason)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(8_000)

    const error = await outcome
    expect(error).toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' })
    expect(errorText(error, (zh) => zh)).toBe('请求超时，请检查网络后重试。')
    expect(errorText(error, (_zh, en) => en)).toBe('Request timed out. Check your connection and try again.')
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry the session GET because it may establish an anonymous session', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [], fetch = hangingFetch(signals)
    vi.stubGlobal('fetch', fetch)
    const outcome = api.session().then(() => null, reason => reason)

    await vi.advanceTimersByTimeAsync(8_000)

    await expect(outcome).resolves.toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a transient GET transport failure once but does not retry a successful response', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resources: [{ id: 'recovered' }] })))
    vi.stubGlobal('fetch', fetch)

    await expect(api.resources()).resolves.toMatchObject({ resources: [{ id: 'recovered' }] })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a temporary GET server failure but returns a permanent client error immediately', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ equipment: [] })))
    vi.stubGlobal('fetch', fetch)

    await expect(api.equipment()).resolves.toEqual({ equipment: [] })
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }))
    await expect(api.equipment()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['POST', 'PATCH', 'DELETE'])('times out %s once without retrying a write', async (method) => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [], fetch = hangingFetch(signals)
    vi.stubGlobal('fetch', fetch)
    const outcome = request('/write-test', method, { value: 1 }).then(() => null, reason => reason)

    await vi.advanceTimersByTimeAsync(8_000)

    const error = await outcome
    expect(error).toMatchObject({ status: 408, code: 'WRITE_RESULT_UNKNOWN' })
    expect(errorText(error, (zh) => zh)).toBe('请求超时，结果可能已保存，请先刷新确认，避免重复提交。')
    expect(errorText(error, (_zh, en) => en)).toBe('Request timed out. The result may have been saved. Refresh and verify before submitting again to avoid a duplicate.')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a caller abort without retrying and removes its timeout', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [], fetch = hangingFetch(signals)
    const controller = new AbortController(), reason = new DOMException('caller stopped', 'AbortError')
    vi.stubGlobal('fetch', fetch)
    const outcome = request('/resources', 'GET', undefined, { signal: controller.signal }).then(() => null, error => error)

    controller.abort(reason)

    expect(await outcome).toBe(reason)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out a photo read once without multiplying concurrent thumbnail requests', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [], fetch = hangingFetch(signals)
    vi.stubGlobal('fetch', fetch)
    const outcome = api.equipmentPhoto('slow-photo', 1).then(() => null, reason => reason)

    await vi.advanceTimersByTimeAsync(8_000)

    await expect(outcome).resolves.toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

})
