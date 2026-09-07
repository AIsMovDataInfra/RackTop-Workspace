import { ApiError } from './api'
import type { Translate } from './types'

export function errorText(error: unknown, t: Translate) {
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
