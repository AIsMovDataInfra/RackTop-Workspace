import { describe, expect, it } from 'vitest'
import { beijingInput, bookingPayload, inputToIso, overlaps, reservationIdFromSearch } from './time'
import type { Reservation } from './types'

describe('booking time and payload', () => {
  it('converts Beijing input to explicit UTC and strips GPU selection for a whole-machine booking', () => {
    const draft = bookingPayload({ resourceId: 'server-1', scope: 'machine', gpuIndices: [3, 1], start: '2026-09-09T10:00', end: '2026-09-09T11:30', purpose: ' 训练验证 ' })
    expect(draft).toEqual({ resourceId: 'server-1', scope: 'machine', gpuIndices: [], startAt: '2026-09-09T02:00:00.000Z', endAt: '2026-09-09T03:30:00.000Z', purpose: '训练验证' })
    expect(beijingInput(draft.startAt)).toBe('2026-09-09T10:00')
    expect(bookingPayload({ resourceId: 'server-1', scope: 'gpus', gpuIndices: [3, 1], start: '2026-09-09T10:00', end: '2026-09-09T11:30', purpose: 'training' }).gpuIndices).toEqual([1, 3])
  })
  it('rejects impossible dates, invalid ranges and empty GPU selections', () => {
    expect(() => inputToIso('2026-02-30T10:00')).toThrow()
    expect(() => inputToIso('2026-09-09T10:00Z')).toThrow()
    const values = { resourceId: 'server-1', scope: 'gpus' as const, gpuIndices: [], start: '2026-09-09T10:00', end: '2026-09-09T11:00', purpose: 'training' }
    expect(() => bookingPayload(values)).toThrow('GPU')
    expect(() => bookingPayload({ ...values, gpuIndices: [0], end: values.start })).toThrow()
  })
  it('does not mark adjacent or cancelled reservations as overlapping', () => {
    const reservation = { startAt: '2026-09-09T02:00:00Z', endAt: '2026-09-09T03:00:00Z', status: 'confirmed' } as Reservation
    expect(overlaps(reservation, '2026-09-09T03:00:00Z', '2026-09-09T04:00:00Z')).toBe(false)
    expect(overlaps(reservation, '2026-09-09T02:30:00Z', '2026-09-09T04:00:00Z')).toBe(true)
    expect(overlaps({ ...reservation, status: 'cancelled' }, '2026-09-09T02:30:00Z', '2026-09-09T04:00:00Z')).toBe(false)
  })
  it('preserves only a single validated reservation id for sign-in links', () => {
    expect(reservationIdFromSearch('?reservation=bd42-123_test')).toBe('bd42-123_test')
    expect(reservationIdFromSearch('?reservation=first&reservation=second')).toBeNull()
    expect(reservationIdFromSearch('?reservation=https%3A%2F%2Fother.example')).toBeNull()
  })
})

import { resourceIdFromSearch } from './time'
it('validates resource deep links without accepting duplicates or path values', () => {
  expect(resourceIdFromSearch('?resource=server-123')).toBe('server-123')
  expect(resourceIdFromSearch('?resource=a&resource=b')).toBeNull()
  expect(resourceIdFromSearch('?resource=../../private')).toBeNull()
})
