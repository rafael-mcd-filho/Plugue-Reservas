import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CrmLeadRecordSource =
  | 'reservation_holder'
  | 'reservation_companion'
  | 'waitlist_holder'
  | 'waitlist_companion';

export type CrmLeadSource =
  | CrmLeadRecordSource
  | 'mixed'
  | 'imported';

export type CrmLeadMatchedSource = CrmLeadSource | 'companion';

export type CrmLeadVisitOrigin = 'reservation' | 'waitlist';

export interface CrmLeadImportMetadata {
  id: string;
  notes: string | null;
  imported_at: string | null;
  imported_by_user_id: string | null;
  import_filename: string | null;
}

export interface CrmLeadRow {
  customer_key: string;
  phone_normalized: string | null;
  display_phone: string | null;
  latest_name: string;
  latest_email: string | null;
  latest_birthdate: string | null;
  first_seen_at: string;
  last_visit_date: string | null;
  last_visit_time: string | null;
  state_code: string | null;
  state_name: string | null;
  source: CrmLeadSource;
  canonical_visit_count: number;
  crm_lead: CrmLeadImportMetadata | null;
}

export interface CrmLeadStateOption {
  code: string;
  name: string;
}

export interface CrmLeadsPageMeta {
  page: number;
  page_size: number;
  total_leads: number;
  filtered_leads: number;
  total_records: number;
  filtered_records: number;
  total_canonical_visits: number;
  filtered_canonical_visits: number;
  total_import_only_leads: number;
  filtered_import_only_leads: number;
  generated_at: string;
}

export interface CrmLeadsPage {
  leads: CrmLeadRow[];
  states: CrmLeadStateOption[];
  meta: CrmLeadsPageMeta;
}

export interface CrmLeadPresenceVisit {
  id: string;
  visit_id: string;
  created_at: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  occasion: string | null;
  lead_source: CrmLeadRecordSource;
  visit_origin: CrmLeadVisitOrigin;
  origin_waitlist_id: string | null;
  reservation_holder_name: string | null;
}

export interface CrmLeadPresenceHistoryMeta {
  page: number;
  page_size: number;
  total_visits: number;
}

export interface CrmLeadPresenceHistory {
  customer_key: string;
  visits: CrmLeadPresenceVisit[];
  meta: CrmLeadPresenceHistoryMeta;
}

export interface CrmLeadsPageParams {
  companyId: string | undefined;
  page?: number;
  pageSize?: number;
  search?: string;
  createdFrom?: string | null;
  createdTo?: string | null;
  stateCode?: string | null;
  birthdayMonth?: number | null;
  minVisits?: number | null;
  maxVisits?: number | null;
  enabled?: boolean;
}

export interface CrmLeadPresenceHistoryParams {
  companyId: string | undefined;
  customerKey: string | null | undefined;
  expectedVisitCount?: number | null;
  enabled?: boolean;
}

export interface CrmLeadsCanonicalExportParams {
  companyId: string | undefined;
  createdFrom?: string | null;
  createdTo?: string | null;
  stateCode?: string | null;
  birthdayMonth?: number | null;
  visitFrom?: string | null;
  visitTo?: string | null;
  enabled?: boolean;
}

export interface CrmLeadCanonicalExportItem {
  lead: CrmLeadRow;
  visits: CrmLeadPresenceVisit[];
  matchedSource: CrmLeadMatchedSource;
}

export interface CrmLeadsCanonicalExport {
  items: CrmLeadCanonicalExportItem[];
  scanned_leads: number;
}

export type CrmLeadExportRowKind = 'presence' | 'lead_only';

export interface CrmLeadExportRow extends CrmLeadRow {
  row_key: string;
  row_kind: CrmLeadExportRowKind;
  matched_visit_count: number;
  matched_source: CrmLeadMatchedSource;
  last_matched_visit_date: string | null;
  last_matched_visit_time: string | null;
  last_matched_visit_at: string | null;
  visit: CrmLeadPresenceVisit | null;
}

export interface CrmLeadsExportPageMeta {
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
  filtered_leads: number;
  matched_visits: number;
  has_more: boolean;
  visit_filter_applied: boolean;
  generated_at: string;
}

export interface CrmLeadsExportPage {
  rows: CrmLeadExportRow[];
  meta: CrmLeadsExportPageMeta;
}

const CRM_LEAD_SOURCES = new Set<CrmLeadSource>([
  'reservation_holder',
  'reservation_companion',
  'waitlist_holder',
  'waitlist_companion',
  'mixed',
  'imported',
]);

const CRM_LEAD_MATCHED_SOURCES = new Set<CrmLeadMatchedSource>([
  ...CRM_LEAD_SOURCES,
  'companion',
]);

