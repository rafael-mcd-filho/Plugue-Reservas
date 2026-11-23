import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCrmMessageStatusLabel, getCrmReservationStatusLabel, getCrmRelationshipPage, parseCrmRelationshipPage, type CrmRelationshipSection } from './crm-relationship';

const mock = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
const request = { companyId: 'unit-a', customerKey: 'phone:5562999990000', section: 'summary' as CrmRelationshipSection };
const reservation = { id: 'reservation-a', date: '2026-11-25', time: '19:00:00', party_size: 4, status: 'confirmed', source: 'reservation', occasion: null, is_upcoming: true, relationship_role: 'holder', holder_name: 'Ana' };
const payment = { id: 'payment-a', reservation_id: 'reservation-a', reservation_date: '2026-11-25', reservation_time: '19:00:00', status: 'paid', billing_type: 'PIX', base_amount: 50, charged_amount: 54, paid_at: '2026-11-22T18:30:00Z', created_at: '2026-11-22T18:00:00Z', refunded_at: null };
const message = { id: 'evolution:message-a', channel: 'evolution', type: 'waitlist_called', status: 'pending', created_at: '2026-11-22T18:30:00Z', reservation_id: null, record_source: 'log', provider_status: null, message_preview: 'Ana, sua mesa está pronta.' };
function snapshot(section: CrmRelationshipSection = 'summary', overrides = {}) {
  return {
    company_id: request.companyId, customer_key: request.customerKey, section, page: 1, page_size: 25,
    total: section === 'summary' ? 0 : 1, rows: section === 'summary' ? [] : [section === 'reservations' ? reservation : section === 'payments' ? payment : message],
    capabilities: { reservations: true, payments: true, messages: true },
    summary: { upcoming_count: 1, reservation_count: 8, cancelled_count: 2, no_show_count: 1 }, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.rpc.mockImplementation((_name, args) => {
    const result = Promise.resolve({ data: snapshot(args._section), error: null });
    return Object.assign(result, { abortSignal: mock.abortSignal.mockReturnValue(result) });
  });
});

describe('CRM relationship contract', () => {
  it.each(['summary', 'reservations', 'payments', 'messages'] as const)('loads only the selected %s section by exact unit/customer key', async (section) => {
    const signal = new AbortController().signal;
    await expect(getCrmRelationshipPage({ ...request, section, signal })).resolves.toMatchObject(snapshot(section));
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(mock.rpc).toHaveBeenCalledWith('get_company_crm_relationship', {
      _company_id: 'unit-a', _customer_key: 'phone:5562999990000', _section: section, _page: 1, _page_size: 25,
    });
    expect(mock.abortSignal).toHaveBeenCalledWith(signal);
  });

  it('bounds requests and does not transmit the contact profile or a raw phone separately', async () => {
    await getCrmRelationshipPage({ ...request, page: -10, pageSize: 1000 });
    expect(mock.rpc.mock.calls[0][1]).toEqual({ _company_id: 'unit-a', _customer_key: request.customerKey, _section: 'summary', _page: 1, _page_size: 100 });
  });

  it('keeps denied counts unknown and preserves empty authorized sections', () => {
    const value = snapshot('summary', { capabilities: { reservations: false, payments: false, messages: false }, summary: { upcoming_count: null, reservation_count: null, cancelled_count: null, no_show_count: null } });
    expect(parseCrmRelationshipPage(value, request).summary.reservation_count).toBeNull();
    expect(parseCrmRelationshipPage(snapshot('messages', { rows: [], total: 0 }), { ...request, section: 'messages' }).rows).toEqual([]);
  });

  it.each([
    snapshot('summary', { company_id: 'unit-b' }), snapshot('summary', { customer_key: 'phone:other' }),
    snapshot('summary', { section: 'payments' }), snapshot('summary', { capabilities: { reservations: 'yes', payments: true, messages: true } }),
    snapshot('summary', { summary: { upcoming_count: '8', reservation_count: 8, cancelled_count: 2, no_show_count: 1 } }),
    snapshot('summary', { total: 1 }), snapshot('summary', { rows: [reservation] }), null,
  ])('rejects a mismatched, unknown or unscoped summary', (value) => {
    expect(() => parseCrmRelationshipPage(value, request)).toThrow('Não foi possível carregar o relacionamento');
  });

  it.each([
    snapshot('reservations', { rows: [{ ...reservation, date: '2026-02-31' }] }),
    snapshot('reservations', { rows: [{ ...reservation, time: '29:00' }] }),
    snapshot('reservations', { rows: [{ ...reservation, relationship_role: 'guessed' }] }),
    snapshot('reservations', { rows: [reservation, reservation], total: 2 }),
    snapshot('reservations', { rows: [], total: 80 }),
    snapshot('reservations', { page: 5 }),
    snapshot('reservations', { capabilities: { reservations: false, payments: true, messages: true } }),
  ])('rejects incomplete pages or invalid reservation relationships instead of presenting them as complete', (value) => {
    expect(() => parseCrmRelationshipPage(value, { ...request, section: 'reservations' })).toThrow();
  });

  it('keeps zero distinct from unavailable amounts and does not derive refunds', () => {
    const result = parseCrmRelationshipPage(snapshot('payments', { rows: [{ ...payment, status: 'refunded', charged_amount: 0, base_amount: null, refunded_at: null }] }), { ...request, section: 'payments' });
    expect(result.rows[0]).toMatchObject({ status: 'refunded', charged_amount: 0, base_amount: null, refunded_at: null });
    expect(() => parseCrmRelationshipPage(snapshot('payments', { rows: [{ ...payment, charged_amount: -2 }] }), { ...request, section: 'payments' })).toThrow();
  });

  it('strips unexpected provider fields and rejects non-log communication records', () => {
    const result = parseCrmRelationshipPage(snapshot('messages', { rows: [{ ...message, provider_secret: 'must-not-be-returned', error_details: 'raw response' }] }), { ...request, section: 'messages' });
    expect(result.rows[0]).toEqual(message);
    expect(() => parseCrmRelationshipPage(snapshot('messages', { rows: [{ ...message, record_source: 'queue' }] }), { ...request, section: 'messages' })).toThrow();
  });

  it('does not expose raw database errors', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: new Error('permission details/secret') });
    await expect(getCrmRelationshipPage(request)).rejects.toThrow('Não foi possível carregar o relacionamento deste cliente.');
  });

  it('cancels stale requests without another RPC', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(getCrmRelationshipPage({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it('does not infer delivery or reading from an accepted Evolution log', () => {
    expect(getCrmMessageStatusLabel({ channel: 'evolution', status: 'pending', provider_status: null })).toBe('Aceita pelo canal');
    expect(getCrmMessageStatusLabel({ channel: 'pluguechat_official', status: 'sent', provider_status: null })).toBe('Enviada');
    expect(getCrmMessageStatusLabel({ channel: 'pluguechat_official', status: 'sent', provider_status: 'READ' })).toBe('Leitura registrada');
  });

  it('does not present unrecognized reservation states as confirmed visits', () => {
    expect(getCrmReservationStatusLabel('confirmed')).toBe('Confirmada');
    expect(getCrmReservationStatusLabel('completed')).toBe('Check-in realizado');
    expect(getCrmReservationStatusLabel('future_provider_status')).toBe('Estado não reconhecido');
  });
});
