import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CustomerFrequencyBandKey = 'one' | 'two' | 'three_four' | 'five_plus';
export type RecurrenceCustomerType = 'new' | 'returning';
export type CustomerRecurrenceComparisonMode = 'month_to_date' | 'previous_period';

export interface CustomerRecurrenceSummary {
  identified_customers: number;
  returning_customers: number;
  new_customers: number;
  recurrence_rate: number;
  repeated_in_period: number;
  repeat_rate: number;
  additional_visits: number;
  period_visits: number;
  avg_visits_per_customer: number;
}

export interface CustomerRecurrenceComparison extends CustomerRecurrenceSummary {
  period_start: string;
  period_end: string;
}

export interface CustomerFrequencyBand {
  key: CustomerFrequencyBandKey;
  label: string;
  min_visits: number;
  max_visits: number | null;
  customers: number;
  percentage: number;
}

export interface CustomerMonthlyComposition {
  month: string;
  identified_customers: number;
  new_customers: number;
  returning_customers: number;
  recurrence_rate: number;
}

export interface CustomerRecurrenceRow {
  customer_key: string;
  phone_normalized: string;
  guest_name: string | null;
  guest_phone: string | null;
  first_visit_date: string | null;
  last_visit_date: string | null;
  previous_visit_date: string | null;
  prior_visits: number;
  period_visits: number;
  total_visits: number;
  customer_type: RecurrenceCustomerType;
  frequency_band: CustomerFrequencyBandKey;
  next_reservation_date: string | null;
}

export interface CustomerRecurrenceMeta {
  period_start: string;
  period_end: string;
  include_companions: boolean;
  page: number;
  page_size: number;
  customers_total: number;
  filtered_customers_total: number;
  generated_at: string;
}

export interface CustomerRecurrenceReport {
  summary: CustomerRecurrenceSummary;
  comparison: CustomerRecurrenceComparison;
  frequency_bands: CustomerFrequencyBand[];
  monthly_composition: CustomerMonthlyComposition[];
  customers: CustomerRecurrenceRow[];
  meta: CustomerRecurrenceMeta;
}

export interface UseCustomerRecurrenceReportParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  comparisonMode?: CustomerRecurrenceComparisonMode;
  includeCompanions?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
  enabled?: boolean;
}

const SUMMARY_KEYS = [
  'identified_customers',
  'returning_customers',
  'new_customers',
  'recurrence_rate',
  'repeated_in_period',
  'repeat_rate',
  'additional_visits',
  'period_visits',
  'avg_visits_per_customer',
] as const;