const CRM_LEAD_VISIT_SOURCES = new Set<CrmLeadPresenceVisit['lead_source']>([
  'reservation_holder',
  'reservation_companion',
  'waitlist_holder',
  'waitlist_companion',
]);

const CRM_LEAD_HISTORY_PAGE_SIZE = 100;
export const CRM_VISITS_FILTER_MAX = 1_000_000;

type CrmLeadsPageQueryKey = readonly [
  'crm-leads-page',
  string | undefined,
  number,
  number,
  string,
  string | null,
  string | null,
  string | null,
  number | null,
  number | null,
  number | null,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapRpcJson(value: unknown) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function toNullableString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRequiredInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null;

  const rawValue = source[key];
  if (
    (typeof rawValue !== 'number' && typeof rawValue !== 'string')
    || (typeof rawValue === 'string' && rawValue.trim() === '')
  ) {
    return null;
  }

  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function readRequiredBoolean(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] === 'boolean'
    ? source[key]
    : null;
}

function readRequiredString(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key)
    && typeof source[key] === 'string'
    && source[key].length > 0
    ? source[key]
    : null;
}

function isValidIsoCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysByMonth[month - 1];
}

function isValidIsoTimestamp(value: string) {
  const datePrefix = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
  return !!datePrefix
    && isValidIsoCalendarDate(datePrefix[1])
    && Number.isFinite(Date.parse(value));
}

function isValidClockTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value);
}

function expectedPageLength(page: number, pageSize: number, total: number) {
  const remaining = total - ((page - 1) * pageSize);
  return Math.min(pageSize, Math.max(0, remaining));
}

export function normalizeCrmVisitsFilter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(CRM_VISITS_FILTER_MAX, Math.max(0, Math.floor(value)));
}

export function normalizeCrmVisitsFilterInput(value: string) {
  if (value.trim() === '') return '';

  const parsed = Number(value);
  const normalized = normalizeCrmVisitsFilter(parsed);
  return normalized === null ? '' : String(normalized);
}

export function normalizeCrmLeadsSearch(value: string | null | undefined) {
  return (value ?? '').trim().slice(0, 200);
}

export function getCrmVisitsFilterRangeError(
  minVisits: number | null,
  maxVisits: number | null,
) {
  return minVisits !== null && maxVisits !== null && maxVisits < minVisits
    ? 'O máximo de visitas deve ser maior ou igual ao mínimo.'
    : null;
}

export function buildCrmLeadsPageQueryKey({
  companyId,
  page = 1,
  pageSize = 25,
  search = '',
  createdFrom = null,
  createdTo = null,
  stateCode = null,
  birthdayMonth = null,
  minVisits = null,
  maxVisits = null,
}: CrmLeadsPageParams): CrmLeadsPageQueryKey {
  return [
    'crm-leads-page',
    companyId,
    Math.max(1, Math.floor(page)),
    Math.min(100, Math.max(1, Math.floor(pageSize))),
    normalizeCrmLeadsSearch(search),
    createdFrom,
    createdTo,
    stateCode,
    birthdayMonth,
    normalizeCrmVisitsFilter(minVisits),
    normalizeCrmVisitsFilter(maxVisits),
  ];
}

export function isSameCrmLeadsDataset(
  previousKey: readonly unknown[] | undefined,
  currentKey: readonly unknown[],
) {
  if (previousKey?.[0] !== 'crm-leads-page' || currentKey[0] !== 'crm-leads-page') {
    return false;
  }

  return previousKey[1] === currentKey[1]
    && previousKey[3] === currentKey[3]
    && previousKey[4] === currentKey[4]
    && previousKey[5] === currentKey[5]
    && previousKey[6] === currentKey[6]
    && previousKey[7] === currentKey[7]
    && previousKey[8] === currentKey[8]
    && previousKey[9] === currentKey[9]
    && previousKey[10] === currentKey[10];
}

export function resolveCrmLeadsDisplayedPage(requestedPage: number, responsePage?: number) {
  const normalizedResponsePage = Math.floor(responsePage ?? 0);
  return normalizedResponsePage >= 1
    ? normalizedResponsePage
    : Math.max(1, Math.floor(requestedPage));
}

function normalizeCrmLeadImportMetadata(value: unknown): CrmLeadImportMetadata | null {
  if (!isRecord(value)) return null;

  const id = toStringValue(value.id);
  if (!id) return null;

  return {
    id,
    notes: toNullableString(value.notes),
    imported_at: toNullableString(value.imported_at),
    imported_by_user_id: toNullableString(value.imported_by_user_id),
    import_filename: toNullableString(value.import_filename),
  };
}

