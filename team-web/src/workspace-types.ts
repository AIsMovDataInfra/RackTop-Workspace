import type { Company, Session } from './types'
import type { PreferencesState } from './preferences'

export interface WorkTodo { text: string; completion: number; unfinishedReason: string; effect: string }
export interface WeeklyReport {
  id: string; authorId: string; authorName: string; company: Company; weekStart: string
  todos: WorkTodo[]; nextPlan: string; status: 'draft' | 'submitted'
  reviewerId: string | null; reviewerName: string | null; score: number | null; reviewComment: string
  reviewedBy: string | null; reviewedName: string | null; reviewedAt: string | null; submittedAt: string | null
  version: number; createdAt: string; updatedAt: string
}
export interface ReportInput { authorId?: string; weekStart: string; todos: WorkTodo[]; nextPlan: string; status: 'draft' | 'submitted' }
export interface WorkAudit { actorName: string; action: string; at: string; details: Record<string, unknown> }
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'collected'
export interface EquipmentRequest {
  id: string; applicantId: string; applicantName: string; company: Company; category: string; quantity: number; purpose: string
  equipmentId: string | null; equipmentName: string | null; equipmentSerial: string | null
  status: RequestStatus; decisionComment: string; equipmentUpdated: boolean; version: number; createdAt: string; updatedAt: string
}
export interface DeviceRequestInput { category: string; quantity: number; purpose: string; equipmentId?: string | null }
export interface WorkModuleProps { session: Session; state: PreferencesState; navigate: (path: string) => void; onLogout: () => Promise<void>; onSessionChanged: (session: Session) => void; onSessionExpired: () => void }
