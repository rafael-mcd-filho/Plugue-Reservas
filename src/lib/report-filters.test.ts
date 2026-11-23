import { describe, expect, it } from 'vitest';
import {
  getPreviousReportDateRange,
  getRecommendedReportGranularity,
  getReportRangeError,
  getReportTodayInTimeZone,
  getReportTimestampRange,
  getReportDateOnlyInTimeZone,
  getReportPeriodDays,
  parseReportDateOnly,
  resolveReportDateRange,
  toReportDateOnlyRange,
} from './report-filters';

describe('report filters', () => {
  const today = new Date(2026, 7, 20, 12);

  it('resolves stable date presets', () => {
    expect(toReportDateOnlyRange(resolveReportDateRange('last_7_days', null, null, today))).toEqual({
      from: '2026-08-14',
      to: '2026-08-20',
    });
    expect(toReportDateOnlyRange(resolveReportDateRange('previous_month', null, null, today))).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('resolves today in the company calendar instead of the browser calendar', () => {
    const instant = new Date('2026-08-20T02:30:00.000Z');

    expect(toReportDateOnlyRange({
      from: getReportTodayInTimeZone('America/Manaus', instant),
      to: getReportTodayInTimeZone('America/Manaus', instant),
    })).toEqual({ from: '2026-08-19', to: '2026-08-19' });
    expect(toReportDateOnlyRange({
      from: getReportTodayInTimeZone('Europe/Lisbon', instant),
      to: getReportTodayInTimeZone('Europe/Lisbon', instant),
    })).toEqual({ from: '2026-08-20', to: '2026-08-20' });
  });

  it('normalizes an inverted custom range', () => {
    const range = resolveReportDateRange(
      'custom',
      new Date(2026, 7, 20),
      new Date(2026, 7, 1),
      today,
    );
    expect(toReportDateOnlyRange(range)).toEqual({ from: '2026-08-01', to: '2026-08-20' });
  });

  it('rejects impossible date-only values and periods over 366 days', () => {
    expect(parseReportDateOnly('2026-02-30')).toBeNull();
    expect(parseReportDateOnly('20/08/2026')).toBeNull();
    expect(getReportRangeError({ from: new Date(2025, 0, 1), to: new Date(2026, 0, 2) })).toContain('366');
  });

  it('builds a comparison range with the same number of days', () => {
    const previous = getPreviousReportDateRange({
      from: new Date(2026, 7, 10),
      to: new Date(2026, 7, 20),
    });
    expect(toReportDateOnlyRange(previous)).toEqual({ from: '2026-07-30', to: '2026-08-09' });
  });

  it('recommends a readable granularity for long ranges', () => {
    expect(getRecommendedReportGranularity({ from: new Date(2026, 7, 1), to: new Date(2026, 7, 20) })).toBe('day');
    expect(getRecommendedReportGranularity({ from: new Date(2026, 4, 1), to: new Date(2026, 7, 20) })).toBe('week');
    expect(getRecommendedReportGranularity({ from: new Date(2026, 0, 1), to: new Date(2026, 7, 20) })).toBe('month');
  });

  it('includes exactly 30 calendar dates in current and preceding windows', () => {
    const current = resolveReportDateRange('last_30_days', null, null, today);
    expect(toReportDateOnlyRange(current)).toEqual({ from: '2026-07-22', to: '2026-08-20' });
    expect(getReportPeriodDays(current)).toBe(30);
    const previous = getPreviousReportDateRange(current);
    expect(toReportDateOnlyRange(previous)).toEqual({ from: '2026-06-22', to: '2026-07-21' });
    expect(getReportPeriodDays(previous)).toBe(30);
  });

  it('builds half-open UTC boundaries including the last fractional second', () => {
    const bounds = getReportTimestampRange({ from: '2026-09-01', to: '2026-09-30' }, 'America/Manaus');
    expect(bounds).toEqual({ from: '2026-09-01T04:00:00.000Z', toExclusive: '2026-10-01T04:00:00.000Z' });
    expect(getReportDateOnlyInTimeZone('2026-10-01T03:59:59.999Z', 'America/Manaus')).toBe('2026-09-30');
    expect(getReportDateOnlyInTimeZone(bounds.toExclusive, 'America/Manaus')).toBe('2026-10-01');
  });

  it.each([
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2018-11-04', 'America/Sao_Paulo', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z'],
  ])('respects daylight transitions at the boundaries of %s in %s', (date, timeZone, from, toExclusive) => {
    expect(getReportTimestampRange({ from: date, to: date }, timeZone)).toEqual({ from, toExclusive });
  });
});