function normalizeCrmLeadRow(value: unknown): CrmLeadRow | null {
  if (!isRecord(value)) return null;

  const customerKey = toStringValue(value.customer_key);
  const canonicalVisitCount = readRequiredInteger(value, 'canonical_visit_count', 0);
  const firstSeenAt = readRequiredString(value, 'first_seen_at');
  const birthdateValue = value.latest_birthdate;
  const hasValidBirthdate = birthdateValue === null
    || birthdateValue === undefined
    || (typeof birthdateValue === 'string' && isValidIsoCalendarDate(birthdateValue));
  if (
    !customerKey
    || canonicalVisitCount === null
    || firstSeenAt === null
    || !isValidIsoTimestamp(firstSeenAt)
    || !hasValidBirthdate
  ) return null;

  const crmLead = normalizeCrmLeadImportMetadata(value.crm_lead);
  const receivedSource = toStringValue(value.source) as CrmLeadSource;

  return {
    customer_key: customerKey,
    phone_normalized: toNullableString(value.phone_normalized),
    display_phone: toNullableString(value.display_phone),
    latest_name: toStringValue(value.latest_name, 'Lead sem nome') || 'Lead sem nome',
    latest_email: toNullableString(value.latest_email),
    latest_birthdate: typeof birthdateValue === 'string' ? birthdateValue : null,
    first_seen_at: firstSeenAt,
    last_visit_date: toNullableString(value.last_visit_date),
    last_visit_time: toNullableString(value.last_visit_time),
    state_code: toNullableString(value.state_code),
    state_name: toNullableString(value.state_name),
    source: CRM_LEAD_SOURCES.has(receivedSource)
      ? receivedSource
      : crmLead
        ? 'imported'
        : 'mixed',
    canonical_visit_count: canonicalVisitCount,
    crm_lead: crmLead,
  };
}

function normalizeCrmLeadStateOption(value: unknown): CrmLeadStateOption | null {
  if (!isRecord(value)) return null;

  const code = toStringValue(value.code).toUpperCase();
  const name = toStringValue(value.name);
  if (!code || !name) return null;

  return { code, name };
}

export function normalizeCrmLeadsPage(
  value: unknown,
  fallback: { page: number; pageSize: number },
): CrmLeadsPage {
  const source = unwrapRpcJson(value);
  if (!isRecord(source)) {
    throw new Error('A base de leads não retornou dados válidos.');
  }

  if (!Array.isArray(source.leads) || !Array.isArray(source.states) || !isRecord(source.meta)) {
    throw new Error('A base de leads não retornou a lista paginada esperada.');
  }

  const meta = source.meta;
  const rawLeads = source.leads;
  const seenCustomerKeys = new Set<string>();
  const leads: CrmLeadRow[] = [];

  for (const rawLead of rawLeads) {
    const lead = normalizeCrmLeadRow(rawLead);
    if (!lead || seenCustomerKeys.has(lead.customer_key)) {
      throw new Error('A base de leads retornou uma página incompleta ou duplicada.');
    }

    seenCustomerKeys.add(lead.customer_key);
    leads.push(lead);
  }

  const page = readRequiredInteger(meta, 'page', 1);
  const pageSize = readRequiredInteger(meta, 'page_size', 1);
  const totalLeads = readRequiredInteger(meta, 'total_leads', 0);
  const filteredLeads = readRequiredInteger(meta, 'filtered_leads', 0);
  const totalRecords = readRequiredInteger(meta, 'total_records', 0);
  const filteredRecords = readRequiredInteger(meta, 'filtered_records', 0);
  const totalCanonicalVisits = readRequiredInteger(meta, 'total_canonical_visits', 0);
  const filteredCanonicalVisits = readRequiredInteger(meta, 'filtered_canonical_visits', 0);
  const totalImportOnlyLeads = readRequiredInteger(meta, 'total_import_only_leads', 0);
  const filteredImportOnlyLeads = readRequiredInteger(meta, 'filtered_import_only_leads', 0);
  const generatedAt = readRequiredString(meta, 'generated_at');

  if (
    page === null
    || pageSize === null
    || totalLeads === null
    || filteredLeads === null
    || totalRecords === null
    || filteredRecords === null
    || totalCanonicalVisits === null
    || filteredCanonicalVisits === null
    || totalImportOnlyLeads === null
    || filteredImportOnlyLeads === null
    || generatedAt === null
  ) {
    throw new Error('A base de leads retornou metadados ausentes ou inválidos.');
  }

  const normalizedMeta: CrmLeadsPageMeta = {
    page,
    page_size: pageSize,
    total_leads: totalLeads,
    filtered_leads: filteredLeads,
    total_records: totalRecords,
    filtered_records: filteredRecords,
    total_canonical_visits: totalCanonicalVisits,
    filtered_canonical_visits: filteredCanonicalVisits,
    total_import_only_leads: totalImportOnlyLeads,
    filtered_import_only_leads: filteredImportOnlyLeads,
    generated_at: generatedAt,
  };

  const expectedRows = expectedPageLength(
    normalizedMeta.page,
    normalizedMeta.page_size,
    normalizedMeta.filtered_leads,
  );
  const hasInvalidMeta = normalizedMeta.page !== fallback.page
    || normalizedMeta.page_size !== fallback.pageSize
    || normalizedMeta.filtered_leads > normalizedMeta.total_leads
    || normalizedMeta.filtered_canonical_visits > normalizedMeta.total_canonical_visits
    || normalizedMeta.filtered_import_only_leads > normalizedMeta.total_import_only_leads
    || normalizedMeta.total_records !== (
      normalizedMeta.total_canonical_visits + normalizedMeta.total_import_only_leads
    )
    || normalizedMeta.filtered_records !== (
      normalizedMeta.filtered_canonical_visits + normalizedMeta.filtered_import_only_leads
    )
    || leads.length !== expectedRows;

  if (hasInvalidMeta) {
    throw new Error('A base de leads retornou contagens ou paginação inconsistentes.');
  }

  const states: CrmLeadStateOption[] = [];
  const seenStateCodes = new Set<string>();
  for (const rawState of source.states) {
    const state = normalizeCrmLeadStateOption(rawState);
    if (!state || seenStateCodes.has(state.code)) {
      throw new Error('A base de leads retornou opções de estado inválidas ou duplicadas.');
    }

    seenStateCodes.add(state.code);
    states.push(state);
  }

  return { leads, states, meta: normalizedMeta };
}

