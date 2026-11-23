import { supabase } from '@/integrations/supabase/client';
import { normalizeCrmLeadRow, type CrmLeadRow } from '@/hooks/useCrmLeads';
import { getPhoneLookupVariants } from '@/lib/phone';

export const COMPANY_GLOBAL_SEARCH_MIN_LENGTH = 3;
export const COMPANY_GLOBAL_SEARCH_MAX_LENGTH = 200;
// 10 por grupo: reservas mais recentes primeiro e clientes na ordem do CRM; "Carregar mais" busca os próximos 10.
export const COMPANY_GLOBAL_SEARCH_PAGE_SIZE = 10;

export interface GlobalSearchReservation {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_phone_e164: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  public_tracking_code: string | null;
}

export interface CompanyGlobalSearchSection<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  error: string | null;
}

export interface CompanyGlobalSearchResult {
  query: string;
  reservations: CompanyGlobalSearchSection<GlobalSearchReservation>;
  customers: CompanyGlobalSearchSection<CrmLeadRow>;
}

export interface CompanyGlobalSearchParams {
  companyId: string | null | undefined;
  query: string;
  canViewReservations: boolean;
  canViewCustomers: boolean;
  reservationsPage?: number;
  customersPage?: number;
  signal?: AbortSignal;
}

export function normalizeCompanyGlobalSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, ' ');
}

export function isCompanyGlobalSearchQueryReady(query: string) {
  const normalized = normalizeCompanyGlobalSearchQuery(query);
  return normalized.length >= COMPANY_GLOBAL_SEARCH_MIN_LENGTH
    && normalized.length <= COMPANY_GLOBAL_SEARCH_MAX_LENGTH
    && (!/^\+?[\d\s().-]+$/.test(normalized) || normalized.replace(/\D/g, '').length >= COMPANY_GLOBAL_SEARCH_MIN_LENGTH);
}

function pageNumber(value: number | undefined) {
  const page = value ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(page * COMPANY_GLOBAL_SEARCH_PAGE_SIZE)) {
    throw new Error('A página da busca é inválida.');
  }
  return page;
}

function emptySection<T>(page: number): CompanyGlobalSearchSection<T> {
  return { items: [], page, hasMore: false, error: null };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Busca cancelada.', 'AbortError');
  }
}

// Values inside .or() use PostgREST's quoted-value grammar. JSON escaping is
// appropriate here (this string is never passed to a shell).
function quotedValue(value: string) {
  return JSON.stringify(value);
}

function textSearch(column: string, value: string) {
  // PostgREST treats * as a LIKE alias even inside quoted values. Equality keeps
  // such a query literal instead of accidentally broadening it to every name.
  if (value.includes('*')) return `${column}.eq.${quotedValue(value)}`;
  const literal = value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
  return `${column}.ilike.${quotedValue(`%${literal}%`)}`;
}

export function buildCompanyReservationSearchFilter(query: string) {
  const normalized = normalizeCompanyGlobalSearchQuery(query);
  const clauses = [
    textSearch('guest_name', normalized),
    textSearch('public_tracking_code', normalized),
  ];
  if (/^\+?[\d\s().-]+$/.test(normalized)) {
    const digits = normalized.replace(/\D/g, '');
    const variants = new Set([normalized, digits, ...getPhoneLookupVariants(normalized)]);
    for (const value of variants) {
      if (!value) continue;
      clauses.push(textSearch('guest_phone', value));
      clauses.push(textSearch('guest_phone_e164', value));
    }
  }
  return [...new Set(clauses)].join(',');
}

function isReservation(value: unknown, companyId: string): value is GlobalSearchReservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0
    && row.company_id === companyId
    && typeof row.guest_name === 'string'
    && typeof row.guest_phone === 'string'
    && (row.guest_phone_e164 === null || typeof row.guest_phone_e164 === 'string')
    && typeof row.date === 'string'
    && typeof row.time === 'string'
    && Number.isSafeInteger(row.party_size) && Number(row.party_size) > 0
    && typeof row.status === 'string'
    && (row.public_tracking_code === null || typeof row.public_tracking_code === 'string');
}

async function searchReservations(
  companyId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<CompanyGlobalSearchSection<GlobalSearchReservation>> {
  const start = (page - 1) * COMPANY_GLOBAL_SEARCH_PAGE_SIZE;
  const request = supabase
    .from('reservations')
    .select('id, company_id, guest_name, guest_phone, guest_phone_e164, date, time, party_size, status, public_tracking_code')
    .eq('company_id', companyId)
    .or(buildCompanyReservationSearchFilter(query))
    .order('date', { ascending: false })
    .order('time', { ascending: false })
    .order('id', { ascending: true })
    .range(start, start + COMPANY_GLOBAL_SEARCH_PAGE_SIZE);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  throwIfAborted(signal);
  if (error) throw error;
  if (!Array.isArray(data)
    || data.length > COMPANY_GLOBAL_SEARCH_PAGE_SIZE + 1
    || !data.every((row) => isReservation(row, companyId))) {
    throw new Error('A busca de reservas retornou dados inválidos.');
  }
  const rows = data as unknown as GlobalSearchReservation[];
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error('A busca de reservas retornou registros repetidos.');
  }
  return {
    items: rows.slice(0, COMPANY_GLOBAL_SEARCH_PAGE_SIZE),
    page,
    hasMore: rows.length > COMPANY_GLOBAL_SEARCH_PAGE_SIZE,
    error: null,
  };
}

/**
 * Confere a página de search_crm_leads: cada cliente no formato da tela Clientes,
 * sem repetir, e "has_more" só com a página cheia.
 */
