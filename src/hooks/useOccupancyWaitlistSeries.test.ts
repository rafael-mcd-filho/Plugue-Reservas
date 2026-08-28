import { describe, expect, it } from 'vitest';
import {
  buildOccupancyWaitlistSeriesRpcParams,
  normalizeOccupancyWaitlistSeries,
} from '@/hooks/useOccupancyWaitlistSeries';

const params = buildOccupancyWaitlistSeriesRpcParams({
  companyId: 'company-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-02',
  granularity: 'day',
});

const payload = {
  series: [
    { period: '2026-08-01', entries: 3, entry_people: 7, seated: 2, seated_people: 5, dropped: 1, dropped_people: 2, average_wait_minutes: 18.4 },
    { period: '2026-08-02', entries: 0, entry_people: 0, seated: 0, seated_people: 0, dropped: 0, dropped_people: 0, average_wait_minutes: 0 },
  ],
  meta: {
    period_start: '2026-08-01',
    period_end: '2026-08-02',
    time_zone: 'America/Manaus',
    granularity: 'day',
    event_semantics: 'event_timestamp',
    generated_at: '2026-08-02T12:00:00Z',
  },
};

describe('normalizeOccupancyWaitlistSeries', () => {
  it('accepts an ordered event-time series and builds exact RPC parameters', () => {
    const result = normalizeOccupancyWaitlistSeries(payload, params);

    expect(params._granularity).toBe('day');
    expect(result.series[0]).toMatchObject({ entries: 3, seated: 2, dropped: 1 });
    expect(result.meta.event_semantics).toBe('event_timestamp');
  });

  it('rejects invalid semantics and unordered buckets', () => {
    expect(() => normalizeOccupancyWaitlistSeries({
      ...payload,
      meta: { ...payload.meta, event_semantics: 'entry_cohort' },
    }, params)).toThrow('dados incompletos ou invalidos');

    expect(() => normalizeOccupancyWaitlistSeries({
      ...payload,
      series: [...payload.series].reverse(),
    }, params)).toThrow('dados incompletos ou invalidos');
  });
});