function normalizeCrmLeadPresenceVisit(value: unknown): CrmLeadPresenceVisit | null {
  if (!isRecord(value)) return null;

  const id = toStringValue(value.id);
  const visitId = toStringValue(value.visit_id);
  const visitOrigin = toStringValue(value.visit_origin) as CrmLeadVisitOrigin;
  const leadSource = toStringValue(value.lead_source) as CrmLeadPresenceVisit['lead_source'];
  const createdAt = readRequiredString(value, 'created_at');
  const date = readRequiredString(value, 'date');
  const time = readRequiredString(value, 'time');
  const status = readRequiredString(value, 'status');
  const partySize = readRequiredInteger(value, 'party_size', 0);

  if (
    !id
    || !visitId
    || createdAt === null
    || !isValidIsoTimestamp(createdAt)
    || date === null
    || !isValidIsoCalendarDate(date)
    || time === null
    || !isValidClockTime(time)
    || status === null
    || partySize === null
    || (visitOrigin !== 'reservation' && visitOrigin !== 'waitlist')
    || !CRM_LEAD_VISIT_SOURCES.has(leadSource)
  ) {
    return null;
  }

  return {
    id,
    visit_id: visitId,
    created_at: createdAt,
    date,
    time,
    party_size: partySize,
    status,
    occasion: toNullableString(value.occasion),
    lead_source: leadSource,
    visit_origin: visitOrigin,
    origin_waitlist_id: toNullableString(value.origin_waitlist_id),
    reservation_holder_name: toNullableString(value.reservation_holder_name),
  };
}

export function normalizeCrmLeadPresenceHistory(
  value: unknown,
  fallback: { customerKey: string; page: number; pageSize: number },
): CrmLeadPresenceHistory {
  const source = unwrapRpcJson(value);
  if (!isRecord(source)) {
    throw new Error('O histórico do lead não retornou dados válidos.');
  }

  if (!Array.isArray(source.visits) || !isRecord(source.meta)) {
    throw new Error('O histórico do lead não retornou a lista paginada esperada.');
  }

  const meta = source.meta;
  const rawVisits = source.visits;
  const seenVisitIds = new Set<string>();
  const visits: CrmLeadPresenceVisit[] = [];

  for (const rawVisit of rawVisits) {
    const visit = normalizeCrmLeadPresenceVisit(rawVisit);
    if (!visit || seenVisitIds.has(visit.id)) {
      throw new Error('O histórico do lead retornou uma página incompleta ou duplicada.');
    }

    seenVisitIds.add(visit.id);
    visits.push(visit);
  }

  const customerKey = toStringValue(source.customer_key, fallback.customerKey);
  const page = readRequiredInteger(meta, 'page', 1);
  const pageSize = readRequiredInteger(meta, 'page_size', 1);
  const totalVisits = readRequiredInteger(meta, 'total_visits', 0);
  if (page === null || pageSize === null || totalVisits === null) {
    throw new Error('O histórico do lead retornou metadados ausentes ou inválidos.');
  }

  const normalizedMeta: CrmLeadPresenceHistoryMeta = {
    page,
    page_size: pageSize,
    total_visits: totalVisits,
  };
  const expectedVisits = expectedPageLength(
    normalizedMeta.page,
    normalizedMeta.page_size,
    normalizedMeta.total_visits,
  );

  if (
    customerKey !== fallback.customerKey
    || normalizedMeta.page !== fallback.page
    || normalizedMeta.page_size !== fallback.pageSize
    || visits.length !== expectedVisits
  ) {
    throw new Error('O histórico do lead retornou contagens ou paginação inconsistentes.');
  }

  return {
    customer_key: customerKey,
    visits,
    meta: normalizedMeta,
  };
}

