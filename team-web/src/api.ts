import type { BookingDraft, Company, Equipment, EquipmentDraft, EquipmentHistory, EquipmentStats, Member, Reservation, Resource, ResourceDraft, Session } from './types'

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string, public conflicts: Reservation[] = []) { super(message); this.name = 'ApiError' }
}
export interface RequestOptions { signal?: AbortSignal }

const REQUEST_TIMEOUT_MS = 8_000
const GET_ATTEMPTS = 2
const RETRYABLE_GET_STATUSES = new Set([408, 500, 502, 503, 504])
const NON_RETRYABLE_GET_PATHS = new Set(['/session'])
let csrfToken: string | null = null
export const SESSION_EXPIRED_EVENT = 'racktop-team-session-expired'
export const ACCOUNT_CHANGED_EVENT = 'racktop-team-account-changed'
function expired(path: string, status: number, code?: string) {
  if (status === 403 && ['COMPANY_REQUIRED', 'SUPERADMIN_REQUIRED'].includes(code || '')) window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT))
  if (status === 401 && !(path === '/auth/change-password' && code === 'INVALID_CREDENTIALS') && !['/session', '/auth/login', '/auth/register', '/auth/demo'].includes(path)) { csrfToken = null; window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)) }
}

function timeoutError() {
  return new ApiError('请求超时，请检查网络后重试。 / Request timed out. Check your connection and try again.', 408, 'REQUEST_TIMEOUT')
}

function writeResultUnknownError() {
  return new ApiError('请求超时，结果可能已保存，请先刷新确认，避免重复提交。 / Request timed out. The result may have been saved. Refresh and verify before submitting again to avoid a duplicate.', 408, 'WRITE_RESULT_UNKNOWN')
}

function cancelledError() {
  const error = new Error('请求已取消 / Request cancelled')
  error.name = 'AbortError'
  return error
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutFailure = timeoutError()): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? cancelledError()
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort(signal?.reason ?? cancelledError())
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort(timeoutFailure) }, REQUEST_TIMEOUT_MS)
  try { return await run(controller.signal) }
  catch (reason) { if (timedOut) throw timeoutFailure; throw reason }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

function retryableGetFailure(reason: unknown) {
  if (reason instanceof TypeError) return true
  if (!(reason instanceof ApiError)) return false
  return reason.code === 'REQUEST_TIMEOUT' || RETRYABLE_GET_STATUSES.has(reason.status)
    || (reason.code === 'INVALID_RESPONSE' && (reason.status === 0 || reason.status === 200 || reason.status >= 500))
}

async function jsonRequest<T>(path: string, method: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal, headers: {
      Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let result: unknown
  try { result = await response.json() } catch { expired(path, response.status); throw new ApiError('服务返回了无法读取的响应 / Invalid server response', response.status, 'INVALID_RESPONSE') }
  if (!response.ok) {
    const error = (result as { error?: { message?: string; code?: string; conflicts?: Reservation[] } })?.error
    expired(path, response.status, error?.code)
    throw new ApiError(error?.message || `请求失败 / Request failed (${response.status})`, response.status, error?.code || 'REQUEST_FAILED', error?.conflicts || [])
  }
  return result as T
}

export async function request<T>(path: string, method = 'GET', body?: unknown, options: RequestOptions = {}): Promise<T> {
  const normalizedMethod = method.toUpperCase()
  const isGet = normalizedMethod === 'GET'
  const attempts = isGet && !NON_RETRYABLE_GET_PATHS.has(path.split('?', 1)[0]) ? GET_ATTEMPTS : 1
  const timeoutFailure = isGet ? timeoutError() : writeResultUnknownError()
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await withTimeout((signal) => jsonRequest<T>(path, normalizedMethod, body, signal), options.signal, timeoutFailure) }
    catch (reason) {
      if (options.signal?.aborted || attempt + 1 === attempts || !retryableGetFailure(reason)) throw reason
    }
  }
  throw new Error('请求未完成 / Request did not complete')
}

async function sessionRequest(path: string, method = 'GET', body?: unknown) {
  const result = await request<Session>(path, method, body)
  csrfToken = result.csrfToken
  return result
}

export const api = {
  session: () => sessionRequest('/session'),
  register: (details: { username?: string; name: string; password: string; bootstrapToken?: string; rememberMe?: boolean }) => sessionRequest('/auth/register', 'POST', details),
  login: (details: { username: string; password: string; rememberMe?: boolean }) => sessionRequest('/auth/login', 'POST', details),
  changePassword: (details: { oldPassword: string; newPassword: string }) => sessionRequest('/auth/change-password', 'POST', details),
  updateProfile: (details: { version: number; avatar: string }) => sessionRequest('/auth/profile', 'POST', details),
  requestPasswordRecovery: (username: string) => request<{ ok: true }>('/auth/recovery-request', 'POST', { username }),
  members: () => request<{ members: Member[] }>('/admin/members'),
  createMember: (details: { username?: string; name: string; password: string; company: Company }) => request<{ member: Member }>('/admin/members', 'POST', details),
  setMemberCompany: (member: Member, company: Company) => request<{ member: Member }>(`/admin/members/${encodeURIComponent(member.id)}`, 'PATCH', { version: member.version, company }),
  resetMemberPassword: (member: Member, newPassword: string) => request<{ member: Member }>(`/admin/members/${encodeURIComponent(member.id)}/reset-password`, 'POST', { version: member.version, newPassword }),
  deleteMember: (member: Member) => request<{ ok: true }>(`/admin/members/${encodeURIComponent(member.id)}`, 'DELETE', { version: member.version }),
  demoLogin: (userId: string) => sessionRequest('/auth/demo', 'POST', { userId }),
  logout: async () => { try { await request('/auth/logout', 'POST', {}) } finally { csrfToken = null } },
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
  equipmentPhoto: async (id: string, version: number, options: RequestOptions = {}) => {
    const path = `/equipment/${encodeURIComponent(id)}/photo?v=${version}`
    return withTimeout(async (signal) => {
      const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', signal })
      if (!response.ok) {
        let code = 'PHOTO_READ_FAILED'
        try { const body = await response.json(); if (typeof body?.error?.code === 'string') code = body.error.code } catch { /* The proxy may return a non-JSON error. */ }
        expired(path, response.status, code)
        throw new ApiError('照片暂时无法读取 / Could not load the photo', response.status, code)
      }
      return response.blob()
    }, options.signal)
  },
  setEquipmentPhoto: (id: string, version: number, dataUrl: string) => request<{ equipment: Equipment }>(`/equipment/${encodeURIComponent(id)}/photo`, 'POST', { version, dataUrl }),
  deleteEquipmentPhoto: (id: string, version: number) => request<{ equipment: Equipment }>(`/equipment/${encodeURIComponent(id)}/photo`, 'DELETE', { version }),
  equipment: () => request<{ equipment: Equipment[] }>('/equipment'),
  equipmentStats: () => request<{ stats: EquipmentStats }>('/equipment/stats'),
  equipmentDetails: (id: string) => request<{ equipment: Equipment; history: EquipmentHistory[] }>(`/equipment/${encodeURIComponent(id)}`),
  createEquipment: (draft: EquipmentDraft) => request<{ equipment: Equipment }>('/equipment', 'POST', draft),
  updateEquipment: (id: string, draft: Partial<EquipmentDraft> & { version: number }) => request<{ equipment: Equipment }>(`/equipment/${encodeURIComponent(id)}`, 'PATCH', draft),
}
