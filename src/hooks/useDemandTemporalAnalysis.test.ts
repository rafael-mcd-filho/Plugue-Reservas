import { describe, expect, it } from 'vitest';
import {
  buildDemandTemporalAnalysisRpcParams,
  normalizeDemandTemporalAnalysis,
} from '@/hooks/useDemandTemporalAnalysis';

const params = buildDemandTemporalAnalysisRpcParams({
  companyId: 'company-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-02',
  granularity: 'day',
});

const entryPoint = (period: string) => ({
  period,
  online_reservations: 2,
  online_people: 5,
  affiliate_reservations: 1,
  affiliate_people: 2,
  manual_reservations: 1,
  manual_people: 3,
  waitlist_reservations: 0,
  waitlist_people: 0,
});

const payload = {
  entry_mode_created_trend: [entryPoint('2026-08-01'), entryPoint('2026-08-02')],
  entry_mode_visit_trend: [entryPoint('2026-08-01'), entryPoint('2026-08-02')],
  lead_time_trend: [
    { period: '2026-08-01', scheduled_reservations: 4, average_lead_days: 2.5, same_day_reservations: 1, same_day_rate: 25 },
    { period: '2026-08-02', scheduled_reservations: 0, average_lead_days: 0, same_day_reservations: 0, same_day_rate: 0 },
  ],
  meta: {
    period_start: '2026-08-01',
    period_end: '2026-08-02',
    time_zone: 'America/Manaus',
    granularity: 'day',
    generated_at: '2026-08-02T12:00:00Z',
  },
};

describe('normalizeDemandTemporalAnalysis', () => {
  it('preserves the RPC contract and matching zero-filled buckets', () => {
    const result = normalizeDemandTemporalAnalysis(payload, params);

    expect(params).toEqual({
      _company_id: 'company-1',
      _start_date: '2026-08-01',
      _end_date: '2026-08-02',
      _granularity: 'day',
    });
    expect(result.lead_time_trend[0].same_day_rate).toBe(25);
    expect(result.entry_mode_visit_trend).toHaveLength(2);
  });

  it('rejects bucket mismatches and inconsistent lead-time rates', () => {
    expect(() => normalizeDemandTemporalAnalysis({
      ...payload,
      entry_mode_visit_trend: [entryPoint('2026-08-01')],
    }, params)).toThrow('dados incompletos ou invalidos');

    expect(() => normalizeDemandTemporalAnalysis({
      ...payload,
      lead_time_trend: [
        { ...payload.lead_time_trend[0], same_day_rate: 30 },
        payload.lead_time_trend[1],
      ],
    }, params)).toThrow('dados incompletos ou invalidos');
  });
});