function normalizeCrmLeadExportRow(value: unknown): CrmLeadExportRow | null {
  if (!isRecord(value)) return null;

  const lead = normalizeCrmLeadRow(value);
  const rowKey = toStringValue(value.row_key);
  const rowKind = toStringValue(value.row_kind) as CrmLeadExportRowKind;
  const receivedMatchedSource = toStringValue(value.matched_source) as CrmLeadMatchedSource;
  const matchedVisitCount = readRequiredInteger(value, 'matched_visit_count', 0);
  const visit = value.visit === null || value.visit === undefined
    ? null
    : normalizeCrmLeadPresenceVisit(value.visit);

  if (
    !lead
    || !rowKey
    || matchedVisitCount === null
    || !CRM_LEAD_MATCHED_SOURCES.has(receivedMatchedSource)
    || (rowKind !== 'presence' && rowKind !== 'lead_only')
    || (rowKind === 'presence' && !visit)
    || (rowKind === 'lead_only' && visit)
  ) {
    return null;
  }

  return {
    ...lead,
    row_key: rowKey,
    row_kind: rowKind,
    matched_visit_count: matchedVisitCount,
    matched_source: receivedMatchedSource,
    last_matched_visit_date: toNullableString(value.last_matched_visit_date),
    last_matched_visit_time: toNullableString(value.last_matched_visit_time),
    last_matched_visit_at: toNullableString(value.last_matched_visit_at),
    visit,
  };
}

export function normalizeCrmLeadsExportPage(
  value: unknown,
  fallback: { page: number; pageSize: number },
): CrmLeadsExportPage {
  const source = unwrapRpcJson(value);
  if (!isRecord(source)) {
    throw new Error('A exportação de leads não retornou dados válidos.');
  }

  if (!Array.isArray(source.rows) || !isRecord(source.meta)) {
    throw new Error('A exportação de leads não retornou a lista paginada esperada.');
  }

  const meta = source.meta;
  const rawRows = source.rows;
  const seenRowKeys = new Set<string>();
  const rows: CrmLeadExportRow[] = [];

  for (const rawRow of rawRows) {
    const row = normalizeCrmLeadExportRow(rawRow);
    if (!row || seenRowKeys.has(row.row_key)) {
      throw new Error('A exportação de leads retornou uma página incompleta ou duplicada.');
    }

    seenRowKeys.add(row.row_key);
    rows.push(row);
  }

  const page = readRequiredInteger(meta, 'page', 1);
  const pageSize = readRequiredInteger(meta, 'page_size', 1);
  const totalRows = readRequiredInteger(meta, 'total_rows', 0);
  const totalPages = readRequiredInteger(meta, 'total_pages', 0);
  const filteredLeads = readRequiredInteger(meta, 'filtered_leads', 0);
  const matchedVisits = readRequiredInteger(meta, 'matched_visits', 0);
  const hasMore = readRequiredBoolean(meta, 'has_more');
  const visitFilterApplied = readRequiredBoolean(meta, 'visit_filter_applied');
  const generatedAt = readRequiredString(meta, 'generated_at');
  if (
    page === null
    || pageSize === null
    || totalRows === null
    || totalPages === null
    || filteredLeads === null
    || matchedVisits === null
    || hasMore === null
    || visitFilterApplied === null
    || generatedAt === null
  ) {
    throw new Error('A exportação de leads retornou metadados ausentes ou inválidos.');
  }

  const normalizedMeta: CrmLeadsExportPageMeta = {
    page,
    page_size: pageSize,
    total_rows: totalRows,
    total_pages: totalPages,
    filtered_leads: filteredLeads,
    matched_visits: matchedVisits,
    has_more: hasMore,
    visit_filter_applied: visitFilterApplied,
    generated_at: generatedAt,
  };
  const expectedTotalPages = normalizedMeta.total_rows === 0
    ? 0
    : Math.ceil(normalizedMeta.total_rows / normalizedMeta.page_size);
  const expectedRows = expectedPageLength(
    normalizedMeta.page,
    normalizedMeta.page_size,
    normalizedMeta.total_rows,
  );
  const expectedHasMore = normalizedMeta.page < expectedTotalPages;

  if (
    normalizedMeta.page !== fallback.page
    || normalizedMeta.page_size !== fallback.pageSize
    || normalizedMeta.total_pages !== expectedTotalPages
    || normalizedMeta.filtered_leads > normalizedMeta.total_rows
    || normalizedMeta.matched_visits > normalizedMeta.total_rows
    || normalizedMeta.has_more !== expectedHasMore
    || rows.length !== expectedRows
  ) {
    throw new Error('A exportação de leads retornou contagens ou paginação inconsistentes.');
  }

  return {
    rows,
    meta: normalizedMeta,
  };
}