export function normalizeCustomerSearchPage(value: unknown, page: number): CompanyGlobalSearchSection<CrmLeadRow> {
  const source = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const record = typeof source === 'object' && source !== null && !Array.isArray(source)
    ? source as Record<string, unknown>
    : null;
  const meta = record && typeof record.meta === 'object' && record.meta !== null && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : null;
  if (!record || !Array.isArray(record.leads) || !meta) {
    throw new Error('A busca de clientes retornou dados inválidos.');
  }

  const leads: CrmLeadRow[] = [];
  const keys = new Set<string>();
  for (const raw of record.leads) {
    const lead = normalizeCrmLeadRow(raw);
    if (!lead || keys.has(lead.customer_key)) {
      throw new Error('A busca de clientes retornou registros inválidos ou repetidos.');
    }
    keys.add(lead.customer_key);
    leads.push(lead);
  }

  const hasMore = meta.has_more;
  if (meta.page !== page
    || meta.page_size !== COMPANY_GLOBAL_SEARCH_PAGE_SIZE
    || typeof hasMore !== 'boolean'
    || leads.length > COMPANY_GLOBAL_SEARCH_PAGE_SIZE
    || (hasMore && leads.length !== COMPANY_GLOBAL_SEARCH_PAGE_SIZE)) {
    throw new Error('A busca de clientes retornou uma página inconsistente.');
  }

  return { items: leads, page, hasMore, error: null };
}

// search_crm_leads filtra antes de montar as fichas: get_crm_leads_page monta a
// ficha de todos os clientes da unidade e passa do tempo limite em unidades grandes.
async function searchCustomers(
  companyId: string,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<CompanyGlobalSearchSection<CrmLeadRow>> {
  const request = (supabase as any).rpc('search_crm_leads', {
    _company_id: companyId,
    _search: query,
    _page: page,
    _page_size: COMPANY_GLOBAL_SEARCH_PAGE_SIZE,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  throwIfAborted(signal);
  if (error) throw error;
  return normalizeCustomerSearchPage(data, page);
}

async function resolveSection<T>(
  load: () => Promise<CompanyGlobalSearchSection<T>>,
  page: number,
  errorMessage: string,
  signal?: AbortSignal,
): Promise<CompanyGlobalSearchSection<T>> {
  try {
    return await load();
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { ...emptySection<T>(page), error: errorMessage };
  }
}

export interface CompanyGlobalSearchSectionParams {
  companyId: string;
  query: string;
  page: number;
  signal?: AbortSignal;
}

function readySectionQuery(params: CompanyGlobalSearchSectionParams) {
  const query = normalizeCompanyGlobalSearchQuery(params.query);
  const page = pageNumber(params.page);
  throwIfAborted(params.signal);
  if (query.length > COMPANY_GLOBAL_SEARCH_MAX_LENGTH) {
    throw new Error(`Use até ${COMPANY_GLOBAL_SEARCH_MAX_LENGTH} caracteres na busca.`);
  }
  return { query, page, companyId: params.companyId.trim(), ready: isCompanyGlobalSearchQueryReady(query) && !!params.companyId.trim() };
}

/** Só as reservas: a tela mostra este grupo assim que ele chega, sem esperar os clientes. */
export async function searchCompanyReservations(params: CompanyGlobalSearchSectionParams) {
  const { query, page, companyId, ready } = readySectionQuery(params);
  if (!ready) return emptySection<GlobalSearchReservation>(page);
  return searchReservations(companyId, query, page, params.signal);
}

/** Só os clientes: mesma ficha e mesma ordem da tela Clientes, filtrando antes de montar as fichas. */
export async function searchCompanyCustomers(params: CompanyGlobalSearchSectionParams) {
  const { query, page, companyId, ready } = readySectionQuery(params);
  if (!ready) return emptySection<CrmLeadRow>(page);
  return searchCustomers(companyId, query, page, params.signal);
}

export async function searchCompanyGlobal(params: CompanyGlobalSearchParams): Promise<CompanyGlobalSearchResult> {
  const query = normalizeCompanyGlobalSearchQuery(params.query);
  const reservationsPage = pageNumber(params.reservationsPage);
  const customersPage = pageNumber(params.customersPage);
  const empty: CompanyGlobalSearchResult = {
    query,
    reservations: emptySection(reservationsPage),
    customers: emptySection(customersPage),
  };
  throwIfAborted(params.signal);
  if (query.length > COMPANY_GLOBAL_SEARCH_MAX_LENGTH) {
    throw new Error(`Use até ${COMPANY_GLOBAL_SEARCH_MAX_LENGTH} caracteres na busca.`);
  }
  if (!isCompanyGlobalSearchQueryReady(query)
    || !params.companyId?.trim()
    || (!params.canViewReservations && !params.canViewCustomers)) return empty;

  const companyId = params.companyId.trim();
  const [reservations, customers] = await Promise.all([
    params.canViewReservations
      ? resolveSection(
        () => searchReservations(companyId, query, reservationsPage, params.signal),
        reservationsPage,
        'Não foi possível buscar reservas. Tente novamente.',
        params.signal,
      )
      : Promise.resolve(empty.reservations),
    params.canViewCustomers
      ? resolveSection(
        () => searchCustomers(companyId, query, customersPage, params.signal),
        customersPage,
        'Não foi possível buscar clientes. Tente novamente.',
        params.signal,
      )
      : Promise.resolve(empty.customers),
  ]);
  throwIfAborted(params.signal);
  return { query, reservations, customers };
}
