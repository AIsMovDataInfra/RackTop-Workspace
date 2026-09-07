export type Locale = 'zh-CN' | 'en'
export type Translate = (zh: string, en: string) => string
export interface User { id: string; name: string; role: 'admin' | 'member' }
export interface Resource { id: string; cluster: string; name: string; gpuModel: string; gpuCount: number; notes: string; enabled: boolean }
export interface Reservation {
  id: string; resourceId: string; resourceName: string; cluster: string; ownerId: string; ownerName: string
  scope: 'machine' | 'gpus'; gpuIndices: number[]; startAt: string; endAt: string; purpose: string
  status: 'confirmed' | 'cancelled' | 'completed'; createdAt: string; updatedAt: string; version: number; plannedEndAt?: string
}
export interface Session {
  user: User | null; csrfToken: string | null; authMode: 'demo' | 'feishu'; feishuConfigured: boolean
  demoUsers?: User[]; notifications: { configured: boolean }; timezone: 'Asia/Shanghai'
}
export interface BookingDraft { resourceId: string; scope: 'machine' | 'gpus'; gpuIndices: number[]; startAt: string; endAt: string; purpose: string }
export interface ResourceDraft { cluster: string; name: string; gpuModel: string; gpuCount: number; notes: string; enabled?: boolean }
