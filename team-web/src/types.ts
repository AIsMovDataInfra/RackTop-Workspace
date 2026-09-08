export type Locale = 'zh-CN' | 'en'
export type Translate = (zh: string, en: string) => string
export interface User { id: string; name: string; role: 'admin' | 'member'; username?: string }
export interface Gpu { id: string; uuid: string; index: number; model: string; memoryTotalMb: number }
export interface Resource { id: string; cluster: string; name: string; gpuModel: string; gpuCount: number; notes: string; enabled: boolean; gpus?: Gpu[]; pendingGpus?: Omit<Gpu, 'id'>[] | null; inventoryVersion?: number; inventoryState?: 'manual' | 'synced' | 'conflict'; lastSeenAt?: string | null; observedAt?: string | null; status?: 'online' | 'offline' | 'unknown' }
export interface Reservation {
  id: string; resourceId: string; resourceName: string; cluster: string; ownerId?: string; ownerName: string
  scope: 'machine' | 'gpus'; gpuIndices: number[]; startAt: string; endAt: string; purpose?: string; gpuIds?: string[]; inventoryVersion?: number
  status: 'confirmed' | 'cancelled' | 'completed'; createdAt: string; updatedAt: string; version: number; plannedEndAt?: string
}
export interface Session {
  user: User | null; csrfToken: string | null; authMode: 'demo' | 'feishu' | 'account'; feishuConfigured: boolean
  demoUsers?: User[]; notifications: { configured: boolean }; timezone: 'Asia/Shanghai'
}
export interface BookingDraft { resourceId: string; scope: 'machine' | 'gpus'; gpuIndices: number[]; startAt: string; endAt: string; purpose: string; gpuIds?: string[]; inventoryVersion?: number; requestId?: string }
export interface ResourceDraft { cluster: string; name: string; gpuModel: string; gpuCount: number; notes: string; enabled?: boolean }
export type EquipmentStatus = 'available' | 'in_use' | 'maintenance' | 'retired'
export interface EquipmentDraft {
  name: string; category: string; model: string
  responsiblePerson: string; currentUser: string; location: string; notes: string; status: EquipmentStatus
}
export interface EquipmentPhoto { url: string; width: number; height: number; bytes: number; updatedAt: string }
export interface Equipment extends EquipmentDraft { id: string; code: string; serialNumber: string; legacySerialNumber?: string | null; photo: EquipmentPhoto | null; version: number; createdAt: string; updatedAt: string }
export interface EquipmentHistory {
  actorName: string; action: 'created' | 'updated'; at: string
  changes: { field: string; oldValue: string | null; newValue: string | null }[]
}
