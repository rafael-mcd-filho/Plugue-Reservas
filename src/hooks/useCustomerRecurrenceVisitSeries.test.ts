import { describe, expect, it } from 'vitest';
import {
  buildCustomerRecurrenceVisitSeriesRpcParams,
  normalizeCustomerRecurrenceVisitSeries,
} from '@/hooks/useCustomerRecurrenceVisitSeries';

const params = buildCustomerRecurrenceVisitSeriesRpcParams({
  companyId: 'company-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-02',
  granularity: 'day',
  includeCompanions: true,
});

const payload = {
  series: [
    { period: '2026-08-01', total_visits: 3, first_visits: 1, return_visits: 2, return_visit_rate: 66.7 },
    { period: '2026-08-02', total_visits: 0, first_visits: 0, return_visits: 0, return_visit_rate: 0 },
  ],
  meta: {
    period_start: '2026-08-01', period_end: '2026-08-02', time_zone: 'America/Manaus',
    granularity: 'day', include_companions: true, visit_definition: 'canonical_attended_visit',
    generated_at: '2026-08-02T12:00:00Z',
  },
};

describe('normalizeCustomerRecurrenceVisitSeries', () => {
  it('accepts canonical first and return visits with the selected companion mode', () => {
    const result = normalizeCustomerRecurrenceVisitSeries(payload, params);

    expect(params._include_companions).toBe(true);
    expect(result.series[0]).toMatchObject({ first_visits: 1, return_visits: 2, return_visit_rate: 66.7 });
    expect(result.meta.visit_definition).toBe('canonical_attended_visit');
  });

  it('rejects inconsistent totals, rates and impossible dates', () => {
    expect(() => normalizeCustomerRecurrenceVisitSeries({
      ...payload,
      series: [{ ...payload.series[0], total_visits: 4 }, payload.series[1]],
    }, params)).toThrow('dados incompletos ou invalidos');

    expect(() => normalizeCustomerRecurrenceVisitSeries({
      ...payload,
      series: [{ ...payload.series[0], period: '2026-02-30' }, payload.series[1]],
    }, params)).toThrow('dados incompletos ou invalidos');
  });
});