const FREQUENCY_BAND_KEYS = new Set<CustomerFrequencyBandKey>([
  'one',
  'two',
  'three_four',
  'five_plus',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toStringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeSummary(value: unknown): CustomerRecurrenceSummary {
  const source = isRecord(value) ? value : {};
  return SUMMARY_KEYS.reduce((summary, key) => {
    summary[key] = toNumber(source[key]);
    return summary;
  }, {} as CustomerRecurrenceSummary);
}

function normalizeFrequencyBand(value: unknown): CustomerFrequencyBand | null {
  if (!isRecord(value) || !FREQUENCY_BAND_KEYS.has(value.key as CustomerFrequencyBandKey)) {
    return null;
  }

  const key = value.key as CustomerFrequencyBandKey;
  return {
    key,
    label: toStringValue(value.label, key),
    min_visits: toNumber(value.min_visits),
    max_visits: value.max_visits === null || value.max_visits === undefined
      ? null
      : toNumber(value.max_visits),
    customers: toNumber(value.customers),
    percentage: toNumber(value.percentage),
  };
}

function normalizeMonthlyComposition(value: unknown): CustomerMonthlyComposition | null {
  if (!isRecord(value) || !toStringValue(value.month)) return null;

  return {
    month: toStringValue(value.month),
    identified_customers: toNumber(value.identified_customers),
    new_customers: toNumber(value.new_customers),
    returning_customers: toNumber(value.returning_customers),
    recurrence_rate: toNumber(value.recurrence_rate),
  };
}

function normalizeCustomer(value: unknown, index: number): CustomerRecurrenceRow | null {
  if (!isRecord(value)) return null;

  const customerType: RecurrenceCustomerType = value.customer_type === 'returning' ? 'returning' : 'new';
  const frequencyBand = FREQUENCY_BAND_KEYS.has(value.frequency_band as CustomerFrequencyBandKey)
    ? value.frequency_band as CustomerFrequencyBandKey
    : 'one';
  const phoneNormalized = toStringValue(value.phone_normalized).replace(/\D/g, '').slice(-4);
  const receivedCustomerKey = toStringValue(value.customer_key);
  if (!receivedCustomerKey) return null;

  const customerKey = /^customer:\d+$/.test(receivedCustomerKey)
    ? receivedCustomerKey
    : `customer:${index + 1}`;

  return {
    customer_key: customerKey,
    phone_normalized: phoneNormalized,
    guest_name: toNullableString(value.guest_name),
    // Defesa em profundidade: mesmo uma resposta antiga da RPC nao entra no cache
    // do React Query com o telefone completo.
    guest_phone: null,
    first_visit_date: toNullableString(value.first_visit_date),
    last_visit_date: toNullableString(value.last_visit_date),
    previous_visit_date: toNullableString(value.previous_visit_date),
    prior_visits: toNumber(value.prior_visits),
    period_visits: toNumber(value.period_visits),
    total_visits: toNumber(value.total_visits),
    customer_type: customerType,
    frequency_band: frequencyBand,
    next_reservation_date: toNullableString(value.next_reservation_date),
  };
}

export function normalizeCustomerRecurrenceReport(
  value: unknown,
  fallback: Required<Pick<UseCustomerRecurrenceReportParams, 'periodStart' | 'periodEnd' | 'includeCompanions' | 'page' | 'pageSize'>>,
): CustomerRecurrenceReport {
  const unwrapped = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!isRecord(unwrapped)) {
    throw new Error('O relatório de recorrência não retornou dados válidos.');
  }

  const comparisonSource = isRecord(unwrapped.comparison) ? unwrapped.comparison : {};
  const metaSource = isRecord(unwrapped.meta) ? unwrapped.meta : {};

  return {
    summary: normalizeSummary(unwrapped.summary),
    comparison: {
      ...normalizeSummary(comparisonSource),
      period_start: toStringValue(comparisonSource.period_start),
      period_end: toStringValue(comparisonSource.period_end),
    },
    frequency_bands: Array.isArray(unwrapped.frequency_bands)
      ? unwrapped.frequency_bands.map(normalizeFrequencyBand).filter((band): band is CustomerFrequencyBand => !!band)
      : [],
    monthly_composition: Array.isArray(unwrapped.monthly_composition)
      ? unwrapped.monthly_composition.map(normalizeMonthlyComposition).filter((row): row is CustomerMonthlyComposition => !!row)
      : [],
    customers: Array.isArray(unwrapped.customers)
      ? unwrapped.customers.map(normalizeCustomer).filter((row): row is CustomerRecurrenceRow => !!row)
      : [],
    meta: {
      period_start: toStringValue(metaSource.period_start, fallback.periodStart),
      period_end: toStringValue(metaSource.period_end, fallback.periodEnd),
      include_companions: typeof metaSource.include_companions === 'boolean'
        ? metaSource.include_companions
        : fallback.includeCompanions,
      page: Math.max(1, toNumber(metaSource.page) || fallback.page),
      page_size: Math.max(1, toNumber(metaSource.page_size) || fallback.pageSize),
      customers_total: Math.max(0, toNumber(metaSource.customers_total)),
      filtered_customers_total: Math.max(0, toNumber(metaSource.filtered_customers_total)),
      generated_at: toStringValue(metaSource.generated_at),
    },
  };
}

export function useCustomerRecurrenceReport({
  companyId,
  periodStart,
  periodEnd,
  comparisonMode = 'previous_period',
  includeCompanions = false,
  page = 1,
  pageSize = 12,
  search = '',
  enabled = true,
}: UseCustomerRecurrenceReportParams) {
  const normalizedSearch = search.trim();

  return useQuery({
    queryKey: [
      'customer-recurrence-report',
      companyId,
      periodStart,
      periodEnd,
      comparisonMode,
      includeCompanions,
      page,
      pageSize,
      normalizedSearch,
    ],
    queryFn: async ({ signal }) => {
      const request = (supabase as any).rpc('get_customer_recurrence_report', {
        _company_id: companyId,
        _period_start: periodStart,
        _period_end: periodEnd,
        _comparison_mode: comparisonMode,
        _include_companions: includeCompanions,
        _page: page,
        _page_size: pageSize,
        _search: normalizedSearch || null,
      });
      if (typeof request.abortSignal === 'function') request.abortSignal(signal);

      const { data, error } = await request;

      if (error) throw error;

      return normalizeCustomerRecurrenceReport(data, {
        periodStart,
        periodEnd,
        includeCompanions,
        page,
        pageSize,
      });
    },
    enabled: enabled && !!companyId && !!periodStart && !!periodEnd,
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      const isSameDataset = Array.isArray(previousKey)
        && previousKey[1] === companyId
        && previousKey[2] === periodStart
        && previousKey[3] === periodEnd
        && previousKey[4] === comparisonMode
        && previousKey[5] === includeCompanions;

      return isSameDataset ? previousData : undefined;
    },
    staleTime: 30_000,
    retry: 1,
  });
}
