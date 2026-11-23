import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompanyReservationSearchFilter,
  isCompanyGlobalSearchQueryReady,
  normalizeCompanyGlobalSearchQuery,
  searchCompanyGlobal,
} from './company-global-search';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  fetchCustomers: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/hooks/useCrmLeads', () => ({ fetchCrmLeadsPage: mocks.fetchCustomers }));

function reservation(id = 'reservation-1', companyId = 'unit-a') {
  return {
    id, company_id: companyId, guest_name: 'Ana Silva', guest_phone: '(62) 99965-9667',
    guest_phone_e164: '+5562999659667', date: '2026-10-30', time: '18:00:00',
    party_size: 5, status: 'confirmed', public_tracking_code: 'ABC123',
  };
}

function customers(total = 0) {
  return {
    leads: total ? [{ customer_key: 'phone:5562999659667', latest_name: 'Ana Silva' }] : [],
    meta: { filtered_leads: total },
  };
}

function reservationRequest(response: { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>) {
  const request = {
    select: vi.fn(), eq: vi.fn(), or: vi.fn(), order: vi.fn(), range: vi.fn(), abortSignal: vi.fn(),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
  };
  for (const key of ['select', 'eq', 'or', 'order', 'range', 'abortSignal'] as const) request[key].mockReturnValue(request);
  mocks.from.mockReturnValue(request);
  return request;
}

const params = {
  companyId: 'unit-a', query: 'Ana', canViewReservations: true, canViewCustomers: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  reservationRequest({ data: [], error: null });
  mocks.fetchCustomers.mockResolvedValue(customers());
});

describe('company global search', () => {
  it('normalizes whitespace and waits for three meaningful characters', async () => {
    expect(normalizeCompanyGlobalSearchQuery('  Ana   Silva  ')).toBe('Ana Silva');
    expect(isCompanyGlobalSearchQueryReady('An')).toBe(false);
    expect(isCompanyGlobalSearchQueryReady('(5)')).toBe(false);
    expect(isCompanyGlobalSearchQueryReady('999')).toBe(true);
    expect(isCompanyGlobalSearchQueryReady('Ana')).toBe(true);
    const result = await searchCompanyGlobal({ ...params, query: '  An  ' });
    expect(result.query).toBe('An');
    expect(result.reservations.items).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.fetchCustomers).not.toHaveBeenCalled();
  });

  it('never queries without a current unit or authorized section', async () => {
    await searchCompanyGlobal({ ...params, companyId: undefined });
    await searchCompanyGlobal({ ...params, companyId: ' ' });
    await searchCompanyGlobal({ ...params, canViewCustomers: false, canViewReservations: false });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.fetchCustomers).not.toHaveBeenCalled();
  });

  it('gates reservations and customer RPCs independently', async () => {
    await searchCompanyGlobal({ ...params, canViewReservations: false });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.fetchCustomers).toHaveBeenCalledOnce();
    mocks.fetchCustomers.mockClear();
    await searchCompanyGlobal({ ...params, canViewCustomers: false });
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.fetchCustomers).not.toHaveBeenCalled();
  });

  it('scopes the server query, selects only search fields and preserves deterministic pagination', async () => {
    const request = reservationRequest({ data: [reservation()], error: null });
    const controller = new AbortController();
    const result = await searchCompanyGlobal({ ...params, query: '  Ana   Silva ', reservationsPage: 2, customersPage: 3, signal: controller.signal });
    expect(request.eq).toHaveBeenCalledWith('company_id', 'unit-a');
    expect(request.select).toHaveBeenCalledWith('id, company_id, guest_name, guest_phone, guest_phone_e164, date, time, party_size, status, public_tracking_code');
    expect(request.order.mock.calls).toEqual([
      ['date', { ascending: false }], ['time', { ascending: false }], ['id', { ascending: true }],
    ]);
    expect(request.range).toHaveBeenCalledWith(8, 16);
    expect(request.abortSignal).toHaveBeenCalledWith(controller.signal);
    expect(mocks.fetchCustomers).toHaveBeenCalledWith({ companyId: 'unit-a', search: 'Ana Silva', page: 3, pageSize: 8 }, controller.signal);
    expect(result.reservations).toMatchObject({ page: 2, hasMore: false, error: null });
    expect(result.query).toBe('Ana Silva');
  });

  it('uses the ninth reservation only as an explicit next-page indicator', async () => {
    reservationRequest({ data: Array.from({ length: 9 }, (_, index) => reservation(`r-${index}`)), error: null });
    mocks.fetchCustomers.mockResolvedValue(customers(9));
    const result = await searchCompanyGlobal(params);
    expect(result.reservations.items).toHaveLength(8);
    expect(result.reservations.hasMore).toBe(true);
    expect(result.customers.hasMore).toBe(true);
  });

  it('uses the CRM count for the requested customer page', async () => {
    mocks.fetchCustomers.mockResolvedValue(customers(16));
    const result = await searchCompanyGlobal({ ...params, customersPage: 2 });
    expect(result.customers.hasMore).toBe(false);
    expect(result.customers.page).toBe(2);
  });

  it('keeps section errors explicit while allowing the other section to work', async () => {
    reservationRequest({ data: null, error: { message: 'database internal details' } });
    mocks.fetchCustomers.mockResolvedValue(customers(1));
    const result = await searchCompanyGlobal(params);
    expect(result.reservations).toMatchObject({ items: [], hasMore: false, error: 'Não foi possível buscar reservas. Tente novamente.' });
    expect(result.customers.items).toHaveLength(1);
    expect(result.customers.error).toBeNull();
  });

  it('does not turn a customer RPC failure into an empty successful section', async () => {
    reservationRequest({ data: [reservation()], error: null });
    mocks.fetchCustomers.mockRejectedValue(new Error('failed'));
    const result = await searchCompanyGlobal(params);
    expect(result.customers.error).toBe('Não foi possível buscar clientes. Tente novamente.');
    expect(result.reservations.items).toHaveLength(1);
  });

  it('rejects records belonging to a different unit before returning any row', async () => {
    reservationRequest({ data: [reservation(), reservation('r-other', 'unit-b')], error: null });
    const result = await searchCompanyGlobal(params);
    expect(result.reservations.items).toEqual([]);
    expect(result.reservations.error).toBeTruthy();
  });

  it('rejects malformed and duplicate reservation pages', async () => {
    reservationRequest({ data: [{ id: 'incomplete' }], error: null });
    expect((await searchCompanyGlobal(params)).reservations.error).toBeTruthy();
    reservationRequest({ data: [reservation(), reservation()], error: null });
    expect((await searchCompanyGlobal(params)).reservations.error).toBeTruthy();
  });

  it('cancels before issuing requests and after an in-flight response', async () => {
    const stopped = new AbortController();
    stopped.abort();
    await expect(searchCompanyGlobal({ ...params, signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.from).not.toHaveBeenCalled();

    const active = new AbortController();
    let finish!: (value: { data: unknown; error: unknown }) => void;
    reservationRequest(new Promise(resolve => { finish = resolve; }));
    const pending = searchCompanyGlobal({ ...params, signal: active.signal, canViewCustomers: false });
    active.abort();
    finish({ data: [reservation()], error: null });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects oversized queries and invalid pages without making requests', async () => {
    await expect(searchCompanyGlobal({ ...params, query: 'a'.repeat(201) })).rejects.toThrow('200 caracteres');
    await expect(searchCompanyGlobal({ ...params, reservationsPage: 0 })).rejects.toThrow('página');
    await expect(searchCompanyGlobal({ ...params, customersPage: 1.5 })).rejects.toThrow('página');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.fetchCustomers).not.toHaveBeenCalled();
  });
});