function attachAbortSignal(request: any, signal?: AbortSignal) {
  if (signal && typeof request.abortSignal === 'function') {
    request.abortSignal(signal);
  }

  return request;
}

export async function collectCrmImportedLeadMatchPages<T>(
  getPage: (rangeStart: number, rangeEnd: number) => Promise<{ rows: T[]; total: number }>,
  getRowKey: (row: T) => string,
  requestedPageSize = 500,
) {
  const pageSize = Math.max(1, Math.floor(requestedPageSize));
  const rows: T[] = [];
  const seenKeys = new Set<string>();
  let rangeStart = 0;
  let expectedTotal: number | null = null;

  while (expectedTotal === null || rangeStart < expectedTotal) {
    const result = await getPage(rangeStart, rangeStart + pageSize - 1);
    if (!Number.isSafeInteger(result.total) || result.total < 0) {
      throw new Error('A busca de leads existentes retornou uma contagem inválida.');
    }

    if (expectedTotal === null) {
      expectedTotal = result.total;
    } else if (result.total !== expectedTotal) {
      throw new Error('A base de leads mudou durante a conferência da importação. Tente novamente.');
    }

    if (result.rows.length > pageSize || rangeStart + result.rows.length > expectedTotal) {
      throw new Error('A busca de leads existentes retornou uma página inconsistente.');
    }

    if (result.rows.length === 0) {
      if (rangeStart < expectedTotal) {
        throw new Error('A busca de leads existentes parou antes de carregar todos os resultados.');
      }
      break;
    }

    for (const row of result.rows) {
      const key = getRowKey(row);
      if (!key || seenKeys.has(key)) {
        throw new Error('A busca de leads existentes retornou registros inválidos ou duplicados.');
      }

      seenKeys.add(key);
      rows.push(row);
    }

    rangeStart += result.rows.length;
  }

  if (expectedTotal === null || rows.length !== expectedTotal) {
    throw new Error('A busca de leads existentes não carregou todos os resultados.');
  }

  return rows;
}

export async function fetchCrmLeadsPage(
  params: Omit<CrmLeadsPageParams, 'enabled'>,
  signal?: AbortSignal,
) {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 25)));
  const request = (supabase as any).rpc('get_crm_leads_page', {
    _company_id: params.companyId,
    _page: page,
    _page_size: pageSize,
    _search: normalizeCrmLeadsSearch(params.search) || null,
    _created_from: params.createdFrom || null,
    _created_to: params.createdTo || null,
    _state_code: params.stateCode || null,
    _birthday_month: params.birthdayMonth ?? null,
    _min_visits: normalizeCrmVisitsFilter(params.minVisits),
    _max_visits: normalizeCrmVisitsFilter(params.maxVisits),
  });

  const { data, error } = await attachAbortSignal(request, signal);
  if (error) throw error;

  return normalizeCrmLeadsPage(data, { page, pageSize });
}

export async function fetchCrmLeadsExportPage(
  params: Omit<CrmLeadsCanonicalExportParams, 'enabled'> & { page: number; pageSize: number },
  signal?: AbortSignal,
) {
  const page = Math.max(1, Math.floor(params.page));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize)));
  const request = (supabase as any).rpc('get_crm_leads_export_page', {
    _company_id: params.companyId,
    _page: page,
    _page_size: pageSize,
    _created_from: params.createdFrom || null,
    _created_to: params.createdTo || null,
    _state_code: params.stateCode || null,
    _birthday_month: params.birthdayMonth ?? null,
    _visit_from: params.visitFrom || null,
    _visit_to: params.visitTo || null,
  });

  const { data, error } = await attachAbortSignal(request, signal);
  if (error) throw error;

  return normalizeCrmLeadsExportPage(data, { page, pageSize });
}

async function fetchCrmLeadPresenceHistoryPage(
  params: {
    companyId: string;
    customerKey: string;
    page: number;
    pageSize: number;
  },
  signal?: AbortSignal,
) {
  const request = (supabase as any).rpc('get_crm_lead_presence_history', {
    _company_id: params.companyId,
    _customer_key: params.customerKey,
    _page: params.page,
    _page_size: params.pageSize,
  });

  const { data, error } = await attachAbortSignal(request, signal);
  if (error) throw error;

  return normalizeCrmLeadPresenceHistory(data, {
    customerKey: params.customerKey,
    page: params.page,
    pageSize: params.pageSize,
  });
}

