import { addDays, startOfDay } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchReservationHistoryPage, parseReservationHistoryPage, reservationHistoryFilterParams,
  RESERVATION_HISTORY_PAGE_SIZE, type ReservationHistoryFilters,
} from './reservation-history';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));

const filters: ReservationHistoryFilters = { search: '', operationalFilter: 'active', status: 'all', entryMethod: 'all', dateFilterMode: 'reservation' };
const row = (id = 'reservation-1') => ({ id, company_id: 'company-a', guest_name: 'Maria', guest_phone: '(62) 99999-0000', date: '2026-11-22', time: '19:00:00', party_size: 3, status: 'confirmed', reservation_payments: [] });
function result(overrides: Record<string, unknown> = {}) {
  return { company_id: 'company-a', rows: [row()], total: 1, total_people: 3, by_status: [{ status: 'confirmed', count: 1, people: 3 }], page: 1, page_size: 15, ...overrides };
}
function respond(data: unknown, error: unknown = null) {
  const promise = Promise.resolve({ data, error });
  const builder = { then: promise.then.bind(promise), abortSignal: mocks.abort };
  mocks.abort.mockReturnValue(builder);
  mocks.rpc.mockReturnValue(builder);
}
beforeEach(() => { vi.clearAllMocks(); respond(result()); });

describe('reservation history server page', () => {
  it('loads one bounded page with every filter and no table/read-all fallback', async () => {
    const controller = new AbortController();
    await expect(fetchReservationHistoryPage('company-a', 2, { ...filters, search: 'Maria_100% +55', operationalFilter: 'lost', status: 'cancelled', entryMethod: 'affiliate' }, controller.signal)).resolves.toEqual(result());
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('get_company_reservation_history', {
      _company_id: 'company-a', _page: 2, _page_size: 15, _search: 'Maria_100% +55', _operational_filter: 'lost', _status: 'cancelled', _entry_method: 'affiliate',
      _date_filter_mode: 'reservation', _start_date: null, _end_date: null, _created_start_at: null, _created_end_at: null,
    });
    expect(mocks.abort).toHaveBeenCalledWith(controller.signal);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('uses full-filter counts instead of the visible page length', () => {
    const rows = Array.from({ length: RESERVATION_HISTORY_PAGE_SIZE }, (_, index) => row(`reservation-${index}`));
    const page = parseReservationHistoryPage(result({ rows, total: 5003, total_people: 15009, by_status: [{ status: 'confirmed', count: 5003, people: 15009 }] }), 'company-a');
    expect(page.rows).toHaveLength(15);
    expect(page.total).toBe(5003);
    expect(page.total_people).toBe(15009);
  });

  it('accepts a server-clamped final page while retaining its real page number', () => {
    const page = parseReservationHistoryPage(result({ page: 3, total: 31, total_people: 93, by_status: [{ status: 'confirmed', count: 31, people: 93 }] }), 'company-a');
    expect(page.page).toBe(3);
    expect(page.rows).toHaveLength(1);
  });

  it('accepts a confirmed empty result', () => {
    expect(parseReservationHistoryPage(result({ rows: [], total: 0, total_people: 0, by_status: [] }), 'company-a').total).toBe(0);
  });

  it('normalizes legacy row status and uses the canonical phone when present', () => {
    const page = parseReservationHistoryPage(result({ rows: [{ ...row(), status: 'completed', guest_phone_e164: '+5562999990000' }] }), 'company-a');
    expect(page.rows[0]).toMatchObject({ status: 'checked_in', guest_phone: '+5562999990000' });
  });

  it.each([
    result({ company_id: 'company-b' }), result({ rows: [{ ...row(), company_id: 'company-b' }] }),
    result({ total: 2 }), result({ total_people: 8 }), result({ page: 2 }), result({ page_size: 1000 }),
    result({ rows: [] }), result({ rows: [row(), row()] }), result({ rows: [{ ...row(), id: '' }] }),
    result({ by_status: [{ status: 'confirmed', count: 0, people: 3 }] }),
    result({ by_status: [{ status: 'completed', count: 1, people: 3 }] }),
    result({ total: 16, rows: Array.from({ length: 15 }, () => row()), by_status: [{ status: 'confirmed', count: 16, people: 3 }] }),
    { success: true }, null,
  ])('rejects malformed, partial, inconsistent or cross-company results', (response) => {
    expect(() => parseReservationHistoryPage(response, 'company-a')).toThrow('Não foi possível carregar o histórico completo deste filtro. Tente novamente.');
  });

  it('fails clearly when the RPC is unavailable and never falls back to all rows', async () => {
    respond(null, new Error('missing function'));
    await expect(fetchReservationHistoryPage('company-a', 1, filters)).rejects.toThrow('Não foi possível carregar as reservas. Tente novamente.');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('does not send a cancelled query and ignores a response cancelled in flight', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchReservationHistoryPage('company-a', 1, filters, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    const inFlight = new AbortController();
    const promise = fetchReservationHistoryPage('company-a', 1, filters, inFlight.signal);
    inFlight.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid page %s before querying', async (page) => {
    await expect(fetchReservationHistoryPage('company-a', page, filters)).rejects.toThrow('A página da consulta é inválida.');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('caps search input without silently changing its literal matching semantics', async () => {
    await expect(fetchReservationHistoryPage('company-a', 1, { ...filters, search: 'x'.repeat(201) })).rejects.toThrow('A busca deve ter até 200 caracteres.');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('reservation history date bounds', () => {
  const from = new Date(2026, 9, 1, 15, 0);
  const to = new Date(2026, 9, 30, 9, 0);
  it('sends inclusive local date keys for reservation dates', () => {
    expect(reservationHistoryFilterParams({ ...filters, range: { from, to } })).toMatchObject({ _start_date: '2026-10-01', _end_date: '2026-10-30', _created_start_at: null, _created_end_at: null });
  });
  it('sends start-of-day through exclusive next midnight for creation timestamps', () => {
    expect(reservationHistoryFilterParams({ ...filters, dateFilterMode: 'created', range: { from, to } })).toMatchObject({ _start_date: null, _end_date: null, _created_start_at: startOfDay(from).toISOString(), _created_end_at: startOfDay(addDays(to, 1)).toISOString() });
  });
  it.each(['created', 'reservation'] as const)('keeps a partial %s range open-ended', (dateFilterMode) => {
    const params = reservationHistoryFilterParams({ ...filters, dateFilterMode, range: { from } });
    expect(params._end_date).toBeNull(); expect(params._created_end_at).toBeNull();
  });
});