describe('reservation search filter', () => {
  it('quotes grammar delimiters so search input cannot add a filter', () => {
    const filter = buildCompanyReservationSearchFilter('Ana",status.eq.cancelled,(name');
    expect(filter).toBe([
      `guest_name.ilike.${JSON.stringify('%Ana",status.eq.cancelled,(name%')}`,
      `public_tracking_code.ilike.${JSON.stringify('%Ana",status.eq.cancelled,(name%')}`,
    ].join(','));
  });

  it('escapes LIKE wildcards and backslashes and does not expand asterisks', () => {
    const pattern = '%Ana\\_100\\%\\\\nome%';
    expect(buildCompanyReservationSearchFilter('Ana_100%\\nome')).toContain(`guest_name.ilike.${JSON.stringify(pattern)}`);
    expect(buildCompanyReservationSearchFilter('Ana*')).toBe('guest_name.eq."Ana*",public_tracking_code.eq."Ana*"');
  });

  it('searches full Brazilian phones through canonical, national and formatted variants', () => {
    const filter = buildCompanyReservationSearchFilter('(62) 99965-9667');
    expect(filter).toContain('guest_phone_e164.ilike."%+5562999659667%"');
    expect(filter).toContain('guest_phone.ilike."%62999659667%"');
    expect(filter).toContain('guest_phone.ilike."%(62) 99965-9667%"');
  });

  it('supports international and partial phone input without using digits extracted from a name', () => {
    expect(buildCompanyReservationSearchFilter('+1 407 264 1934')).toContain('guest_phone_e164.ilike."%14072641934%"');
    expect(buildCompanyReservationSearchFilter('9667')).toContain('guest_phone_e164.ilike."%9667%"');
    expect(buildCompanyReservationSearchFilter('Ana 123')).not.toContain('guest_phone');
  });
});
