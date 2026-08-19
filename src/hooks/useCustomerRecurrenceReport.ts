import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeCrmLeadRow, type CrmLeadRow } from '@/hooks/useCrmLeads';

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
  profile_ref: string;
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
  comparison_mode: CustomerRecurrenceComparisonMode;
  include_companions: boolean;
  page: number;
  page_size: number;
  customers_total: number;
  filtered_customers_total: number;
  min_total_visits: number | null;
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
  minTotalVisits?: number;
  enabled?: boolean;
}

export interface UseCustomerRecurrenceLeadProfileParams {
  companyId: string | undefined;
  profileRef: string | null | undefined;
  expectedPhoneLast4: string | null | undefined;
  enabled?: boolean;
}

export interface CustomerRecurrenceNormalizationContext {
  periodStart: string;
  periodEnd: string;
  comparisonMode: CustomerRecurrenceComparisonMode;
  includeCompanions: boolean;
  page: number;
  pageSize: number;
  minTotalVisits: number | null;
}

export const CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH = 200;
export const CUSTOMER_RECURRENCE_MIN_VISITS_MAX = 1_000_000;
export const CUSTOMER_RECURRENCE_PAGE_SIZE_MAX = 100;

export function normalizeMinimumTotalVisits(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  const normalized = Math.floor(value);
  return normalized >= 1
    ? Math.min(normalized, CUSTOMER_RECURRENCE_MIN_VISITS_MAX)
    : null;
}

export function normalizeCustomerRecurrenceSearch(value: string | null | undefined): string {
  return (value ?? '').trim().slice(0, CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH);
}

