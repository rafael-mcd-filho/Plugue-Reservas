import { describe, expect, it } from 'vitest';
import { buildReservationCalendarDayMetrics } from '@/lib/reservation-calendar-metrics';

describe('reservation-calendar-metrics', () => {
  it('indexes the aggregated database rows by reservation date', () => {
    expect(buildReservationCalendarDayMetrics([
      {
        reservation_date: '2026-07-28',
        reservation_count: 17,
        guest_count: 66,
      },
      {
        reservation_date: '2026-07-29',
        reservation_count: '4',
        guest_count: '10',
      },
    ])).toEqual({
      '2026-07-28': { reservations: 17, guests: 66 },
      '2026-07-29': { reservations: 4, guests: 10 },
    });
  });

  it('fails safely when an aggregate is not numeric', () => {
    expect(buildReservationCalendarDayMetrics([
      {
        reservation_date: '2026-07-28',
        reservation_count: 'invalid',
        guest_count: -1,
      },
    ])).toEqual({
      '2026-07-28': { reservations: 0, guests: 0 },
    });
  });
});
