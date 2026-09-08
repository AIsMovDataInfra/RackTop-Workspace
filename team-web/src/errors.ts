import { ApiError } from './api'
import type { Translate } from './types'

export function errorText(error: unknown, t: Translate) {
  if (error instanceof ApiError) {
    const messages: Record<string, [string, string]> = {
      INVALID_CREDENTIALS: ['用户名或密码不正确。', 'The username or password is incorrect.'],
      ACCOUNT_EXISTS: ['用户名或姓名已被使用，请登录已有账号或使用不同的姓名。', 'This username or name is already in use. Sign in to your account or use another name.'],
      INVALID_USERNAME: ['请输入用户名', 'Enter a username'],
      INVALID_NAME: ['姓名须为 1–60 个字符。', 'Your name must contain 1–60 characters.'],
      INVALID_PASSWORD: ['请输入密码', 'Enter a password'],
      BOOTSTRAP_REJECTED: ['管理员设置链接无效或已经使用，请联系部署管理员。', 'This administrator setup link is invalid or already used. Contact your deployment administrator.'],
      BOOTSTRAP_REQUIRED: ['此用户名预留给管理员，请使用管理员设置链接注册。', 'This username is reserved for the administrator. Register using the administrator setup link.'],
      ACCOUNT_LIMIT: ['当前账号数量已达上限，请联系管理员。', 'The account limit has been reached. Contact your administrator.'],
      RATE_LIMITED: ['操作过于频繁，请稍后再试。', 'Too many attempts. Please try again later.'],
      AUTH_BUSY: ['登录服务繁忙，请稍后重试。', 'The sign-in service is busy. Please try again shortly.'],
      CSRF_REJECTED: ['页面会话已更新，请刷新页面后重试。', 'This page session changed. Refresh the page and try again.'],
      INVENTORY_CHANGED: ['GPU 清单已变化，请关闭弹窗并刷新；若清单待核验，请联系管理员。', 'The GPU inventory changed. Close this dialog and refresh. If review is required, contact your administrator.'],
      INVENTORY_CONFLICT: ['GPU 清单发生变化，请联系管理员核验后再预约。', 'The GPU inventory changed. Ask an administrator to review it before booking.'],
      RESOURCE_HAS_RESERVATIONS: ['请先与预约人协调并取消或结束现有预约，再确认新的 GPU 清单。', 'Coordinate with reservation owners and cancel or finish active bookings before accepting the new GPU inventory.'],
    }
    if (messages[error.code]) return t(...messages[error.code])
  }
  if (error instanceof ApiError && error.code === 'INVALID_RESPONSE') return t('服务暂时无法连接，请确认预约服务已启动后重试。', 'The reservation service is unavailable. Check that it is running and retry.')
  if (error instanceof ApiError && error.status === 401) return t('登录已过期，请重新登录。', 'Your session expired. Please sign in again.')
  if (error instanceof ApiError && error.status === 403) return t('没有执行此操作的权限。请确认账号身份，必要时重新登录。', 'You cannot perform this action. Check your account or sign in again.')
  if (error instanceof ApiError && error.status === 404) return t('未找到这条记录，它可能已被移除，或链接中的编号不正确。', 'This record was not found. It may have been removed, or the link may be incorrect.')
  if (error instanceof TypeError) return t('网络连接失败，请检查连接后重试。', 'Network request failed. Check your connection and retry.')
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(' / ')) { const [zh, en] = message.split(' / '); return t(zh, en) }
  if (error instanceof ApiError && t('zh', 'en') === 'en' && /[\u3400-\u9fff]/.test(message)) {
    if (error.status === 409) return 'The request conflicts with another reservation or a newer version. Check the latest schedule and retry.'
    if (error.status === 422 || error.status === 400) return 'Some values are invalid. Check the time range, selected resources and required fields.'
    return 'The server could not complete this request. Please try again.'
  }
  return message
}
