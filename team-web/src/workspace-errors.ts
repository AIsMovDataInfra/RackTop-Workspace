import { ApiError } from './api'
import { errorText } from './errors'
import type { Translate } from './types'

export function workspaceErrorText(error: unknown, t: Translate) {
  if (!(error instanceof ApiError)) return errorText(error, t)
  const messages: Record<string, [string, string]> = {
    SUPERADMIN_REQUIRED: ['此操作仅限超级管理员。', 'Only the super administrator can perform this action.'],
    SUPERADMIN_REPORT_NOT_REQUIRED: ['超级管理员无需写周报，请选择普通成员作为作者。', 'Super administrators do not need weekly reports. Choose a regular member as the author.'],
    SUPERADMIN_REQUEST_NOT_REQUIRED: ['超级管理员无需提交设备申请，可直接处理成员申请。', 'Super administrators do not submit device requests. Review member requests directly.'],
    REPORT_EXISTS: ['该成员本周已有周报，请打开已有记录。', 'This member already has a report for this week. Open the existing report.'],
    REPORT_LOCKED: ['周报已提交，正文不可再修改。请重新打开查看最新内容。', 'The report was submitted and its contents are locked. Reopen it to see the latest contents.'],
    REPORT_NOT_SUBMITTED: ['请等待作者提交周报后再评分。', 'Wait for the author to submit the report before reviewing it.'],
    REPORT_NOT_FOUND: ['找不到可访问的周报，评审分配或公司可能已变更。', 'This report is no longer accessible. Its reviewer assignment or company may have changed.'],
    REQUEST_NOT_FOUND: ['找不到设备申请。', 'The equipment request was not found.'],
    REQUEST_NOT_APPROVED: ['请先批准申请，再登记领取。', 'Approve the request before recording collection.'],
    REQUEST_LOCKED: ['已领取的申请不可回退状态。', 'A collected request cannot return to an earlier status.'],
    EQUIPMENT_UNAVAILABLE: ['暂不能关联设备，请刷新后重试。', 'Equipment cannot be linked right now. Refresh and retry.'],
    DATABASE_BUSY: ['工作台繁忙，请稍后重试。', 'The workspace is busy. Please try again shortly.'],
  }
  if (messages[error.code]) return t(...messages[error.code])
  if (error.code === 'INVALID_INPUT') return t(error.message, 'Check the entered values. Reports need a Monday date; submitting requires a todo, reasons for unfinished work and a next-week plan. Requests need a category, a positive whole quantity and a purpose.')
  if (error.status === 409) return t(error.message, 'The report, request or linked equipment has changed. Read the latest record and review your input before retrying.')
  return errorText(error, t)
}
