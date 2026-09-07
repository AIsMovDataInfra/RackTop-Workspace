import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('authenticated reservation API', () => {
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
})
