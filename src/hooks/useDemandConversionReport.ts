import { useQuery, type QueryKey } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ReportGranularity } from '@/lib/report-filters';
import type { ReservationOriginKey } from '@/lib/reservation-origin';

export const DEMAND_CONVERSION_PAGE_SIZE_MAX = 100;
export const DEMAND_CONVERSION_SEARCH_MAX_LENGTH = 200;

export type DemandConversionEntryFilter = 'all' | ReservationOriginKey;
export type DemandFunnelStep = 'page_view' | 'date_select' | 'time_select' | 'form_fill' | 'completed';

export interface DemandConversionSummary {
  sessions: number;
  completed: number;
  overall_conversion_rate: number;
  created_reservations: number;
  created_people: number;
  average_lead_days: number;
}

export interface DemandFunnelStage {
  step: DemandFunnelStep;
  label: string;
  count: number;
  conversion_from_previous: number;
  conversion_from_start: number;
  dropoff: number;
  dropoff_rate: number;
}

export interface DemandTrendPoint {
  period: string;
  page_views: number;
  date_selections: number;
  time_selections: number;
  forms: number;
  completed: number;
  created_reservations: number;
  created_people: number;
}

export interface DemandTransitionTime {
  key: 'page_to_date' | 'date_to_time' | 'time_to_form' | 'form_to_completed';
  from_label: string;
  to_label: string;
  median_seconds: number;
  sample_size: number;
}

export interface DemandLeadTimeBand {
  key: 'same_day' | 'one_day' | 'two_to_seven' | 'eight_to_fourteen' | 'fifteen_to_thirty' | 'thirty_one_plus';
  label: string;
  reservations: number;
  people: number;
  percentage: number;
}

export interface DemandEntryMode {
  key: ReservationOriginKey;
  label: string;
  reservations: number;
  people: number;
  percentage: number;
}

export interface DemandPartySizeBand {
  key: 'one_two' | 'three_four' | 'five_six' | 'seven_plus';
  label: string;
  reservations: number;
  people: number;
  percentage: number;
}

export interface DemandReservationRow {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  reservation_date: string;
  reservation_time: string;
  party_size: number;
  status: string;
  entry_mode: ReservationOriginKey;
  lead_days: number;
  created_at: string;
  source: string | null;
  origin_affiliate_code: string | null;
  origin_affiliate_name: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  updated_at: string;
  occasion: string | null;
  notes: string | null;
  table_id: string | null;
  created_in_mode: string | null;
  public_tracking_code: string;
}

export interface DemandConversionMeta {
  period_start: string;
  period_end: string;
  time_zone: string;
  unique_only: boolean;
  comparison_enabled: boolean;
  comparison_start: string | null;
  comparison_end: string | null;
  granularity: ReportGranularity;
  page: number;
  page_size: number;
  details_total: number;
  entry_mode: DemandConversionEntryFilter;
  search: string | null;
  generated_at: string;
  funnel_source: 'tracking_funnel_sessions';
}

export interface DemandConversionReport {
  summary: DemandConversionSummary;
  comparison: DemandConversionComparison | null;
  funnel: DemandFunnelStage[];
  trend: DemandTrendPoint[];
  transition_times: DemandTransitionTime[];
  lead_time_bands: DemandLeadTimeBand[];
  entry_modes: DemandEntryMode[];
  party_size_bands: DemandPartySizeBand[];
  details: DemandReservationRow[];
  meta: DemandConversionMeta;
}

export interface DemandConversionComparison {
  period_start: string;
  period_end: string;
  summary: DemandConversionSummary;
  party_size_bands: DemandPartySizeBand[];
}

export interface UseDemandConversionReportParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  uniqueOnly?: boolean;
  comparisonEnabled?: boolean;
  granularity?: ReportGranularity;
  page?: number;
  pageSize?: number;
  search?: string;
  entryMode?: DemandConversionEntryFilter;
  enabled?: boolean;
}

export interface DemandConversionNormalizationContext {
  periodStart: string;
  periodEnd: string;
  uniqueOnly: boolean;
  comparisonEnabled: boolean;
  granularity: ReportGranularity;
  pageSize: number;
  entryMode: DemandConversionEntryFilter;
}

