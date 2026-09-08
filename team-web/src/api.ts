import type { BookingDraft, Reservation, Resource, ResourceDraft, Session } from './types'

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string, public conflicts: Reservation[] = []) { super(message); this.name = 'ApiError' }
}
let csrfToken: string | null = null

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', headers: {
      Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let result: unknown
  try { result = await response.json() } catch { throw new ApiError('服务返回了无法读取的响应 / Invalid server response', response.status, 'INVALID_RESPONSE') }
  if (!response.ok) {
    const error = (result as { error?: { message?: string; code?: string; conflicts?: Reservation[] } })?.error
    throw new ApiError(error?.message || `请求失败 / Request failed (${response.status})`, response.status, error?.code || 'REQUEST_FAILED', error?.conflicts || [])
  }
  return result as T
}

async function sessionRequest(path: string, method = 'GET', body?: unknown) {
  const result = await request<Session>(path, method, body)
  csrfToken = result.csrfToken
  return result
}

export const api = {
  session: () => sessionRequest('/session'),
  register: (details: { username: string; name: string; password: string; bootstrapToken?: string }) => sessionRequest('/auth/register', 'POST', details),
  login: (details: { username: string; password: string; rememberMe?: boolean }) => sessionRequest('/auth/login', 'POST', details),
  changePassword: (details: { oldPassword: string; newPassword: string }) => sessionRequest('/auth/change-password', 'POST', details),
  demoLogin: (userId: string) => sessionRequest('/auth/demo', 'POST', { userId }),
  logout: async () => { await request('/auth/logout', 'POST', {}); csrfToken = null },
  resources: () => request<{ resources: Resource[] }>('/resources'),
  reservations: (options: { from?: string; to?: string; mine?: boolean } = {}) => {
    const query = new URLSearchParams()
    if (options.from) query.set('from', options.from)
    if (options.to) query.set('to', options.to)
    if (options.mine) query.set('mine', 'true')
    return request<{ reservations: Reservation[] }>(`/reservations?${query}`)
  },
  reservation: (id: string) => request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(id)}`),
  reserve: (draft: BookingDraft) => request<{ reservation: Reservation }>('/reservations', 'POST', draft),
  renew: (reservation: Reservation, endAt: string, inventoryVersion = reservation.inventoryVersion) => request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(reservation.id)}`, 'PATCH', { version: reservation.version, endAt, ...(inventoryVersion ? { inventoryVersion } : {}) }),
  cancel: (reservation: Reservation) => request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(reservation.id)}/cancel`, 'POST', { version: reservation.version }),
  finish: (reservation: Reservation) => request<{ reservation: Reservation }>(`/reservations/${encodeURIComponent(reservation.id)}/finish`, 'POST', { version: reservation.version }),
  acceptInventory: (resource: Resource) => request<{ resource: Resource }>(`/resources/${encodeURIComponent(resource.id)}`, 'PATCH', { acceptInventoryVersion: resource.inventoryVersion }),
  createResource: (draft: ResourceDraft) => request<{ resource: Resource }>('/resources', 'POST', draft),
  updateResource: (id: string, draft: Partial<ResourceDraft>) => request<{ resource: Resource }>(`/resources/${encodeURIComponent(id)}`, 'PATCH', draft),
}
