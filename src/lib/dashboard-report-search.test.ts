import { describe, expect, it } from 'vitest';
import { buildDashboardReportSearch } from '@/lib/dashboard-report-search';

describe('buildDashboardReportSearch', () => {
  it.each([
    ['today', 'today'],
    ['yesterday', 'yesterday'],
    ['this_month', 'current_month'],
    ['last_month', 'previous_month'],
    ['7', 'last_7_days'],
    ['30', 'last_30_days'],
  ])('maps dashboard preset %s to report preset %s', (period, expected) => {
    const search = buildDashboardReportSearch({
      period,
      startDate: new Date(2026, 7, 1),
      endDate: new Date(2026, 7, 27),
    });
    const params = new URLSearchParams(search);

    expect(params.get('period')).toBe(expected);
    expect(params.get('granularity')).toBe('day');
    expect(params.has('from')).toBe(false);
    expect(params.has('to')).toBe(false);
  });

  it('preserves the exact range for dashboard periods without an equivalent preset', () => {
    const search = buildDashboardReportSearch({
      period: 'this_week',
      startDate: new Date(2026, 7, 24),
      endDate: new Date(2026, 7, 27),
    });
    const params = new URLSearchParams(search);

    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBe('2026-08-24');
    expect(params.get('to')).toBe('2026-08-27');
    expect(params.get('granularity')).toBe('day');
  });
});