export async function fetchAllCrmLeadPresenceHistory(
  params: { companyId: string; customerKey: string },
  signal?: AbortSignal,
): Promise<CrmLeadPresenceHistory> {
  return collectCrmLeadPresenceHistoryPages(
    params.customerKey,
    (page, pageSize) => fetchCrmLeadPresenceHistoryPage({
      ...params,
      page,
      pageSize,
    }, signal),
  );
}

export async function collectCrmLeadPresenceHistoryPages(
  customerKey: string,
  getPage: (page: number, pageSize: number) => Promise<CrmLeadPresenceHistory>,
): Promise<CrmLeadPresenceHistory> {
  const visits: CrmLeadPresenceVisit[] = [];
  const seenVisitIds = new Set<string>();
  let page = 1;
  let totalVisits: number | null = null;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await getPage(page, CRM_LEAD_HISTORY_PAGE_SIZE);
    const receivedTotal = result.meta.total_visits;
    if (!Number.isSafeInteger(receivedTotal) || receivedTotal < 0) {
      throw new Error('O histórico do lead retornou uma contagem inválida. Tente novamente.');
    }
    const expectedVisitsOnPage = expectedPageLength(
      page,
      CRM_LEAD_HISTORY_PAGE_SIZE,
      receivedTotal,
    );

    if (
      result.customer_key !== customerKey
      || result.meta.page !== page
      || result.meta.page_size !== CRM_LEAD_HISTORY_PAGE_SIZE
      || result.visits.length !== expectedVisitsOnPage
      || (totalVisits !== null && receivedTotal !== totalVisits)
    ) {
      throw new Error('A base de visitas mudou durante o carregamento. Tente novamente.');
    }

    totalVisits = receivedTotal;
    totalPages = Math.max(1, Math.ceil(totalVisits / CRM_LEAD_HISTORY_PAGE_SIZE));
    for (const visit of result.visits) {
      if (seenVisitIds.has(visit.id)) {
        throw new Error('O histórico completo do lead retornou visitas duplicadas. Tente novamente.');
      }

      seenVisitIds.add(visit.id);
      visits.push(visit);
    }

    page += 1;
  }

  if (totalVisits === null || visits.length !== totalVisits) {
    throw new Error('O histórico completo do lead não pôde ser carregado. Tente novamente.');
  }

  return {
    customer_key: customerKey,
    visits,
    meta: {
      page: 1,
      page_size: CRM_LEAD_HISTORY_PAGE_SIZE,
      total_visits: totalVisits,
    },
  };
}

export async function collectCrmLeadsExportPages(
  getPage: (page: number, pageSize: number) => Promise<CrmLeadsExportPage>,
) {
  const rows: CrmLeadExportRow[] = [];
  const seenRowKeys = new Set<string>();
  let page = 1;
  let baseline: Pick<
    CrmLeadsExportPageMeta,
    'total_rows' | 'total_pages' | 'filtered_leads' | 'matched_visits'
  > | null = null;
  let lastMeta: CrmLeadsExportPageMeta | null = null;

  while (true) {
    const result = await getPage(page, 100);
    const expectedTotalPages = result.meta.total_rows === 0
      ? 0
      : Math.ceil(result.meta.total_rows / 100);
    const expectedRowsOnPage = expectedPageLength(page, 100, result.meta.total_rows);
    const expectedHasMore = page < expectedTotalPages;

    if (
      result.meta.page !== page
      || result.meta.page_size !== 100
      || result.meta.total_pages !== expectedTotalPages
      || result.meta.has_more !== expectedHasMore
      || result.rows.length !== expectedRowsOnPage
    ) {
      throw new Error('A exportação retornou uma página ou contagem inconsistente. Tente novamente.');
    }

    const currentBaseline = {
      total_rows: result.meta.total_rows,
      total_pages: result.meta.total_pages,
      filtered_leads: result.meta.filtered_leads,
      matched_visits: result.meta.matched_visits,
    };

    if (!baseline) {
      baseline = currentBaseline;
    } else if (
      baseline.total_rows !== currentBaseline.total_rows
      || baseline.total_pages !== currentBaseline.total_pages
      || baseline.filtered_leads !== currentBaseline.filtered_leads
      || baseline.matched_visits !== currentBaseline.matched_visits
    ) {
      throw new Error('A base de leads mudou durante a exportação. Tente novamente.');
    }

    const uniqueRowsBeforePage = rows.length;
    for (const row of result.rows) {
      if (!seenRowKeys.has(row.row_key)) {
        seenRowKeys.add(row.row_key);
        rows.push(row);
      }
    }

    lastMeta = result.meta;
    if (!result.meta.has_more) break;
    if (
      page >= result.meta.total_pages
      || result.rows.length === 0
      || rows.length === uniqueRowsBeforePage
    ) {
      throw new Error('A exportação não conseguiu carregar todas as linhas. Tente novamente.');
    }
    page += 1;
  }

  if (!baseline || !lastMeta || rows.length !== baseline.total_rows) {
    throw new Error('A exportação não conseguiu carregar todas as linhas. Tente novamente.');
  }

  if (rows.filter((row) => row.row_kind === 'presence').length !== baseline.matched_visits) {
    throw new Error('A exportação retornou uma contagem de presenças inconsistente.');
  }

  return { rows, meta: { ...lastMeta, ...baseline, has_more: false } };
}