function normalizeBoundedInteger(
  value: number | null | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function buildCustomerRecurrenceRpcParams({
  companyId,
  periodStart,
  periodEnd,
  comparisonMode = 'previous_period',
  includeCompanions = false,
  page = 1,
  pageSize = 12,
  search = '',
  minTotalVisits,
}: UseCustomerRecurrenceReportParams) {
  const normalizedPage = normalizeBoundedInteger(page, 1);
  const normalizedPageSize = normalizeBoundedInteger(
    pageSize,
    12,
    CUSTOMER_RECURRENCE_PAGE_SIZE_MAX,
  );
  const normalizedSearch = normalizeCustomerRecurrenceSearch(search);

  return {
    _company_id: companyId,
    _period_start: periodStart,
    _period_end: periodEnd,
    _comparison_mode: comparisonMode,
    _include_companions: includeCompanions,
    _page: normalizedPage,
    _page_size: normalizedPageSize,
    _search: normalizedSearch || null,
    _min_total_visits: normalizeMinimumTotalVisits(minTotalVisits),
  };
}

export function buildCustomerRecurrenceQueryKey(params: UseCustomerRecurrenceReportParams) {
  const rpcParams = buildCustomerRecurrenceRpcParams(params);

  return [
    'customer-recurrence-report',
    rpcParams._company_id,
    rpcParams._period_start,
    rpcParams._period_end,
    rpcParams._comparison_mode,
    rpcParams._include_companions,
    rpcParams._page,
    rpcParams._page_size,
    rpcParams._search ?? '',
    rpcParams._min_total_visits,
  ] as const;
}

export function buildCustomerRecurrenceLeadProfileRpcParams({
  companyId,
  profileRef,
}: UseCustomerRecurrenceLeadProfileParams) {
  return {
    _company_id: companyId,
    _profile_ref: profileRef,
  };
}

export function isSameCustomerRecurrenceDataset(
  previousKey: readonly unknown[] | undefined,
  currentKey: readonly unknown[],
): boolean {
  if (!previousKey) return false;

  return previousKey[1] === currentKey[1]
    && previousKey[2] === currentKey[2]
    && previousKey[3] === currentKey[3]
    && previousKey[4] === currentKey[4]
    && previousKey[5] === currentKey[5]
    && previousKey[7] === currentKey[7]
    && previousKey[8] === currentKey[8]
    && previousKey[9] === currentKey[9];
}

export function resolveCustomerRecurrenceDisplayedPage(requestedPage: number, responsePage?: number): number {
  if (typeof responsePage === 'number' && Number.isFinite(responsePage) && responsePage >= 1) {
    return normalizeBoundedInteger(responsePage, 1);
  }

  return normalizeBoundedInteger(requestedPage, 1);
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

const SUMMARY_COUNT_KEYS = [
  'identified_customers',
  'returning_customers',
  'new_customers',
  'repeated_in_period',
  'additional_visits',
  'period_visits',
] as const;

const SUMMARY_RATE_KEYS = ['recurrence_rate', 'repeat_rate'] as const;

const FREQUENCY_BAND_KEYS = new Set<CustomerFrequencyBandKey>([
  'one',
  'two',
  'three_four',
  'five_plus',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumericValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

function isNonNegativeIntegerValue(value: unknown): boolean {
  return isFiniteNumericValue(value) && Number.isInteger(Number(value)) && Number(value) >= 0;
}

function isPositiveIntegerValue(value: unknown): boolean {
  return isFiniteNumericValue(value) && Number.isInteger(Number(value)) && Number(value) >= 1;
}

function isPercentageValue(value: unknown): boolean {
  return isFiniteNumericValue(value) && Number(value) >= 0 && Number(value) <= 100;
}

function roundTo(value: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function calculatePercentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : roundTo((100 * numerator) / denominator, 1);
}

function isNullableString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'string';
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isNullableIsoDate(value: unknown): boolean {
  return value === null || value === undefined || isIsoDate(value);
}

function invalidReportPayload(): Error {
  return new Error('O relatório de recorrência retornou dados incompletos ou inválidos. Atualize a página e tente novamente.');
}

function assertSummaryPayload(value: unknown): asserts value is Record<string, unknown> {
  if (
    !isRecord(value)
    || SUMMARY_KEYS.some((key) => !isFiniteNumericValue(value[key]))
    || SUMMARY_COUNT_KEYS.some((key) => !isNonNegativeIntegerValue(value[key]))
    || SUMMARY_RATE_KEYS.some((key) => !isPercentageValue(value[key]))
    || Number(value.avg_visits_per_customer) < 0
  ) {
    throw invalidReportPayload();
  }

  const summary = normalizeSummary(value);
  if (
    summary.new_customers + summary.returning_customers !== summary.identified_customers
    || summary.repeated_in_period > summary.identified_customers
    || summary.period_visits !== summary.identified_customers + summary.additional_visits
    || summary.recurrence_rate !== calculatePercentage(
      summary.returning_customers,
      summary.identified_customers,
    )
    || summary.repeat_rate !== calculatePercentage(
      summary.repeated_in_period,
      summary.identified_customers,
    )
    || summary.avg_visits_per_customer !== (
      summary.identified_customers === 0
        ? 0
        : roundTo(summary.period_visits / summary.identified_customers, 2)
    )
  ) throw invalidReportPayload();
}

function assertReportPayload(
  value: Record<string, unknown>,
  context: CustomerRecurrenceNormalizationContext,
): void {
  assertSummaryPayload(value.summary);
  assertSummaryPayload(value.comparison);

  const comparison = value.comparison as Record<string, unknown>;
  const meta = value.meta;
  const expectedPage = normalizeBoundedInteger(context.page, 1);
  const expectedPageSize = normalizeBoundedInteger(
    context.pageSize,
    12,
    CUSTOMER_RECURRENCE_PAGE_SIZE_MAX,
  );
  const expectedMinimum = normalizeMinimumTotalVisits(context.minTotalVisits);

  if (
    !isIsoDate(comparison.period_start)
    || !isIsoDate(comparison.period_end)
    || !Array.isArray(value.frequency_bands)
    || !Array.isArray(value.monthly_composition)
    || !Array.isArray(value.customers)
    || !isRecord(meta)
    || meta.period_start !== context.periodStart
    || meta.period_end !== context.periodEnd
    || meta.comparison_mode !== context.comparisonMode
    || meta.include_companions !== context.includeCompanions
    || !isPositiveIntegerValue(meta.page)
    || Number(meta.page) !== expectedPage
    || !isPositiveIntegerValue(meta.page_size)
    || Number(meta.page_size) !== expectedPageSize
    || !isNonNegativeIntegerValue(meta.customers_total)
    || !isNonNegativeIntegerValue(meta.filtered_customers_total)
    || typeof meta.generated_at !== 'string'
    || meta.generated_at.length === 0
    || !Object.prototype.hasOwnProperty.call(meta, 'min_total_visits')
    || (meta.min_total_visits !== null && !isPositiveIntegerValue(meta.min_total_visits))
    || (
      meta.min_total_visits !== null
      && Number(meta.min_total_visits) > CUSTOMER_RECURRENCE_MIN_VISITS_MAX
    )
    || (meta.min_total_visits === null ? null : Number(meta.min_total_visits)) !== expectedMinimum
  ) {
    throw invalidReportPayload();
  }
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
  if (
    !isRecord(value)
    || !FREQUENCY_BAND_KEYS.has(value.key as CustomerFrequencyBandKey)
    || !isPositiveIntegerValue(value.min_visits)
    || !Object.prototype.hasOwnProperty.call(value, 'max_visits')
    || (value.max_visits !== null && value.max_visits !== undefined && !isPositiveIntegerValue(value.max_visits))
    || !isNonNegativeIntegerValue(value.customers)
    || !isPercentageValue(value.percentage)
  ) {
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
  if (
    !isRecord(value)
    || !isIsoDate(value.month)
    || !isNonNegativeIntegerValue(value.identified_customers)
    || !isNonNegativeIntegerValue(value.new_customers)
    || !isNonNegativeIntegerValue(value.returning_customers)
    || !isPercentageValue(value.recurrence_rate)
  ) return null;

  return {
    month: toStringValue(value.month),
    identified_customers: toNumber(value.identified_customers),
    new_customers: toNumber(value.new_customers),
    returning_customers: toNumber(value.returning_customers),
    recurrence_rate: toNumber(value.recurrence_rate),
  };
}

function normalizeCustomer(value: unknown, index: number): CustomerRecurrenceRow | null {
  if (
    !isRecord(value)
    || !toStringValue(value.customer_key)
    || !/^(reservation_holder|reservation_companion|waitlist_holder|waitlist_companion):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(toStringValue(value.profile_ref))
    || typeof value.phone_normalized !== 'string'
    || !/^\d{4}$/.test(value.phone_normalized)
    || !isNullableString(value.guest_name)
    || !isNullableString(value.guest_phone)
    || !isNullableIsoDate(value.first_visit_date)
    || !isNullableIsoDate(value.last_visit_date)
    || !isNullableIsoDate(value.previous_visit_date)
    || !isNullableIsoDate(value.next_reservation_date)
    || !isFiniteNumericValue(value.prior_visits)
    || !isFiniteNumericValue(value.period_visits)
    || !isFiniteNumericValue(value.total_visits)
    || (value.customer_type !== 'new' && value.customer_type !== 'returning')
    || !FREQUENCY_BAND_KEYS.has(value.frequency_band as CustomerFrequencyBandKey)
  ) return null;

  const priorVisits = toNumber(value.prior_visits);
  const periodVisits = toNumber(value.period_visits);
  const totalVisits = toNumber(value.total_visits);
  const customerType = value.customer_type as RecurrenceCustomerType;
  const frequencyBand = value.frequency_band as CustomerFrequencyBandKey;
  const expectedFrequencyBand: CustomerFrequencyBandKey = totalVisits >= 5
    ? 'five_plus'
    : totalVisits >= 3
      ? 'three_four'
      : totalVisits === 2
        ? 'two'
        : 'one';

  if (
    !Number.isInteger(priorVisits)
    || !Number.isInteger(periodVisits)
    || !Number.isInteger(totalVisits)
    || priorVisits < 0
    || periodVisits < 1
    || totalVisits !== priorVisits + periodVisits
    || customerType !== (priorVisits > 0 ? 'returning' : 'new')
    || frequencyBand !== expectedFrequencyBand
  ) return null;

  const phoneNormalized = toStringValue(value.phone_normalized).replace(/\D/g, '').slice(-4);
  const receivedCustomerKey = toStringValue(value.customer_key);
  if (!receivedCustomerKey) return null;

  const customerKey = /^customer:\d+$/.test(receivedCustomerKey)
    ? receivedCustomerKey
    : `customer:${index + 1}`;

  return {
    customer_key: customerKey,
    profile_ref: toStringValue(value.profile_ref),
    phone_normalized: phoneNormalized,
    guest_name: toNullableString(value.guest_name),
    // Defesa em profundidade: mesmo uma resposta antiga da RPC nao entra no cache
    // do React Query com o telefone completo.
    guest_phone: null,
    first_visit_date: toNullableString(value.first_visit_date),
    last_visit_date: toNullableString(value.last_visit_date),
    previous_visit_date: toNullableString(value.previous_visit_date),
    prior_visits: priorVisits,
    period_visits: periodVisits,
    total_visits: totalVisits,
    customer_type: customerType,
    frequency_band: frequencyBand,
    next_reservation_date: toNullableString(value.next_reservation_date),
  };
}

export function normalizeCustomerRecurrenceReport(
  value: unknown,
  context: CustomerRecurrenceNormalizationContext,
): CustomerRecurrenceReport {
  const unwrapped = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!isRecord(unwrapped)) {
    throw new Error('O relatório de recorrência não retornou dados válidos.');
  }

  assertReportPayload(unwrapped, context);

  const comparisonSource = isRecord(unwrapped.comparison) ? unwrapped.comparison : {};
  const metaSource = isRecord(unwrapped.meta) ? unwrapped.meta : {};

  const frequencyBands = (unwrapped.frequency_bands as unknown[]).map(normalizeFrequencyBand);
  const monthlyComposition = (unwrapped.monthly_composition as unknown[]).map(normalizeMonthlyComposition);
  const customers = (unwrapped.customers as unknown[]).map(normalizeCustomer);

  if (
    frequencyBands.some((band) => !band)
    || monthlyComposition.some((row) => !row)
    || customers.some((customer) => !customer)
  ) {
    throw invalidReportPayload();
  }

  const normalizedPage = normalizeBoundedInteger(
    toNumber(metaSource.page),
    context.page,
  );
  const normalizedPageSize = normalizeBoundedInteger(
    toNumber(metaSource.page_size),
    context.pageSize,
    CUSTOMER_RECURRENCE_PAGE_SIZE_MAX,
  );
  const customersTotal = Math.max(0, Math.floor(toNumber(metaSource.customers_total)));
  const filteredCustomersTotal = Math.max(0, Math.floor(toNumber(metaSource.filtered_customers_total)));
  const normalizedCustomers = customers as CustomerRecurrenceRow[];
  const normalizedFrequencyBands = frequencyBands as CustomerFrequencyBand[];
  const normalizedMonthlyComposition = monthlyComposition as CustomerMonthlyComposition[];
  const summary = normalizeSummary(unwrapped.summary);
  const comparison = normalizeSummary(comparisonSource);
  const expectedPageLength = Math.min(
    normalizedPageSize,
    Math.max(0, filteredCustomersTotal - ((normalizedPage - 1) * normalizedPageSize)),
  );
  const expectedMonths = Array.from({ length: 6 }, (_, index) => {
    const periodEnd = new Date(`${context.periodEnd}T00:00:00.000Z`);
    return new Date(Date.UTC(
      periodEnd.getUTCFullYear(),
      periodEnd.getUTCMonth() - (5 - index),
      1,
    )).toISOString().slice(0, 10);
  });
  const expectedFrequencyBands: Array<{
    key: CustomerFrequencyBandKey;
    min: number;
    max: number | null;
  }> = [
    { key: 'one', min: 1, max: 1 },
    { key: 'two', min: 2, max: 2 },
    { key: 'three_four', min: 3, max: 4 },
    { key: 'five_plus', min: 5, max: null },
  ];

  if (
    filteredCustomersTotal > customersTotal
    || normalizedCustomers.length !== expectedPageLength
    || new Set(normalizedCustomers.map((customer) => customer.customer_key)).size !== normalizedCustomers.length
    || new Set(normalizedCustomers.map((customer) => customer.profile_ref)).size !== normalizedCustomers.length
    || summary.new_customers + summary.returning_customers !== summary.identified_customers
    || comparison.new_customers + comparison.returning_customers !== comparison.identified_customers
    || customersTotal !== summary.identified_customers
    || normalizedFrequencyBands.length !== FREQUENCY_BAND_KEYS.size
    || new Set(normalizedFrequencyBands.map((band) => band.key)).size !== FREQUENCY_BAND_KEYS.size
    || normalizedFrequencyBands.reduce((total, band) => total + band.customers, 0) !== summary.identified_customers
    || normalizedFrequencyBands.some((band, index) => {
      const definition = expectedFrequencyBands[index];
      return band.key !== definition.key
        || band.min_visits !== definition.min
        || band.max_visits !== definition.max
        || band.percentage !== calculatePercentage(band.customers, summary.identified_customers);
    })
    || normalizedMonthlyComposition.length !== expectedMonths.length
    || normalizedMonthlyComposition.some(
      (row, index) => row.month !== expectedMonths[index]
        || row.new_customers + row.returning_customers !== row.identified_customers
        || row.recurrence_rate !== calculatePercentage(
          row.returning_customers,
          row.identified_customers,
        ),
    )
  ) {
    throw invalidReportPayload();
  }

  return {
    summary,
    comparison: {
      ...comparison,
      period_start: toStringValue(comparisonSource.period_start),
      period_end: toStringValue(comparisonSource.period_end),
    },
    frequency_bands: normalizedFrequencyBands,
    monthly_composition: normalizedMonthlyComposition,
    customers: normalizedCustomers,
    meta: {
      period_start: toStringValue(metaSource.period_start, context.periodStart),
      period_end: toStringValue(metaSource.period_end, context.periodEnd),
      comparison_mode: metaSource.comparison_mode as CustomerRecurrenceComparisonMode,
      include_companions: typeof metaSource.include_companions === 'boolean'
        ? metaSource.include_companions
        : context.includeCompanions,
      page: normalizedPage,
      page_size: normalizedPageSize,
      customers_total: customersTotal,
      filtered_customers_total: filteredCustomersTotal,
      min_total_visits: normalizeMinimumTotalVisits(toNumber(metaSource.min_total_visits)),
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
  minTotalVisits,
  enabled = true,
}: UseCustomerRecurrenceReportParams) {
  const normalizedSearch = normalizeCustomerRecurrenceSearch(search);
  const normalizedMinTotalVisits = normalizeMinimumTotalVisits(minTotalVisits);
  const normalizedRequest = {
    companyId,
    periodStart,
    periodEnd,
    comparisonMode,
    includeCompanions,
    page,
    pageSize,
    search: normalizedSearch,
    minTotalVisits: normalizedMinTotalVisits ?? undefined,
  };
  const rpcParams = buildCustomerRecurrenceRpcParams(normalizedRequest);
  const queryKey = buildCustomerRecurrenceQueryKey(normalizedRequest);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const request = (supabase as any).rpc('get_customer_recurrence_report', rpcParams);
      if (typeof request.abortSignal === 'function') request.abortSignal(signal);

      const { data, error } = await request;

      if (error) throw error;

      return normalizeCustomerRecurrenceReport(data, {
        periodStart,
        periodEnd,
        comparisonMode,
        includeCompanions,
        page: rpcParams._page,
        pageSize: rpcParams._page_size,
        minTotalVisits: rpcParams._min_total_visits,
      });
    },
    enabled: enabled && !!companyId && !!periodStart && !!periodEnd,
    placeholderData: (previousData, previousQuery) => {
      return isSameCustomerRecurrenceDataset(previousQuery?.queryKey, queryKey)
        ? previousData
        : undefined;
    },
    staleTime: 30_000,
    retry: 1,
  });
}

export function normalizeCustomerRecurrenceLeadProfile(value: unknown): CrmLeadRow {
  const unwrapped = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const profile = normalizeCrmLeadRow(unwrapped);
  const phoneFromKey = profile?.customer_key.match(/^phone:(\d+)$/)?.[1] ?? null;

  if (
    !profile
    || !phoneFromKey
    || profile.phone_normalized !== phoneFromKey
    || profile.canonical_visit_count < 1
  ) {
    throw new Error('Não foi possível localizar o perfil deste cliente. Atualize a base e tente novamente.');
  }

  return profile;
}

export function useCustomerRecurrenceLeadProfile({
  companyId,
  profileRef,
  expectedPhoneLast4,
  enabled = true,
}: UseCustomerRecurrenceLeadProfileParams) {
  const rpcParams = buildCustomerRecurrenceLeadProfileRpcParams({
    companyId,
    profileRef,
    expectedPhoneLast4,
  });

  return useQuery({
    queryKey: [
      'customer-recurrence-lead-profile',
      rpcParams._company_id,
      rpcParams._profile_ref,
      expectedPhoneLast4,
    ],
    queryFn: async ({ signal }) => {
      const request = (supabase as any).rpc('get_customer_recurrence_lead_profile', rpcParams);
      if (typeof request.abortSignal === 'function') request.abortSignal(signal);

      const { data, error } = await request;
      if (error) throw error;

      const profile = normalizeCustomerRecurrenceLeadProfile(data);
      if (!profile.phone_normalized?.endsWith(expectedPhoneLast4 ?? '')) {
        throw new Error('A base de clientes mudou. Atualize a lista e tente novamente.');
      }

      return profile;
    },
    enabled: enabled
      && !!rpcParams._company_id
      && !!rpcParams._profile_ref
      && /^\d{4}$/.test(expectedPhoneLast4 ?? ''),
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
}
