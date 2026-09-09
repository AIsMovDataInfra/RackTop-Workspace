function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null
}

export function addCalendarDays(value: string, days: number) {
  const date = calendarDate(value)
  if (!date) return ''
  date.setUTCDate(date.getUTCDate() + days)
  const result = date.toISOString().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : ''
}

export function normalizeReportWeek(value: string) {
  const date = calendarDate(value)
  const start = date ? addCalendarDays(value, -(date.getUTCDay() + 6) % 7) : ''
  return start && addCalendarDays(start, 6) ? start : ''
}

export function currentReportWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(value => value.type === type)!.value
  return normalizeReportWeek(`${part('year')}-${part('month')}-${part('day')}`)
}

// Display the stored report window without changing its identity or persistence.
export function reportWeekRange(weekStart: string) {
  const end = addCalendarDays(weekStart, 6)
  return end ? `${weekStart} – ${end}` : ''
}