const FUNNEL_STEPS: DemandFunnelStep[] = ['page_view', 'date_select', 'time_select', 'form_fill', 'completed'];
const TRANSITION_KEYS = ['page_to_date', 'date_to_time', 'time_to_form', 'form_to_completed'] as const;
const LEAD_TIME_KEYS = ['same_day', 'one_day', 'two_to_seven', 'eight_to_fourteen', 'fifteen_to_thirty', 'thirty_one_plus'] as const;
const ENTRY_MODE_KEYS: ReservationOriginKey[] = ['online', 'affiliate', 'manual', 'waitlist'];
const PARTY_SIZE_KEYS = ['one_two', 'three_four', 'five_six', 'seven_plus'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function toFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw invalidPayload(`${field} não é numérico.`);
  return parsed;
}

function toCount(value: unknown, field: string): number {
  const parsed = toFiniteNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidPayload(`${field} possui uma contagem inválida.`);
  return parsed;
}

function toRate(value: unknown, field: string): number {
  const parsed = toFiniteNumber(value, field);
  if (parsed < 0 || parsed > 100) throw invalidPayload(`${field} possui uma taxa inválida.`);
  return parsed;
}

function invalidPayload(detail?: string) {
  return new DemandConversionValidationError(
    detail
      ? `O relatório retornou dados inválidos: ${detail}`
      : 'O relatório retornou dados incompletos ou inválidos.',
  );
}

function assertExactKeys<T extends string>(values: T[], expected: readonly T[], field: string) {
  if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) {
    throw invalidPayload(`${field} está incompleto ou fora de ordem.`);
  }
}

export class DemandConversionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemandConversionValidationError';
  }
}

