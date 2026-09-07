import type { BookingDraft, Reservation, Translate } from './types'

export function beijingInput(value: string | number = Date.now()) {
  return new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16)
}

export function inputToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择有效的日期和时间 / Select a valid date and time')
  const result = new Date(`${value}:00+08:00`)
  if (!Number.isFinite(result.getTime()) || beijingInput(result.toISOString()) !== value) throw new Error('日期或时间无效 / Invalid date or time')
  return result.toISOString()
}

export function initialWindow() {
  const start = Math.ceil((Date.now() + 60_000) / 900_000) * 900_000
  return { start: beijingInput(start), end: beijingInput(start + 2 * 3_600_000) }
}

export function formatTime(value: string, locale: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...options }).format(new Date(value))
}

export function overlaps(reservation: Reservation, start: string, end: string) {
  return reservation.status === 'confirmed' && Date.parse(reservation.startAt) < Date.parse(end) && Date.parse(reservation.endAt) > Date.parse(start)
}

export function reservationStatus(reservation: Reservation, t: Translate, now = Date.now()) {
  if (reservation.status === 'cancelled') return t('已取消', 'Cancelled')
  if (reservation.status === 'completed') return t('已提前结束', 'Finished early')
  if (Date.parse(reservation.endAt) <= now) return t('已到期', 'Elapsed')
  return Date.parse(reservation.startAt) > now ? t('待开始', 'Scheduled') : t('预约进行中', 'In progress')
}

export function bookingPayload(values: { resourceId: string; scope: 'machine' | 'gpus'; gpuIndices: number[]; start: string; end: string; purpose: string }): BookingDraft {
  const startAt = inputToIso(values.start), endAt = inputToIso(values.end)
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error('结束时间须晚于开始时间 / End must be after start')
  if (!values.purpose.trim()) throw new Error('请填写预约用途 / Enter a purpose')
  if (values.scope === 'gpus' && !values.gpuIndices.length) throw new Error('请至少选择一张 GPU / Select at least one GPU')
  return { resourceId: values.resourceId, scope: values.scope, gpuIndices: values.scope === 'machine' ? [] : [...values.gpuIndices].sort((a, b) => a - b), startAt, endAt, purpose: values.purpose.trim() }
}

export function reservationIdFromSearch(search: string) {
  const ids = new URLSearchParams(search).getAll('reservation')
  return ids.length === 1 && /^[a-zA-Z0-9_-]{1,100}$/.test(ids[0]) ? ids[0] : null
}

export function resourceIdFromSearch(search: string) {
  const ids = new URLSearchParams(search).getAll('resource')
  return ids.length === 1 && /^[a-zA-Z0-9_-]{1,100}$/.test(ids[0]) ? ids[0] : null
}
