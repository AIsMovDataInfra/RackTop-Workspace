import { expect, it } from 'vitest'
import { addCalendarDays, currentReportWeek, normalizeReportWeek, reportWeekRange } from './weekly-dates'

it.each([
  ['2026-12-28', '2026-12-28'], ['2026-12-31', '2026-12-28'], ['2027-01-03', '2026-12-28'],
  ['2027-01-04', '2027-01-04'], ['2024-02-29', '2024-02-26'], ['2026-03-08', '2026-03-02'],
])('assigns calendar day %s to Monday %s without timezone or year-boundary shifts', (day, monday) => {
  expect(normalizeReportWeek(day)).toBe(monday)
})

it('formats this week and the next week across years without mutating stored dates', () => {
  expect(reportWeekRange('2026-12-28')).toBe('2026-12-28 – 2027-01-03')
  expect(reportWeekRange(addCalendarDays('2026-12-28', 7))).toBe('2027-01-04 – 2027-01-10')
  expect(reportWeekRange('2030-01-08')).toBe('2030-01-08 – 2030-01-14')
})

it('uses the Shanghai calendar day for the current week and rejects impossible dates', () => {
  expect(currentReportWeek(new Date('2027-01-03T15:59:59Z'))).toBe('2026-12-28')
  expect(currentReportWeek(new Date('2027-01-03T16:00:00Z'))).toBe('2027-01-04')
  for (const date of ['', '2025-02-29', '2026-13-01', '2026-01-01T00:00:00Z']) {
    expect(normalizeReportWeek(date)).toBe('')
    expect(reportWeekRange(date)).toBe('')
  }
})

it('rejects weeks extending outside four-digit calendar years', () => {
  expect(normalizeReportWeek('0000-01-01')).toBe('')
  expect(normalizeReportWeek('9999-12-31')).toBe('')
})
