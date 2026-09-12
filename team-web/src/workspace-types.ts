import type { Company, Session } from './types'
import type { PreferencesState } from './preferences'

export interface WorkAudit { actorName: string; action: string; at: string; details: Record<string, unknown> }
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'collected'
export interface EquipmentRequest {
  id: string; applicantId: string; applicantName: string; company: Company; category: string; quantity: number; purpose: string
  equipmentId: string | null; equipmentName: string | null; equipmentSerial: string | null
  status: RequestStatus; decisionComment: string; equipmentUpdated: boolean; version: number; createdAt: string; updatedAt: string
}
export interface DeviceRequestInput { category: string; quantity: number; purpose: string; equipmentId?: string | null }
export interface WorkModuleProps { session: Session; state: PreferencesState; navigate: (path: string) => void; onLogout: () => Promise<void>; onSessionChanged: (session: Session) => void; onSessionExpired: () => void }
