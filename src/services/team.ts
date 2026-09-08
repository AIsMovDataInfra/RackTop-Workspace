import { invoke } from '@tauri-apps/api/core'
export const TEAM_URL = 'https://136.0.110.161'
export interface TeamStatus {
  url: string; authenticated: boolean
  user: { id: string; name: string; username: string; role: 'admin' | 'member' } | null
  bindings: Record<string, { resourceId: string | null; lastSyncedAt: number | null; error: string | null }>
}
export interface TeamResource { id: string; name: string; cluster: string; gpuModel: string; gpuCount: number; status: string; lastSeenAt: string | null; inventoryState: string; enabled: boolean }
export interface TeamReservation { id: string; resourceId: string; resourceName: string; ownerName: string; scope: string; gpuIndices: number[]; startAt: string; endAt: string; status: string }
export interface TeamData { resources: TeamResource[]; reservations: TeamReservation[] }
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('桌面连接与资源同步需要在 RackTop 应用内操作；可以直接打开预约网页。')
  return invoke<T>(name, args)
}
export const teamApi = {
  status: () => call<TeamStatus>('team_status'),
  data: () => call<TeamData>('team_data'),
  login: (username: string, password: string) => call<TeamStatus>('team_login', { username, password }),
  logout: () => call<void>('team_logout'),
  select: (serverIds: string[]) => call<TeamStatus>('team_select', { serverIds }),
  sync: () => call<TeamStatus>('team_sync'),
}