export function normalizeDemandConversionSearch(value: string | null | undefined) {
  return (value ?? '').trim().slice(0, DEMAND_CONVERSION_SEARCH_MAX_LENGTH);
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function buildDemandConversionRpcParams({
  companyId,
  periodStart,
  periodEnd,
  uniqueOnly = false,
  comparisonEnabled = true,
  granularity = 'day',
  page = 1,
  pageSize = 15,
  search = '',
  entryMode = 'all',
}: UseDemandConversionReportParams) {
  const normalizedSearch = normalizeDemandConversionSearch(search);
  return {
    _company_id: companyId,
    _start_date: periodStart,
    _end_date: periodEnd,
    _unique_only: uniqueOnly,
    _include_comparison: comparisonEnabled,
    _granularity: granularity,
    _page: normalizePositiveInteger(page, 1, Number.MAX_SAFE_INTEGER),
    _page_size: normalizePositiveInteger(pageSize, 15, DEMAND_CONVERSION_PAGE_SIZE_MAX),
    _search: normalizedSearch || null,
    _entry_mode: entryMode,
  };
}

export function buildDemandConversionQueryKey(params: UseDemandConversionReportParams) {
  const rpcParams = buildDemandConversionRpcParams(params);
  return [
    'demand-conversion-report',
    rpcParams._company_id,
    rpcParams._start_date,
    rpcParams._end_date,
    rpcParams._unique_only,
    rpcParams._include_comparison,
    rpcParams._granularity,
    rpcParams._page,
    rpcParams._page_size,
    rpcParams._search ?? '',
    rpcParams._entry_mode,
  ] as const;
}

export function isSameDemandConversionDataset(previousKey: QueryKey | undefined, currentKey: QueryKey) {
  if (!previousKey) return false;
  return previousKey[1] === currentKey[1]
    && previousKey[2] === currentKey[2]
    && previousKey[3] === currentKey[3]
    && previousKey[4] === currentKey[4]
    && previousKey[5] === currentKey[5]
    && previousKey[6] === currentKey[6]
    && previousKey[8] === currentKey[8]
    && previousKey[9] === currentKey[9]
    && previousKey[10] === currentKey[10];
}

export function normalizeDemandConversionReport(
  value: unknown,
  context: DemandConversionNormalizationContext,
): DemandConversionReport {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.meta)) throw invalidPayload();
  if (!Array.isArray(value.funnel) || !Array.isArray(value.trend) || !Array.isArray(value.transition_times)
    || !Array.isArray(value.lead_time_bands) || !Array.isArray(value.entry_modes)
    || !Array.isArray(value.party_size_bands) || !Array.isArray(value.details)) {
    throw invalidPayload();
  }

  const summary: DemandConversionSummary = {
    sessions: toCount(value.summary.sessions, 'summary.sessions'),
    completed: toCount(value.summary.completed, 'summary.completed'),
    overall_conversion_rate: toRate(value.summary.overall_conversion_rate, 'summary.overall_conversion_rate'),
    created_reservations: toCount(value.summary.created_reservations, 'summary.created_reservations'),
    created_people: toCount(value.summary.created_people, 'summary.created_people'),
    average_lead_days: toFiniteNumber(value.summary.average_lead_days, 'summary.average_lead_days'),
  };
  if (summary.completed > summary.sessions || summary.average_lead_days < 0) throw invalidPayload('o resumo é inconsistente.');

  const funnel = value.funnel.map((item, index): DemandFunnelStage => {
    if (!isRecord(item) || item.step !== FUNNEL_STEPS[index] || typeof item.label !== 'string') {
      throw invalidPayload('as etapas do funil são inválidas.');
    }
    return {
      step: item.step,
      label: item.label,
      count: toCount(item.count, `funnel[${index}].count`),
      conversion_from_previous: toRate(item.conversion_from_previous, `funnel[${index}].conversion_from_previous`),
      conversion_from_start: toRate(item.conversion_from_start, `funnel[${index}].conversion_from_start`),
      dropoff: toCount(item.dropoff, `funnel[${index}].dropoff`),
      dropoff_rate: toRate(item.dropoff_rate, `funnel[${index}].dropoff_rate`),
    };
  });
  assertExactKeys(funnel.map((item) => item.step), FUNNEL_STEPS, 'o funil');
  if (funnel.some((stage, index) => index > 0 && stage.count > funnel[index - 1].count)) {
    throw invalidPayload('o funil não é monotônico.');
  }
  if (funnel[0].count !== summary.sessions || funnel[4].count !== summary.completed) {
    throw invalidPayload('o funil diverge do resumo.');
  }

  const trend = value.trend.map((item, index): DemandTrendPoint => {
    if (!isRecord(item) || !isIsoDate(item.period)) throw invalidPayload(`trend[${index}] possui período inválido.`);
    return {
      period: item.period,
      page_views: toCount(item.page_views, `trend[${index}].page_views`),
      date_selections: toCount(item.date_selections, `trend[${index}].date_selections`),
      time_selections: toCount(item.time_selections, `trend[${index}].time_selections`),
      forms: toCount(item.forms, `trend[${index}].forms`),
      completed: toCount(item.completed, `trend[${index}].completed`),
      created_reservations: toCount(item.created_reservations, `trend[${index}].created_reservations`),
      created_people: toCount(item.created_people, `trend[${index}].created_people`),
    };
  });
  if (trend.some((point) => point.date_selections > point.page_views
    || point.time_selections > point.date_selections
    || point.forms > point.time_selections
    || point.completed > point.forms)) {
    throw invalidPayload('a série do funil não é monotônica.');
  }
  if (trend.reduce((total, item) => total + item.page_views, 0) !== summary.sessions
    || trend.reduce((total, item) => total + item.completed, 0) !== summary.completed
    || trend.reduce((total, item) => total + item.created_reservations, 0) !== summary.created_reservations) {
    throw invalidPayload('a série diverge dos totais.');
  }

  const transitionTimes = value.transition_times.map((item, index): DemandTransitionTime => {
    if (!isRecord(item) || item.key !== TRANSITION_KEYS[index]
      || typeof item.from_label !== 'string' || typeof item.to_label !== 'string') {
      throw invalidPayload('os tempos entre etapas são inválidos.');
    }
    return {
      key: item.key as DemandTransitionTime['key'],
      from_label: item.from_label,
      to_label: item.to_label,
      median_seconds: toCount(item.median_seconds, `transition_times[${index}].median_seconds`),
      sample_size: toCount(item.sample_size, `transition_times[${index}].sample_size`),
    };
  });
  assertExactKeys(transitionTimes.map((item) => item.key), TRANSITION_KEYS, 'os tempos entre etapas');

  const leadTimeBands = value.lead_time_bands.map((item, index): DemandLeadTimeBand => {
    if (!isRecord(item) || item.key !== LEAD_TIME_KEYS[index] || typeof item.label !== 'string') {
      throw invalidPayload('as faixas de antecedência são inválidas.');
    }
    return {
      key: item.key,
      label: item.label,
      reservations: toCount(item.reservations, `lead_time_bands[${index}].reservations`),
      people: toCount(item.people, `lead_time_bands[${index}].people`),
      percentage: toRate(item.percentage, `lead_time_bands[${index}].percentage`),
    };
  });
  assertExactKeys(leadTimeBands.map((item) => item.key), LEAD_TIME_KEYS, 'as faixas de antecedência');
  if (leadTimeBands.reduce((total, item) => total + item.reservations, 0) !== summary.created_reservations) {
    throw invalidPayload('as faixas de antecedência divergem do total.');
  }

  const entryModes = value.entry_modes.map((item, index): DemandEntryMode => {
    if (!isRecord(item) || item.key !== ENTRY_MODE_KEYS[index] || typeof item.label !== 'string') {
      throw invalidPayload('as formas de entrada são inválidas.');
    }
    return {
      key: item.key,
      label: item.label,
      reservations: toCount(item.reservations, `entry_modes[${index}].reservations`),
      people: toCount(item.people, `entry_modes[${index}].people`),
      percentage: toRate(item.percentage, `entry_modes[${index}].percentage`),
    };
  });
  assertExactKeys(entryModes.map((item) => item.key), ENTRY_MODE_KEYS, 'as formas de entrada');
  if (context.entryMode === 'all'
    && entryModes.reduce((total, item) => total + item.reservations, 0) !== summary.created_reservations) {
    throw invalidPayload('as formas de entrada divergem do total.');
  }

  const partySizeBands = value.party_size_bands.map((item, index): DemandPartySizeBand => {
    if (!isRecord(item) || item.key !== PARTY_SIZE_KEYS[index] || typeof item.label !== 'string') {
      throw invalidPayload('as faixas de tamanho dos grupos são inválidas.');
    }
    return {
      key: item.key as DemandPartySizeBand['key'],
      label: item.label,
      reservations: toCount(item.reservations, `party_size_bands[${index}].reservations`),
      people: toCount(item.people, `party_size_bands[${index}].people`),
      percentage: toRate(item.percentage, `party_size_bands[${index}].percentage`),
    };
  });
  assertExactKeys(partySizeBands.map((item) => item.key), PARTY_SIZE_KEYS, 'as faixas de tamanho dos grupos');
  if (partySizeBands.reduce((total, item) => total + item.reservations, 0) !== summary.created_reservations
    || partySizeBands.reduce((total, item) => total + item.people, 0) !== summary.created_people) {
    throw invalidPayload('as faixas de tamanho dos grupos divergem dos totais.');
  }

  let comparison: DemandConversionComparison | null = null;
  if (context.comparisonEnabled) {
    if (!isRecord(value.comparison) || !isRecord(value.comparison.summary)
      || !Array.isArray(value.comparison.party_size_bands)
      || !isIsoDate(value.comparison.period_start) || !isIsoDate(value.comparison.period_end)) {
      throw invalidPayload('a comparação está incompleta.');
    }
    const comparisonSummary: DemandConversionSummary = {
      sessions: toCount(value.comparison.summary.sessions, 'comparison.summary.sessions'),
      completed: toCount(value.comparison.summary.completed, 'comparison.summary.completed'),
      overall_conversion_rate: toRate(value.comparison.summary.overall_conversion_rate, 'comparison.summary.overall_conversion_rate'),
      created_reservations: toCount(value.comparison.summary.created_reservations, 'comparison.summary.created_reservations'),
      created_people: toCount(value.comparison.summary.created_people, 'comparison.summary.created_people'),
      average_lead_days: toFiniteNumber(value.comparison.summary.average_lead_days, 'comparison.summary.average_lead_days'),
    };
    if (comparisonSummary.completed > comparisonSummary.sessions || comparisonSummary.average_lead_days < 0) {
      throw invalidPayload('o resumo da comparação é inconsistente.');
    }
    const comparisonPartySizeBands = value.comparison.party_size_bands.map((item, index): DemandPartySizeBand => {
      if (!isRecord(item) || item.key !== PARTY_SIZE_KEYS[index] || typeof item.label !== 'string') {
        throw invalidPayload('as faixas de grupos da comparação são inválidas.');
      }
      return {
        key: item.key as DemandPartySizeBand['key'],
        label: item.label,
        reservations: toCount(item.reservations, `comparison.party_size_bands[${index}].reservations`),
        people: toCount(item.people, `comparison.party_size_bands[${index}].people`),
        percentage: toRate(item.percentage, `comparison.party_size_bands[${index}].percentage`),
      };
    });
    assertExactKeys(comparisonPartySizeBands.map((item) => item.key), PARTY_SIZE_KEYS, 'as faixas de grupos da comparação');
    if (comparisonPartySizeBands.reduce((total, item) => total + item.reservations, 0) !== comparisonSummary.created_reservations
      || comparisonPartySizeBands.reduce((total, item) => total + item.people, 0) !== comparisonSummary.created_people) {
      throw invalidPayload('as faixas de grupos da comparação divergem dos totais.');
    }
    comparison = {
      period_start: value.comparison.period_start,
      period_end: value.comparison.period_end,
      summary: comparisonSummary,
      party_size_bands: comparisonPartySizeBands,
    };
  } else if (value.comparison !== null) {
    throw invalidPayload('a comparação deveria estar desativada.');
  }

  const details = value.details.map((item, index) => normalizeReservationRow(item, `details[${index}]`));

  const meta: DemandConversionMeta = {
    period_start: String(value.meta.period_start ?? ''),
    period_end: String(value.meta.period_end ?? ''),
    time_zone: String(value.meta.time_zone ?? ''),
    unique_only: value.meta.unique_only === true,
    comparison_enabled: value.meta.comparison_enabled === true,
    comparison_start: value.meta.comparison_start === null ? null : String(value.meta.comparison_start),
    comparison_end: value.meta.comparison_end === null ? null : String(value.meta.comparison_end),
    granularity: value.meta.granularity as ReportGranularity,
    page: toCount(value.meta.page, 'meta.page'),
    page_size: toCount(value.meta.page_size, 'meta.page_size'),
    details_total: toCount(value.meta.details_total, 'meta.details_total'),
    entry_mode: value.meta.entry_mode as DemandConversionEntryFilter,
    search: value.meta.search === null ? null : String(value.meta.search),
    generated_at: String(value.meta.generated_at ?? ''),
    funnel_source: value.meta.funnel_source as 'tracking_funnel_sessions',
  };
  if (!isIsoDate(meta.period_start) || !isIsoDate(meta.period_end)
    || meta.period_start !== context.periodStart || meta.period_end !== context.periodEnd
    || meta.unique_only !== context.uniqueOnly || meta.comparison_enabled !== context.comparisonEnabled
    || (context.comparisonEnabled && (!isIsoDate(meta.comparison_start) || !isIsoDate(meta.comparison_end)))
    || (!context.comparisonEnabled && (meta.comparison_start !== null || meta.comparison_end !== null))
    || meta.granularity !== context.granularity
    || meta.page < 1 || meta.page_size !== context.pageSize || meta.details_total < details.length
    || meta.entry_mode !== context.entryMode || !meta.time_zone || !isTimestamp(meta.generated_at)
    || meta.funnel_source !== 'tracking_funnel_sessions') {
    throw invalidPayload('os metadados não correspondem à consulta.');
  }

  return {
    summary,
    comparison,
    funnel,
    trend,
    transition_times: transitionTimes,
    lead_time_bands: leadTimeBands,
    entry_modes: entryModes,
    party_size_bands: partySizeBands,
    details,
    meta,
  };
}

