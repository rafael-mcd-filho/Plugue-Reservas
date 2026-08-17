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

function toBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
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
  if (!customerKey) return null;

  const crmLead = normalizeCrmLeadImportMetadata(value.crm_lead);
  const receivedSource = toStringValue(value.source) as CrmLeadSource;

  return {
    customer_key: customerKey,
    phone_normalized: toNullableString(value.phone_normalized),
    display_phone: toNullableString(value.display_phone),
    latest_name: toStringValue(value.latest_name, 'Lead sem nome') || 'Lead sem nome',
    latest_email: toNullableString(value.latest_email),
    latest_birthdate: toNullableString(value.latest_birthdate),
    first_seen_at: toStringValue(value.first_seen_at),
    last_visit_date: toNullableString(value.last_visit_date),
    last_visit_time: toNullableString(value.last_visit_time),
    state_code: toNullableString(value.state_code),
    state_name: toNullableString(value.state_name),
    source: CRM_LEAD_SOURCES.has(receivedSource)
      ? receivedSource
      : crmLead
        ? 'imported'
        : 'mixed',
    canonical_visit_count: Math.max(0, toNumber(value.canonical_visit_count)),
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

  const meta = isRecord(source.meta) ? source.meta : {};
  const seenCustomerKeys = new Set<string>();
  const leads = Array.isArray(source.leads)
    ? source.leads
      .map(normalizeCrmLeadRow)
      .filter((lead): lead is CrmLeadRow => {
        if (!lead || seenCustomerKeys.has(lead.customer_key)) return false;
        seenCustomerKeys.add(lead.customer_key);
        return true;
      })
    : [];

  return {
    leads,
    states: Array.isArray(source.states)
      ? source.states
        .map(normalizeCrmLeadStateOption)
        .filter((state): state is CrmLeadStateOption => !!state)
      : [],
    meta: {
      page: Math.max(1, toNumber(meta.page, fallback.page)),
      page_size: Math.max(1, toNumber(meta.page_size, fallback.pageSize)),
      total_leads: Math.max(0, toNumber(meta.total_leads)),
      filtered_leads: Math.max(0, toNumber(meta.filtered_leads)),
      total_records: Math.max(0, toNumber(meta.total_records)),
      filtered_records: Math.max(0, toNumber(meta.filtered_records)),
      total_canonical_visits: Math.max(0, toNumber(meta.total_canonical_visits)),
      filtered_canonical_visits: Math.max(0, toNumber(meta.filtered_canonical_visits)),
      total_import_only_leads: Math.max(0, toNumber(meta.total_import_only_leads)),
      filtered_import_only_leads: Math.max(0, toNumber(meta.filtered_import_only_leads)),
      generated_at: toStringValue(meta.generated_at),
    },
  };
}

