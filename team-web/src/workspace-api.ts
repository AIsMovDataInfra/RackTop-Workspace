import { request } from './api'
import type { DeviceRequestInput, EquipmentRequest, RequestStatus, WorkAudit } from './workspace-types'

export const workspaceApi = {
  requests: () => request<{ requests: EquipmentRequest[] }>('/workspace/requests'),
  deviceRequest: (id: string) => request<{ request: EquipmentRequest; history: WorkAudit[] }>(`/workspace/requests/${encodeURIComponent(id)}`),
  createRequest: (body: DeviceRequestInput) => request<{ id: string; submitted: true }>('/workspace/requests', 'POST', body),
  updateRequest: (id: string, version: number, status: Exclude<RequestStatus, 'pending'>, comment: string) => request<{ request: EquipmentRequest }>(`/workspace/requests/${encodeURIComponent(id)}`, 'PATCH', { version, status, comment }),
}