function normalizeReservationRow(value: unknown, field: string): DemandReservationRow {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.guest_name !== 'string'
    || typeof value.guest_phone !== 'string' || !isNullableString(value.guest_email)
    || !isIsoDate(value.reservation_date) || typeof value.reservation_time !== 'string'
    || typeof value.status !== 'string' || !ENTRY_MODE_KEYS.includes(value.entry_mode as ReservationOriginKey)
    || !isTimestamp(value.created_at) || !isNullableString(value.source)
    || !isNullableString(value.origin_affiliate_code) || !isNullableString(value.origin_affiliate_name)
    || !isNullableString(value.checked_in_at) || !isTimestamp(value.updated_at)
    || !isNullableString(value.occasion) || !isNullableString(value.notes)
    || !isNullableString(value.table_id) || !isNullableString(value.created_in_mode)
    || typeof value.public_tracking_code !== 'string'
    || (value.checked_in_at !== null && !isTimestamp(value.checked_in_at))) {
    throw invalidPayload(`${field} é inválido.`);
  }
  const checkedInPartySize = value.checked_in_party_size === null
    ? null
    : toCount(value.checked_in_party_size, `${field}.checked_in_party_size`);
  return {
    id: value.id,
    guest_name: value.guest_name,
    guest_phone: value.guest_phone,
    guest_email: value.guest_email,
    reservation_date: value.reservation_date,
    reservation_time: value.reservation_time,
    party_size: toCount(value.party_size, `${field}.party_size`),
    status: value.status,
    entry_mode: value.entry_mode as ReservationOriginKey,
    lead_days: toCount(value.lead_days, `${field}.lead_days`),
    created_at: value.created_at,
    source: value.source,
    origin_affiliate_code: value.origin_affiliate_code,
    origin_affiliate_name: value.origin_affiliate_name,
    checked_in_at: value.checked_in_at,
    checked_in_party_size: checkedInPartySize,
    updated_at: value.updated_at,
    occasion: value.occasion,
    notes: value.notes,
    table_id: value.table_id,
    created_in_mode: value.created_in_mode,
    public_tracking_code: value.public_tracking_code,
  };
}

