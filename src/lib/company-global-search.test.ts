import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompanyReservationSearchFilter,
  isCompanyGlobalSearchQueryReady,
  normalizeCompanyGlobalSearchQuery,
  normalizeCustomerSearchPage,
  searchCompanyGlobal,
} from './company-global-search';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

function reservation(id = 'reservation-1', companyId = 'unit-a') {
  return {
    id, company_id: companyId, guest_name: 'Ana Silva', guest_phone: '(62) 99965-9667',
    guest_phone_e164: '+5562999659667', date: '2026-10-30', time: '18:00:00',
    party_size: 5, status: 'confirmed', public_tracking_code: 'ABC123',
  };
}

function lead(index = 0) {
  return {
    customer_key: `phone:55629996596${String(index).padStart(2, '0')}`,
    phone_normalized: `55629996596${String(index).padStart(2, '0')}`,
    display_phone: '(62) 99965-9667',
    latest_name: 'Ana Silva',
    latest_email: null,
    latest_birthdate: null,
    first_seen_at: '2026-10-01T12:00:00+00:00',
    last_visit_date: null,
    last_visit_time: null,
    state_code: 'GO',
    state_name: 'Goiás',
    source: 'reservation_holder',
    canonical_visit_count: 1,
    is_import_only: false,
    crm_lead: null,
  };
}

function customers(count = 0, { page = 1, hasMore = false } = {}) {
  return {
    leads: Array.from({ length: count }, (_, index) => lead(index)),
    meta: { page, page_size: 10, has_more: hasMore, generated_at: '2026-11-23T12:00:00+00:00' },
  };
}

function customerRequest(response: { data: unknown; error: unknown }) {
  const request = {
    abortSignal: vi.fn(),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
  };
  request.abortSignal.mockReturnValue(request);
  mocks.rpc.mockReturnValue(request);
  return request;
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
  customerRequest({ data: customers(), error: null });
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
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('never queries without a current unit or authorized section', async () => {
    await searchCompanyGlobal({ ...params, companyId: undefined });
    await searchCompanyGlobal({ ...params, companyId: ' ' });
    await searchCompanyGlobal({ ...params, canViewCustomers: false, canViewReservations: false });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('gates reservations and customer RPCs independently', async () => {
    await searchCompanyGlobal({ ...params, canViewReservations: false });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledOnce();
    mocks.rpc.mockClear();
    await searchCompanyGlobal({ ...params, canViewCustomers: false });
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('scopes the server query, selects only search fields and preserves deterministic pagination', async () => {
    const request = reservationRequest({ data: [reservation()], error: null });
    const customerCall = customerRequest({ data: customers(0, { page: 3 }), error: null });
    const controller = new AbortController();
    const result = await searchCompanyGlobal({ ...params, query: '  Ana   Silva ', reservationsPage: 2, customersPage: 3, signal: controller.signal });
    expect(request.eq).toHaveBeenCalledWith('company_id', 'unit-a');
    expect(request.select).toHaveBeenCalledWith('id, company_id, guest_name, guest_phone, guest_phone_e164, date, time, party_size, status, public_tracking_code');
    expect(request.order.mock.calls).toEqual([
      ['date', { ascending: false }], ['time', { ascending: false }], ['id', { ascending: true }],
    ]);
    expect(request.range).toHaveBeenCalledWith(10, 20);
    expect(request.abortSignal).toHaveBeenCalledWith(controller.signal);
    expect(mocks.rpc).toHaveBeenCalledWith('search_crm_leads', { _company_id: 'unit-a', _search: 'Ana Silva', _page: 3, _page_size: 10 });
    expect(customerCall.abortSignal).toHaveBeenCalledWith(controller.signal);
    expect(result.customers).toMatchObject({ page: 3, hasMore: false, error: null });
    expect(result.reservations).toMatchObject({ page: 2, hasMore: false, error: null });
    expect(result.query).toBe('Ana Silva');
  });

  it('uses the eleventh reservation only as an explicit next-page indicator', async () => {
    reservationRequest({ data: Array.from({ length: 11 }, (_, index) => reservation(`r-${index}`)), error: null });
    customerRequest({ data: customers(10, { hasMore: true }), error: null });
    const result = await searchCompanyGlobal(params);
    expect(result.reservations.items).toHaveLength(10);
    expect(result.reservations.hasMore).toBe(true);
    expect(result.customers.hasMore).toBe(true);
  });

  it('uses the server next-page flag for the requested customer page', async () => {
    customerRequest({ data: customers(10, { page: 2 }), error: null });
    const result = await searchCompanyGlobal({ ...params, customersPage: 2 });
    expect(result.customers.items).toHaveLength(10);
    expect(result.customers.hasMore).toBe(false);
    expect(result.customers.page).toBe(2);
  });

  it('rejects inconsistent customer pages instead of showing partial data', async () => {
    expect(() => normalizeCustomerSearchPage(customers(1, { page: 2 }), 1)).toThrow('inconsistente');
    expect(() => normalizeCustomerSearchPage(customers(3, { hasMore: true }), 1)).toThrow('inconsistente');
    expect(() => normalizeCustomerSearchPage({ leads: [lead(), lead()], meta: customers().meta }, 1)).toThrow('repetidos');
    expect(() => normalizeCustomerSearchPage({ leads: [{ latest_name: 'Sem chave' }], meta: customers().meta }, 1)).toThrow('repetidos');
    expect(() => normalizeCustomerSearchPage({ leads: [] }, 1)).toThrow('inválidos');
    expect(normalizeCustomerSearchPage([customers(2)], 1).items.map((item) => item.customer_key)).toEqual(['phone:5562999659600', 'phone:5562999659601']);
    customerRequest({ data: customers(11), error: null });
    expect((await searchCompanyGlobal(params)).customers.error).toBe('Não foi possível buscar clientes. Tente novamente.');
  });

  it('keeps section errors explicit while allowing the other section to work', async () => {
    reservationRequest({ data: null, error: { message: 'database internal details' } });
    customerRequest({ data: customers(1), error: null });
    const result = await searchCompanyGlobal(params);
    expect(result.reservations).toMatchObject({ items: [], hasMore: false, error: 'Não foi possível buscar reservas. Tente novamente.' });
    expect(result.customers.items).toHaveLength(1);
    expect(result.customers.error).toBeNull();
  });

  it('does not turn a customer RPC failure into an empty successful section', async () => {
    reservationRequest({ data: [reservation()], error: null });
    customerRequest({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
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
    expect(mocks.rpc).not.toHaveBeenCalled();
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
