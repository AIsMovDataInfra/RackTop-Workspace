import { request } from './api'
import type { DeviceRequestInput, EquipmentRequest, ReportInput, RequestStatus, WeeklyReport, WorkAudit } from './workspace-types'

export const workspaceApi = {
  reports: () => request<{ reports: WeeklyReport[] }>('/workspace/reports'),
  report: (id: string) => request<{ report: WeeklyReport; history: WorkAudit[] }>(`/workspace/reports/${encodeURIComponent(id)}`),
  createReport: (body: ReportInput) => request<{ report: WeeklyReport }>('/workspace/reports', 'POST', body),
  updateReport: (id: string, body: { version: number; todos: ReportInput['todos']; nextPlan: string; status: ReportInput['status'] }) => request<{ report: WeeklyReport }>(`/workspace/reports/${encodeURIComponent(id)}`, 'PATCH', body),
  assignReviewer: (id: string, version: number, reviewerId: string | null) => request<{ report: WeeklyReport }>(`/workspace/reports/${encodeURIComponent(id)}/reviewer`, 'POST', { version, reviewerId }),
  reviewReport: (id: string, version: number, score: number, comment: string) => request<{ report: WeeklyReport }>(`/workspace/reports/${encodeURIComponent(id)}/review`, 'POST', { version, score, comment }),
  requests: () => request<{ requests: EquipmentRequest[] }>('/workspace/requests'),
  deviceRequest: (id: string) => request<{ request: EquipmentRequest; history: WorkAudit[] }>(`/workspace/requests/${encodeURIComponent(id)}`),
  createRequest: (body: DeviceRequestInput) => request<{ id: string; submitted: true }>('/workspace/requests', 'POST', body),
  updateRequest: (id: string, version: number, status: Exclude<RequestStatus, 'pending'>, comment: string) => request<{ request: EquipmentRequest }>(`/workspace/requests/${encodeURIComponent(id)}`, 'PATCH', { version, status, comment }),
}