function getErrorDescriptor(error: unknown) {
  const candidate = isRecord(error) ? error : {};
  const code = String(candidate.code ?? '').toUpperCase();
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const name = String(candidate.name ?? '');
  const text = [candidate.message, candidate.details, error].filter(Boolean).map(String).join(' ').toLowerCase();
  return { code, status, name, text };
}

export function shouldRetryDemandConversion(failureCount: number, error: unknown) {
  if (failureCount >= 1 || error instanceof DemandConversionValidationError) return false;
  const { code, status, name, text } = getErrorDescriptor(error);
  return !(code === '57014' || code === '42501' || status === 401 || status === 403
    || name === 'AbortError' || text.includes('timeout') || text.includes('jwt')
    || text.includes('permission denied'));
}

export function getDemandConversionErrorMessage(error: unknown) {
  if (error instanceof DemandConversionValidationError) return error.message;
  const { code, status, text } = getErrorDescriptor(error);
  if (code === '57014' || code === 'PGRST003' || text.includes('timeout')) {
    return 'A consulta demorou mais que o esperado. Tente novamente em alguns instantes.';
  }
  if (code === '55000' || text.includes('funil analítico ainda está sendo preparado')) {
    return 'Os dados do funil ainda estão sendo preparados. Tente novamente em alguns instantes.';
  }
  if (status === 401 || text.includes('jwt')) return 'Sua sessão precisa ser renovada para carregar este relatório.';
  if (status === 403 || code === '42501' || text.includes('permission denied')) {
    return 'Você não tem permissão para consultar este relatório.';
  }
  return 'Não foi possível carregar Demanda & Conversão agora.';
}

export function useDemandConversionReport(params: UseDemandConversionReportParams) {
  const rpcParams = buildDemandConversionRpcParams(params);
  const queryKey = buildDemandConversionQueryKey(params);

  return useQuery<DemandConversionReport>({
    queryKey,
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_demand_conversion_report', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeDemandConversionReport(data, {
        periodStart: rpcParams._start_date,
        periodEnd: rpcParams._end_date,
        uniqueOnly: rpcParams._unique_only,
        comparisonEnabled: rpcParams._include_comparison,
        granularity: rpcParams._granularity,
        pageSize: rpcParams._page_size,
        entryMode: rpcParams._entry_mode,
      });
    },
    enabled: (params.enabled ?? true) && !!rpcParams._company_id && !!rpcParams._start_date && !!rpcParams._end_date,
    placeholderData: (previousData, previousQuery) => (
      previousData && isSameDemandConversionDataset(previousQuery?.queryKey, queryKey)
        ? previousData
        : undefined
    ),
    retry: shouldRetryDemandConversion,
    retryDelay: 750,
    staleTime: 2 * 60 * 1000,
  });
}
