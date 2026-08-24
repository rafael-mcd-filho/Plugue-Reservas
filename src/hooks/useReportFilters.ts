import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DateRange } from 'react-day-picker';
import {
  getPreviousReportDateRange,
  getRecommendedReportGranularity,
  getReportRangeError,
  getReportTodayInTimeZone,
  isReportGranularity,
  isReportPeriodPreset,
  parseReportDateOnly,
  resolveReportDateRange,
  toReportDateOnlyRange,
  type ReportDateRange,
  type ReportGranularity,
  type ReportPeriodPreset,
} from '@/lib/report-filters';

export interface ReportFilterState {
  periodPreset: ReportPeriodPreset;
  range: ReportDateRange;
  dateRange: DateRange;
  dateOnlyRange: { from: string; to: string };
  comparisonRange: ReportDateRange | null;
  comparisonDateOnlyRange: { from: string; to: string } | null;
  granularity: ReportGranularity;
  comparisonEnabled: boolean;
  rangeError: string | null;
  setPeriodPreset: (preset: ReportPeriodPreset) => void;
  setDateRange: (range: DateRange | undefined) => void;
  setGranularity: (granularity: ReportGranularity) => void;
  setComparisonEnabled: (enabled: boolean) => void;
}

interface UseReportFiltersOptions {
  defaultPreset?: ReportPeriodPreset;
  defaultComparisonEnabled?: boolean;
  timeZone?: string;
}

export function useReportFilters({
  defaultPreset = 'last_30_days',
  defaultComparisonEnabled = true,
  timeZone = 'America/Fortaleza',
}: UseReportFiltersOptions = {}): ReportFilterState {
  const [searchParams, setSearchParams] = useSearchParams();
  const periodParam = searchParams.get('period');
  const periodPreset = isReportPeriodPreset(periodParam) ? periodParam : defaultPreset;
  const customFromParam = searchParams.get('from');
  const customToParam = searchParams.get('to');

  const reportToday = useMemo(() => getReportTodayInTimeZone(timeZone), [timeZone]);
  const range = useMemo(
    () => resolveReportDateRange(
      periodPreset,
      parseReportDateOnly(customFromParam),
      parseReportDateOnly(customToParam),
      reportToday,
    ),
    [customFromParam, customToParam, periodPreset, reportToday],
  );
  const dateOnlyRange = useMemo(() => toReportDateOnlyRange(range), [range]);
  const rangeError = useMemo(() => getReportRangeError(range), [range]);
  const granularityParam = searchParams.get('granularity');
  const granularity = isReportGranularity(granularityParam)
    ? granularityParam
    : getRecommendedReportGranularity(range);
  const comparisonParam = searchParams.get('compare');
  const comparisonEnabled = comparisonParam === null
    ? defaultComparisonEnabled
    : comparisonParam !== '0';
  const comparisonRange = comparisonEnabled ? getPreviousReportDateRange(range) : null;
  const comparisonDateOnlyRange = comparisonRange ? toReportDateOnlyRange(comparisonRange) : null;

  const updateSearchParams = useCallback((update: (next: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      update(next);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setPeriodPreset = useCallback((preset: ReportPeriodPreset) => {
    updateSearchParams((next) => {
      next.set('period', preset);
      if (preset !== 'custom') {
        next.delete('from');
        next.delete('to');
      } else if (!next.get('from')) {
        next.set('from', dateOnlyRange.from);
        next.set('to', dateOnlyRange.to);
      }
    });
  }, [dateOnlyRange.from, dateOnlyRange.to, updateSearchParams]);

  const setDateRange = useCallback((nextRange: DateRange | undefined) => {
    if (!nextRange?.from) return;
    const normalized = resolveReportDateRange('custom', nextRange.from, nextRange.to);
    const nextDateOnly = toReportDateOnlyRange(normalized);
    updateSearchParams((next) => {
      next.set('period', 'custom');
      next.set('from', nextDateOnly.from);
      next.set('to', nextDateOnly.to);
    });
  }, [updateSearchParams]);

  const setGranularity = useCallback((nextGranularity: ReportGranularity) => {
    updateSearchParams((next) => next.set('granularity', nextGranularity));
  }, [updateSearchParams]);

  const setComparisonEnabled = useCallback((enabled: boolean) => {
    updateSearchParams((next) => next.set('compare', enabled ? '1' : '0'));
  }, [updateSearchParams]);

  return {
    periodPreset,
    range,
    dateRange: { from: range.from, to: range.to },
    dateOnlyRange,
    comparisonRange,
    comparisonDateOnlyRange,
    granularity,
    comparisonEnabled,
    rangeError,
    setPeriodPreset,
    setDateRange,
    setGranularity,
    setComparisonEnabled,
  };
}
