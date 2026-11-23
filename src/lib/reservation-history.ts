import { addDays, format, startOfDay } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import type { ReservationOperationalFilter } from '@/lib/reservation-operational-filter';
import type { ReservationOriginKey } from '@/lib/reservation-origin';
import type { ReservationStatus } from '@/types/restaurant';

export const RESERVATION_HISTORY_PAGE_SIZE = 15;
export const RESERVATION_HISTORY_SEARCH_MAX_LENGTH = 200;

export interface ReservationHistoryPayment {
  id: string;
  status: string;
  paid_at: string | null;
  billing_type: string | null;
  charged_amount: number | null;
  base_amount: number | null;
}

export interface ReservationHistoryRow {
  id: string;
  company_id: string;
  table_id: string | null;
  table_map_id: string | null;
  created_in_mode?: string | null;
  source: string | null;
  origin_tracking_session_id?: string | null;
  origin_anonymous_id?: string | null;
  origin_affiliate_link_id?: string | null;
  attribution_snapshot?: Record<string, unknown> | null;
  guest_name: string;
  guest_phone: string;
  guest_phone_e164?: string | null;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  public_tracking_code: string;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  created_at: string;
  updated_at: string;
  reservation_payments?: ReservationHistoryPayment[] | null;
}

export interface ReservationHistoryFilters {
  search: string;
  operationalFilter: ReservationOperationalFilter;
  status: string;
  entryMethod: 'all' | ReservationOriginKey;
  dateFilterMode: 'reservation' | 'created';
  range?: DateRange;
}

export interface ReservationHistoryPage {
  company_id: string;
  rows: ReservationHistoryRow[];
  total: number;
  total_people: number;
  by_status: Array<{ status: ReservationStatus; count: number; people: number }>;
  page: number;
  page_size: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalidResponse = () => new Error('Não foi possível carregar o histórico completo deste filtro. Tente novamente.');

/** Preserve the existing local calendar bounds; a partial range has no upper end. */
export function reservationHistoryFilterParams(filters: ReservationHistoryFilters) {
  if (filters.search.length > RESERVATION_HISTORY_SEARCH_MAX_LENGTH) throw new Error('A busca deve ter até 200 caracteres.');
  const from = filters.range?.from;
  const to = from ? filters.range?.to : undefined;
  if ((from && !Number.isFinite(from.getTime())) || (to && (!Number.isFinite(to.getTime()) || to < from!))) throw new Error('O período da consulta é inválido.');
  return {
    _search: filters.search,
    _operational_filter: filters.operationalFilter,
    _status: filters.status,
    _entry_method: filters.entryMethod,
    _date_filter_mode: filters.dateFilterMode,
    _start_date: filters.dateFilterMode === 'reservation' && from ? format(from, 'yyyy-MM-dd') : null,
    _end_date: filters.dateFilterMode === 'reservation' && to ? format(to, 'yyyy-MM-dd') : null,
    _created_start_at: filters.dateFilterMode === 'created' && from ? startOfDay(from).toISOString() : null,
    _created_end_at: filters.dateFilterMode === 'created' && to ? startOfDay(addDays(to, 1)).toISOString() : null,
  };
}

/** Keep page rows and full-filter totals from the same server snapshot. */
export function parseReservationHistoryPage(value: unknown, companyId: string): ReservationHistoryPage {
  if (!isRecord(value) || value.company_id !== companyId || !Array.isArray(value.rows) || !Array.isArray(value.by_status)
    || !count(value.total) || !count(value.total_people) || !count(value.page) || value.page < 1
    || value.page_size !== RESERVATION_HISTORY_PAGE_SIZE) throw invalidResponse();
  const lastPage = Math.max(1, Math.ceil(value.total / value.page_size));
  if (value.page > lastPage || value.rows.length !== Math.min(value.page_size, Math.max(0, value.total - (value.page - 1) * value.page_size))) throw invalidResponse();
  const ids = new Set<string>();
  const rows = value.rows.map((row) => {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id) || row.company_id !== companyId
      || typeof row.guest_name !== 'string' || typeof row.guest_phone !== 'string' || typeof row.status !== 'string'
      || typeof row.date !== 'string' || typeof row.time !== 'string' || !count(row.party_size)) throw invalidResponse();
    ids.add(row.id);
    return { ...row, guest_phone: typeof row.guest_phone_e164 === 'string' ? row.guest_phone_e164 : row.guest_phone, status: normalizeReservationStatus(row.status) } as unknown as ReservationHistoryRow;
  });
  const statuses = new Set<string>();
  const byStatus = value.by_status.map((entry) => {
    if (!isRecord(entry) || typeof entry.status !== 'string' || statuses.has(entry.status) || normalizeReservationStatus(entry.status) !== entry.status
      || !count(entry.count) || !count(entry.people) || entry.count === 0) throw invalidResponse();
    statuses.add(entry.status);
    return { status: entry.status as ReservationStatus, count: entry.count, people: entry.people };
  });
  if (byStatus.reduce((sum, entry) => sum + entry.count, 0) !== value.total
    || byStatus.reduce((sum, entry) => sum + entry.people, 0) !== value.total_people) throw invalidResponse();
  return { company_id: companyId, rows, total: value.total, total_people: value.total_people, by_status: byStatus, page: value.page, page_size: value.page_size };
}

export async function fetchReservationHistoryPage(companyId: string, page: number, filters: ReservationHistoryFilters, signal?: AbortSignal) {
  if (!companyId || !Number.isSafeInteger(page) || page < 1) throw new Error('A página da consulta é inválida.');
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const request = supabase.rpc('get_company_reservation_history' as never, {
    _company_id: companyId, _page: page, _page_size: RESERVATION_HISTORY_PAGE_SIZE, ...reservationHistoryFilterParams(filters),
  } as never);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) throw new Error('Não foi possível carregar as reservas. Tente novamente.');
  return parseReservationHistoryPage(data, companyId);
}
