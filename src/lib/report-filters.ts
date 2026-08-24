import {
  differenceInCalendarDays,
  endOfMonth,
  format,
  isValid,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns';

export const REPORT_MAX_PERIOD_DAYS = 366;

export const REPORT_PERIOD_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'current_month',
  'previous_month',
  'custom',
] as const;

export type ReportPeriodPreset = typeof REPORT_PERIOD_PRESETS[number];
export type ReportGranularity = 'day' | 'week' | 'month';

export interface ReportDateRange {
  from: Date;
  to: Date;
}

export interface ReportDateOnlyRange {
  from: string;
  to: string;
}

export const REPORT_PERIOD_LABELS: Record<ReportPeriodPreset, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  last_7_days: 'Últimos 7 dias',
  last_30_days: 'Últimos 30 dias',
  current_month: 'Mês atual',
  previous_month: 'Mês anterior',
  custom: 'Período personalizado',
};

export const REPORT_GRANULARITY_LABELS: Record<ReportGranularity, string> = {
  day: 'Diária',
  week: 'Semanal',
  month: 'Mensal',
};

export function isReportPeriodPreset(value: string | null): value is ReportPeriodPreset {
  return !!value && (REPORT_PERIOD_PRESETS as readonly string[]).includes(value);
}

export function isReportGranularity(value: string | null): value is ReportGranularity {
  return value === 'day' || value === 'week' || value === 'month';
}

export function parseReportDateOnly(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = parseISO(value);
  if (!isValid(parsed) || format(parsed, 'yyyy-MM-dd') !== value) return null;
  return parsed;
}

export function getReportTodayInTimeZone(
  timeZone: string,
  now = new Date(),
): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);

    if (
      Number.isInteger(year)
      && Number.isInteger(month)
      && Number.isInteger(day)
      && month >= 1
      && month <= 12
      && day >= 1
      && day <= 31
    ) {
      // Noon avoids browser-local DST transitions while the value is handled
      // exclusively as a calendar date by the report filters.
      return new Date(year, month - 1, day, 12, 0, 0, 0);
    }
  } catch {
    // The database validates the IANA identifier. Falling back here keeps a
    // malformed cached context from breaking navigation before the RPC can
    // return its fail-closed validation error.
  }

  return now;
}

export function resolveReportDateRange(
  preset: ReportPeriodPreset,
  customFrom?: Date | null,
  customTo?: Date | null,
  today = new Date(),
): ReportDateRange {
  if (preset === 'today') return { from: today, to: today };

  if (preset === 'yesterday') {
    const yesterday = subDays(today, 1);
    return { from: yesterday, to: yesterday };
  }

  if (preset === 'last_7_days') return { from: subDays(today, 6), to: today };
  if (preset === 'last_30_days') return { from: subDays(today, 29), to: today };
  if (preset === 'current_month') return { from: startOfMonth(today), to: today };

  if (preset === 'previous_month') {
    const previousMonth = subMonths(today, 1);
    return { from: startOfMonth(previousMonth), to: endOfMonth(previousMonth) };
  }

  if (customFrom) {
    const resolvedTo = customTo ?? customFrom;
    return customFrom <= resolvedTo
      ? { from: customFrom, to: resolvedTo }
      : { from: resolvedTo, to: customFrom };
  }

  return { from: subDays(today, 29), to: today };
}

export function getReportPeriodDays(range: ReportDateRange): number {
  return differenceInCalendarDays(range.to, range.from) + 1;
}

export function getReportRangeError(range: ReportDateRange): string | null {
  const days = getReportPeriodDays(range);
  if (days < 1) return 'Selecione um período válido.';
  if (days > REPORT_MAX_PERIOD_DAYS) {
    return `O período pode ter no máximo ${REPORT_MAX_PERIOD_DAYS} dias. O intervalo atual possui ${days} dias.`;
  }
  return null;
}

export function getPreviousReportDateRange(range: ReportDateRange): ReportDateRange {
  const days = getReportPeriodDays(range);
  const to = subDays(range.from, 1);
  return { from: subDays(to, days - 1), to };
}

export function toReportDateOnlyRange(range: ReportDateRange): ReportDateOnlyRange {
  return {
    from: format(range.from, 'yyyy-MM-dd'),
    to: format(range.to, 'yyyy-MM-dd'),
  };
}

export function getRecommendedReportGranularity(range: ReportDateRange): ReportGranularity {
  const days = getReportPeriodDays(range);
  if (days > 120) return 'month';
  if (days > 45) return 'week';
  return 'day';
}