function normalizeCrmLeadPresenceVisit(value: unknown): CrmLeadPresenceVisit | null {
  if (!isRecord(value)) return null;

  const id = toStringValue(value.id);
  const visitId = toStringValue(value.visit_id);
  const visitOrigin = toStringValue(value.visit_origin) as CrmLeadVisitOrigin;
  const leadSource = toStringValue(value.lead_source) as CrmLeadPresenceVisit['lead_source'];

  if (
    !id
    || !visitId
    || (visitOrigin !== 'reservation' && visitOrigin !== 'waitlist')
    || !CRM_LEAD_VISIT_SOURCES.has(leadSource)
  ) {
    return null;
  }

  return {
    id,
    visit_id: visitId,
    created_at: toStringValue(value.created_at),
    date: toStringValue(value.date),
    time: toStringValue(value.time),
    party_size: Math.max(0, toNumber(value.party_size)),
    status: toStringValue(value.status),
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

  const meta = isRecord(source.meta) ? source.meta : {};
  const seenVisitIds = new Set<string>();
  const visits = Array.isArray(source.visits)
    ? source.visits
      .map(normalizeCrmLeadPresenceVisit)
      .filter((visit): visit is CrmLeadPresenceVisit => {
        if (!visit || seenVisitIds.has(visit.id)) return false;
        seenVisitIds.add(visit.id);
        return true;
      })
    : [];

  return {
    customer_key: toStringValue(source.customer_key, fallback.customerKey),
    visits,
    meta: {
      page: Math.max(1, toNumber(meta.page, fallback.page)),
      page_size: Math.max(1, toNumber(meta.page_size, fallback.pageSize)),
      total_visits: Math.max(0, toNumber(meta.total_visits)),
    },
  };
}

function normalizeCrmLeadExportRow(value: unknown): CrmLeadExportRow | null {
  if (!isRecord(value)) return null;

  const lead = normalizeCrmLeadRow(value);
  const rowKey = toStringValue(value.row_key);
  const rowKind = toStringValue(value.row_kind) as CrmLeadExportRowKind;
  const receivedMatchedSource = toStringValue(value.matched_source) as CrmLeadMatchedSource;
  const visit = value.visit === null || value.visit === undefined
    ? null
    : normalizeCrmLeadPresenceVisit(value.visit);

  if (
    !lead
    || !rowKey
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
    matched_visit_count: Math.max(0, toNumber(value.matched_visit_count)),
    matched_source: CRM_LEAD_MATCHED_SOURCES.has(receivedMatchedSource)
      ? receivedMatchedSource
      : lead.source,
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

  const meta = isRecord(source.meta) ? source.meta : {};
  const seenRowKeys = new Set<string>();
  const rows = Array.isArray(source.rows)
    ? source.rows
      .map(normalizeCrmLeadExportRow)
      .filter((row): row is CrmLeadExportRow => {
        if (!row || seenRowKeys.has(row.row_key)) return false;
        seenRowKeys.add(row.row_key);
        return true;
      })
    : [];

  return {
    rows,
    meta: {
      page: Math.max(1, toNumber(meta.page, fallback.page)),
      page_size: Math.max(1, toNumber(meta.page_size, fallback.pageSize)),
      total_rows: Math.max(0, toNumber(meta.total_rows)),
      total_pages: Math.max(0, toNumber(meta.total_pages)),
      filtered_leads: Math.max(0, toNumber(meta.filtered_leads)),
      matched_visits: Math.max(0, toNumber(meta.matched_visits)),
      has_more: toBoolean(meta.has_more),
      visit_filter_applied: toBoolean(meta.visit_filter_applied),
      generated_at: toStringValue(meta.generated_at),
    },
  };
}

function attachAbortSignal(request: any, signal?: AbortSignal) {
  if (signal && typeof request.abortSignal === 'function') {
    request.abortSignal(signal);
  }

  return request;
}

export async function fetchCrmLeadsPage(
  params: Omit<CrmLeadsPageParams, 'enabled'>,
  signal?: AbortSignal,
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const request = (supabase as any).rpc('get_crm_leads_page', {
    _company_id: params.companyId,
    _page: page,
    _page_size: pageSize,
    _search: params.search?.trim() || null,
    _created_from: params.createdFrom || null,
    _created_to: params.createdTo || null,
    _state_code: params.stateCode || null,
    _birthday_month: params.birthdayMonth ?? null,
    _min_visits: params.minVisits ?? null,
    _max_visits: params.maxVisits ?? null,
  });

  const { data, error } = await attachAbortSignal(request, signal);
  if (error) throw error;

  return normalizeCrmLeadsPage(data, { page, pageSize });
}

export async function fetchCrmLeadsExportPage(
  params: Omit<CrmLeadsCanonicalExportParams, 'enabled'> & { page: number; pageSize: number },
  signal?: AbortSignal,
) {
  const page = Math.max(1, params.page);
  const pageSize = Math.min(100, Math.max(1, params.pageSize));
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
  let totalVisits = 0;

  while (page === 1 || visits.length < totalVisits) {
    const result = await getPage(page, CRM_LEAD_HISTORY_PAGE_SIZE);

    totalVisits = result.meta.total_visits;
    for (const visit of result.visits) {
      if (!seenVisitIds.has(visit.id)) {
        seenVisitIds.add(visit.id);
        visits.push(visit);
      }
    }

    if (result.visits.length === 0 || visits.length >= totalVisits) break;
    page += 1;
  }

  if (visits.length !== totalVisits) {
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
  let baseline: Pick<CrmLeadsExportPageMeta, 'total_rows' | 'filtered_leads' | 'matched_visits'> | null = null;
  let lastMeta: CrmLeadsExportPageMeta | null = null;

  while (true) {
    const result = await getPage(page, 100);
    const currentBaseline = {
      total_rows: result.meta.total_rows,
      filtered_leads: result.meta.filtered_leads,
      matched_visits: result.meta.matched_visits,
    };

    if (!baseline) {
      baseline = currentBaseline;
    } else if (
      baseline.total_rows !== currentBaseline.total_rows
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
    if (result.rows.length === 0 || rows.length === uniqueRowsBeforePage) {
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
  const normalizedSearch = search.trim();

  return useQuery({
    queryKey: [
      'crm-leads-page',
      companyId,
      page,
      pageSize,
      normalizedSearch,
      createdFrom,
      createdTo,
      stateCode,
      birthdayMonth,
      minVisits,
      maxVisits,
    ],
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
