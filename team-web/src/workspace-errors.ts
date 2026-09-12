import { ApiError } from './api'
import { errorText } from './errors'
import type { Translate } from './types'

export function workspaceErrorText(error: unknown, t: Translate) {
  if (!(error instanceof ApiError)) return errorText(error, t)
  const messages: Record<string, [string, string]> = {
    SUPERADMIN_REQUIRED: ['此操作仅限超级管理员。', 'Only the super administrator can perform this action.'],
    SUPERADMIN_REQUEST_NOT_REQUIRED: ['超级管理员无需提交设备申请，可直接处理成员申请。', 'Super administrators do not submit device requests. Review member requests directly.'],
    REQUEST_NOT_FOUND: ['找不到设备申请。', 'The equipment request was not found.'],
    REQUEST_NOT_APPROVED: ['请先批准申请，再登记领取。', 'Approve the request before recording collection.'],
    REQUEST_LOCKED: ['已领取的申请不可回退状态。', 'A collected request cannot return to an earlier status.'],
    EQUIPMENT_UNAVAILABLE: ['暂不能关联设备，请刷新后重试。', 'Equipment cannot be linked right now. Refresh and retry.'],
    DATABASE_BUSY: ['工作台繁忙，请稍后重试。', 'The workspace is busy. Please try again shortly.'],
  }
  if (messages[error.code]) return t(...messages[error.code])
  if (error.code === 'COMPANY_CHANGED') return errorText(error, t)
  if (error.code === 'INVALID_INPUT') return t(error.message, 'Check the category, whole-number quantity and purpose of the equipment request.')
  if (error.status === 409) return t(error.message, 'The request or linked equipment has changed. Read the latest record and review your input before retrying.')
  return errorText(error, t)
}