export function groupCrmLeadExportRows(rows: CrmLeadExportRow[]) {
  const grouped = new Map<string, CrmLeadCanonicalExportItem>();
  const expectedVisitCounts = new Map<string, number>();

  for (const row of rows) {
    if (!grouped.has(row.customer_key)) {
      grouped.set(row.customer_key, {
        lead: row,
        visits: [],
        matchedSource: row.matched_source,
      });
      expectedVisitCounts.set(row.customer_key, row.matched_visit_count);
    } else if (expectedVisitCounts.get(row.customer_key) !== row.matched_visit_count) {
      throw new Error('A exportação retornou totais inconsistentes para um cliente.');
    }

    if (row.row_kind === 'presence' && row.visit) {
      grouped.get(row.customer_key)!.visits.push(row.visit);
    }
  }

  const items = Array.from(grouped.values());
  for (const item of items) {
    if (item.visits.length !== expectedVisitCounts.get(item.lead.customer_key)) {
      throw new Error('A exportação retornou um histórico incompleto para um cliente.');
    }
  }

  return items;
}

export async function fetchCrmLeadsCanonicalExport(
  params: Omit<CrmLeadsCanonicalExportParams, 'enabled'>,
  signal?: AbortSignal,
): Promise<CrmLeadsCanonicalExport> {
  const result = await collectCrmLeadsExportPages((page, pageSize) => (
    fetchCrmLeadsExportPage({ ...params, page, pageSize }, signal)
  ));
  const items = groupCrmLeadExportRows(result.rows);

  if (items.length !== result.meta.filtered_leads) {
    throw new Error('A exportação não conseguiu carregar todos os clientes. Tente novamente.');
  }

  return {
    items,
    scanned_leads: result.meta.filtered_leads,
  };
}

export function useCrmLeadsPage({
  companyId,
  page = 1,
  pageSize = 25,
  search = '',
  createdFrom = null,
  createdTo = null,
  stateCode = null,
  birthdayMonth = null,
  minVisits = null,
  maxVisits = null,
  enabled = true,
}: CrmLeadsPageParams) {
  const normalizedSearch = normalizeCrmLeadsSearch(search);
  const queryKey = buildCrmLeadsPageQueryKey({
    companyId,
    page,
    pageSize,
    search: normalizedSearch,
    createdFrom,
    createdTo,
    stateCode,
    birthdayMonth,
    minVisits,
    maxVisits,
  });

  return useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchCrmLeadsPage({
      companyId,
      page,
      pageSize,
      search: normalizedSearch,
      createdFrom,
      createdTo,
      stateCode,
      birthdayMonth,
      minVisits,
      maxVisits,
    }, signal),
    enabled: enabled && !!companyId,
    placeholderData: (previousData, previousQuery) => (
      isSameCrmLeadsDataset(previousQuery?.queryKey, queryKey)
        ? previousData
        : undefined
    ),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useCrmLeadPresenceHistory({
  companyId,
  customerKey,
  expectedVisitCount = null,
  enabled = true,
}: CrmLeadPresenceHistoryParams) {
  return useQuery({
    queryKey: ['crm-lead-presence-history', companyId, customerKey, expectedVisitCount],
    queryFn: async ({ signal }) => {
      const history = await fetchAllCrmLeadPresenceHistory({
        companyId: companyId!,
        customerKey: customerKey!,
      }, signal);

      if (expectedVisitCount !== null && history.meta.total_visits !== expectedVisitCount) {
        throw new Error('A base de visitas mudou. Atualize a lista e tente novamente.');
      }

      return history;
    },
    enabled: enabled && !!companyId && !!customerKey,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useCrmLeadsCanonicalExport({
  companyId,
  createdFrom = null,
  createdTo = null,
  stateCode = null,
  birthdayMonth = null,
  visitFrom = null,
  visitTo = null,
  enabled = true,
}: CrmLeadsCanonicalExportParams) {
  return useQuery({
    queryKey: [
      'crm-leads-export',
      companyId,
      createdFrom,
      createdTo,
      stateCode,
      birthdayMonth,
      visitFrom,
      visitTo,
    ],
    queryFn: ({ signal }) => fetchCrmLeadsCanonicalExport({
      companyId,
      createdFrom,
      createdTo,
      stateCode,
      birthdayMonth,
      visitFrom,
      visitTo,
    }, signal),
    enabled: enabled && !!companyId,
    staleTime: 0,
    retry: 1,
  });
}
