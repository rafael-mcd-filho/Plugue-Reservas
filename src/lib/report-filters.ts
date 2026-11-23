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

export interface ReportTimestampRange {
  from: string;
  toExclusive: string;
}

/** Calendar date at an instant, independent of the browser's time zone. */
export function getReportDateOnlyInTimeZone(value: Date | string, timeZone: string): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(instant.getTime())) throw new Error('Data inválida para o relatório.');
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
}

/**
 * First instant at or after a calendar date in the unit's time zone. Searching
 * the calendar boundary also handles DST changes at midnight and skipped dates.
 */
function getReportDateStartUtc(date: string, timeZone: string): number {
  if (!parseReportDateOnly(date)) throw new Error('Data inválida para o relatório.');
  const center = Date.parse(`${date}T12:00:00Z`);
  let before = center - 48 * 60 * 60 * 1000;
  let after = center + 48 * 60 * 60 * 1000;
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const calendarAt = (instant: number) => {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    return `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`;
  };
  while (before + 1 < after) {
    const middle = Math.floor((before + after) / 2);
    if (calendarAt(middle) < date) before = middle;
    else after = middle;
  }
  return after;
}

/** Inclusive date filters become a UTC [from, next-day) timestamp interval. */
export function getReportTimestampRange(range: ReportDateOnlyRange, timeZone: string): ReportTimestampRange {
  if (!parseReportDateOnly(range.from) || !parseReportDateOnly(range.to) || range.from > range.to) {
    throw new Error('Selecione um intervalo válido para o relatório.');
  }
  const nextDay = new Date(`${range.to}T12:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    from: new Date(getReportDateStartUtc(range.from, timeZone)).toISOString(),
    toExclusive: new Date(getReportDateStartUtc(nextDay.toISOString().slice(0, 10), timeZone)).toISOString(),
  };
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
