import { describe, expect, it } from 'vitest';
import {
  buildAttendanceOutcomeSeriesRpcParams,
  normalizeAttendanceOutcomeSeries,
} from '@/hooks/useAttendanceOutcomeSeries';

const params = buildAttendanceOutcomeSeriesRpcParams({
  companyId: 'company-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-01',
  granularity: 'day',
  outcome: 'all',
  entryMethod: 'all',
});

const point = {
  period: '2026-08-01',
  reservations: 10,
  attended: 6,
  no_show: 2,
  cancelled: 1,
  scheduled: 1,
  reserved_people: 28,
  attended_people: 18,
  no_show_people: 5,
  cancelled_people: 2,
  scheduled_people: 3,
  lost_people: 7,
  expected_reservations: 10,
  realized_reservations: 6,
  expected_people: 28,
  realized_people: 18,
  attendance_rate: 75,
  no_show_rate: 25,
  loss_rate: 33.3,
  realized_reservation_rate: 60,
  realized_people_rate: 64.3,
};

const payload = {
  series: [point],
  meta: {
    period_start: '2026-08-01', period_end: '2026-08-01', time_zone: 'America/Manaus',
    granularity: 'day', outcome: 'all', entry_method: 'all',
    attendance_rate_formula: 'attended / (attended + no_show)',
    realized_rate_formula: 'attended / all_reservations',
    generated_at: '2026-08-01T12:00:00Z',
  },
};

describe('normalizeAttendanceOutcomeSeries', () => {
  it('keeps expected, realized and attendance formulas explicit', () => {
    const result = normalizeAttendanceOutcomeSeries(payload, params);

    expect(params._entry_method).toBe('all');
    expect(result.series[0]).toMatchObject({
      expected_reservations: 10,
      realized_reservations: 6,
      attendance_rate: 75,
      realized_reservation_rate: 60,
    });

    const abovePlan = normalizeAttendanceOutcomeSeries({
      ...payload,
      series: [{ ...point, attended_people: 32, realized_people: 32, realized_people_rate: 114.3 }],
    }, params);
    expect(abovePlan.series[0].realized_people_rate).toBe(114.3);
  });

  it('rejects inconsistent outcome totals and rates', () => {
    expect(() => normalizeAttendanceOutcomeSeries({
      ...payload,
      series: [{ ...point, reservations: 11, expected_reservations: 11 }],
    }, params)).toThrow('dados incompletos ou invalidos');

    expect(() => normalizeAttendanceOutcomeSeries({
      ...payload,
      series: [{ ...point, attendance_rate: 74 }],
    }, params)).toThrow('dados incompletos ou invalidos');
  });
});
