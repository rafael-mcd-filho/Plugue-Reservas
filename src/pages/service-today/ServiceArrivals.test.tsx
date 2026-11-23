import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServiceArrivals from './ServiceArrivals';
import type { ServiceTodayContext } from '@/lib/service-today';

const state = vi.hoisted(() => ({
  queries: {} as Record<string, any>, options: new Map<string, any>(), rpc: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ data: {}, error: null }), from: vi.fn(), details: vi.fn(),
}));
vi.mock('@tanstack/react-query', async original => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => {
    state.options.set(options.queryKey[0], options);
    return { data: [], isPending: false, isLoading: false, isFetching: false, isError: false,
      dataUpdatedAt: 1795374600000, refetch: vi.fn(), ...state.queries[options.queryKey[0]] };
  },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: state.from, rpc: state.rpc, functions: { invoke: state.invoke },
} }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'company-a', slug: 'unidade' }) }));
vi.mock('@/components/ReservationDetailsDialog', () => ({ default: (props: any) => {
  state.details(props);
  return props.open ? <div data-testid="reservation-details">Detalhes completos de {props.reservation?.guest_name}</div> : null;
} }));
vi.mock('@/components/PhoneWhatsAppLink', () => ({ default: () => null }));

const context: ServiceTodayContext = {
  date: '2026-11-22', search: 'Cliente', section: 'all', period: 'all', timeZone: 'America/Sao_Paulo',
  canViewReservations: true, canViewLeads: false, canViewEvents: false,
};
const reservation = (overrides: Record<string, unknown> = {}) => ({
  id: 'dinner', company_id: 'company-a', date: '2026-11-22', time: '18:00:00', guest_name: 'Cliente jantar',
  guest_phone: '+5511999991111', guest_email: null, party_size: 4, checked_in_party_size: null,
  status: 'confirmed', table_id: 'table-main', occasion: null, notes: null, source: 'manual',
  public_tracking_code: 'ABCDEF', checked_in_at: null, created_at: '2026-11-22T17:00:00Z',
  updated_at: '2026-11-22T17:00:00Z', duration_minutes: 60, created_in_mode: 'tables', reservation_payments: [],
  ...overrides,
});
const tables = [
  { id: 'table-main', number: 1, capacity: 6, section: 'Salão', status: 'available', table_map_id: null },
  { id: 'table-patio', number: 2, capacity: 4, section: 'Varanda', status: 'available', table_map_id: null },
  { id: 'table-secondary', number: 3, capacity: 4, section: 'Salão', status: 'available', table_map_id: null },
];
const clients: QueryClient[] = [];
function mount(value: ServiceTodayContext | undefined = context) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const content = (next = value) => <QueryClientProvider client={client}><ServiceArrivals serviceContext={next} /></QueryClientProvider>;
  return { ...render(content()), client, rerenderContext(next: ServiceTodayContext) { return this.rerender(content(next)); } };
}
function pendingCard(name: string) { return screen.getByText(name).closest('[role="button"]') as HTMLElement; }
function summaryValue(label: string) {
  const summary = screen.getByRole('region', { name: 'Resumo de reservas' });
  const indicator = within(summary).getByText(label, { exact: true }).parentElement!.parentElement!;
  return { summary, indicator };
}
function expectSummary(values: { total: number; pending: number; checkedIn: number; issues: number }) {
  for (const [label, value] of Object.entries({ Reservas: values.total, Pendentes: values.pending, 'Check-ins': values.checkedIn, Ocorrências: values.issues })) {
    expect(within(summaryValue(label).indicator).getByText(String(value), { exact: true })).toBeInTheDocument();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.options.clear();
  state.queries = {
    'today-reservations': { data: [reservation(),
      reservation({ id: 'lunch', guest_name: 'Cliente almoço', time: '17:59:00', table_id: 'table-main', guest_phone: '+5511888881111' }),
      reservation({ id: 'patio', guest_name: 'Cliente varanda', time: '18:15:00', table_id: 'table-patio', guest_phone: '+5511777771111' }),
      reservation({ id: 'multi', guest_name: 'Cliente multimesas', time: '18:30:00', table_id: 'table-patio', guest_phone: '+5511666661111', reservation_table_assignments: [{ table_id: 'table-patio' }, { table_id: 'table-secondary' }] }),
    ] },
    'operator-public-schedule': { data: { slots: [], source: 'default', availability_mode: 'tables' } },
    'operator-public-availability': { data: {} },
    'operator-reservation-settings': { data: { reservation_duration: 60, max_guests_per_slot: null } },
    'operator-table-maps': { data: [] },
    'operator-restaurant-tables': { data: tables },
  };
  state.rpc.mockImplementation(async (name, params) => ({ data: reservation({ id: params._reservation_id, status: name === 'check_in_reservation' ? 'checked_in' : params._status, checked_in_party_size: params._checked_in_party_size }), error: null }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); });

describe('ServiceArrivals parallel integration', () => {
  it('embeds the complete arrival lists without duplicating the host heading or search', () => {
    mount();
    expect(screen.queryByRole('heading', { name: 'Check-ins de hoje' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Buscar reserva por nome ou telefone...')).not.toBeInTheDocument();
    expect(screen.getByText('Aguardando chegada')).toBeInTheDocument();
    expect(screen.getByText('Cliente jantar')).toBeInTheDocument();
    expect(screen.getAllByTitle('Ocupação total da faixa').length).toBeGreaterThan(0);
  });

  it('keeps the copied standalone presentation available without a service context', () => {
    const client = new QueryClient(); clients.push(client);
    render(<QueryClientProvider client={client}><ServiceArrivals /></QueryClientProvider>);
    expect(screen.getByRole('heading', { name: 'Check-ins de hoje' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buscar reserva por nome ou telefone...')).toBeInTheDocument();
  });

  it('scopes the visible reservations and summary to period/section, including a secondary table assignment', () => {
    mount({ ...context, period: 'dinner', section: 'Salão' });
    expect(screen.getByText('Cliente jantar')).toBeInTheDocument();
    expect(screen.getByText('Cliente multimesas')).toBeInTheDocument();
    expect(screen.queryByText('Cliente almoço')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente varanda')).not.toBeInTheDocument();
    expectSummary({ total: 2, pending: 2, checkedIn: 0, issues: 0 });
    // Capacity still includes other groups occupying the same schedule band.
    expect(screen.getAllByTitle('Ocupação total da faixa').length).toBeGreaterThan(0);
  });

  it('partitions all eight canonical statuses into four booking indicators without a people indicator', () => {
    const statuses = ['confirmed', 'checked_in', 'cancelled', 'no-show', 'pending_payment', 'payment_expired', 'payment_cancelled', 'paid_after_expiration'];
    state.queries['today-reservations'].data = statuses.map(status => reservation({
      id: status, status, guest_name: status === 'pending_payment' ? 'Cliente aguardando pagamento' : `Cliente ${status}`,
    }));
    mount();

    expectSummary({ total: 8, pending: 1, checkedIn: 1, issues: 6 });
    const { summary, indicator } = summaryValue('Ocorrências');
    expect(within(summary).queryByText('Pessoas', { exact: true })).not.toBeInTheDocument();
    expect(within(indicator).getByText('No Show/canc./pag.')).toBeInTheDocument();
    expect(indicator).toHaveAttribute('title', expect.stringMatching(/cancelamentos.*No Show.*pagamento/i));
    expect(screen.getByText(/Check-ins, cancelamentos.*pagamento/i)).toBeInTheDocument();
    expect(within(pendingCard('Cliente aguardando pagamento')).queryByRole('button', { name: 'Realizar check-in' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Realizar check-in' })).toHaveLength(1);
  });

  it('uses the same search scope for the total, every status indicator and the visible lists', () => {
    const statuses = ['confirmed', 'checked_in', 'pending_payment', 'cancelled', 'no-show', 'payment_expired', 'payment_cancelled', 'paid_after_expiration'];
    state.queries['today-reservations'].data = statuses.map((status, index) => reservation({
      id: status, status, guest_name: `Cliente ${index < 3 ? 'dentro' : 'fora'} ${status}`,
    }));
    const view = mount();
    expectSummary({ total: 8, pending: 1, checkedIn: 1, issues: 6 });

    view.rerenderContext({ ...context, search: 'Cliente dentro' });
    expectSummary({ total: 3, pending: 1, checkedIn: 1, issues: 1 });
    expect(screen.getByText('Cliente dentro confirmed')).toBeInTheDocument();
    expect(screen.getByText('Cliente dentro checked_in')).toBeInTheDocument();
    expect(screen.getByText('Cliente dentro pending_payment')).toBeInTheDocument();
    expect(screen.queryByText('Cliente fora cancelled')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente fora paid_after_expiration')).not.toBeInTheDocument();
  });

  it('keeps the short occurrence hint when the selected bookings contain no payment situations', () => {
    state.queries['today-reservations'].data = [reservation(), reservation({ id: 'cancelled', status: 'cancelled', guest_name: 'Cliente cancelado' })];
    mount();
    expectSummary({ total: 2, pending: 1, checkedIn: 0, issues: 1 });
    expect(within(summaryValue('Ocorrências').indicator).getByText('No Show/canc.')).toBeInTheDocument();
    expect(screen.queryByText(/Check-ins, cancelamentos.*pagamento/i)).not.toBeInTheDocument();
  });

  it('normalizes legacy statuses through the real day query before counting the summary', async () => {
    const legacyRows = [
      reservation({ id: 'legacy-pending', status: 'pending', guest_name: 'Cliente pendente' }),
      reservation({ id: 'legacy-completed', status: 'completed', guest_name: 'Cliente concluído' }),
      reservation({ id: 'legacy-no-show', status: 'no_show', guest_name: 'Cliente ausente' }),
    ];
    const builder: any = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockResolvedValue({ data: legacyRows, error: null }) };
    state.from.mockReturnValue(builder);
    const view = mount();
    const normalized = await state.options.get('today-reservations').queryFn();
    state.queries['today-reservations'].data = normalized;
    view.rerenderContext({ ...context });

    expectSummary({ total: 3, pending: 1, checkedIn: 1, issues: 1 });
    expect(within(pendingCard('Cliente pendente')).getByRole('button', { name: 'Realizar check-in' })).toBeInTheDocument();
    expect(within(pendingCard('Cliente concluído')).queryByRole('button', { name: 'Realizar check-in' })).not.toBeInTheDocument();
    expect(within(pendingCard('Cliente ausente')).queryByRole('button', { name: 'Realizar check-in' })).not.toBeInTheDocument();
  });

  it('handles the 18h boundary and reuses the shared search for table numbers and tracking codes', () => {
    const view = mount({ ...context, period: 'lunch' });
    expect(screen.getByText('Cliente almoço')).toBeInTheDocument();
    expect(screen.queryByText('Cliente jantar')).not.toBeInTheDocument();
    view.rerenderContext({ ...context, search: 'mesa 3' });
    expect(screen.getByText('Cliente multimesas')).toBeInTheDocument();
    expect(screen.queryByText('Cliente varanda')).not.toBeInTheDocument();
    view.rerenderContext({ ...context, search: 'ABCDEF' });
    expect(screen.getByText('Cliente jantar')).toBeInTheDocument();
  });

  it('uses the selected unit calendar day in the existing reservation/schedule query keys and request', async () => {
    const eq = vi.fn();
    const builder: any = { select: vi.fn().mockReturnThis(), eq: (...args: unknown[]) => { eq(...args); return builder; }, order: vi.fn().mockResolvedValue({ data: [], error: null }) };
    state.from.mockReturnValue(builder);
    mount({ ...context, date: '2026-11-23' });
    expect(state.options.get('today-reservations').queryKey).toEqual(['today-reservations', 'company-a', '2026-11-23']);
    expect(state.options.get('operator-public-schedule').queryKey).toEqual(['operator-public-schedule', 'company-a', '2026-11-23']);
    await state.options.get('today-reservations').queryFn();
    expect(eq).toHaveBeenCalledWith('date', '2026-11-23');
    expect(eq).toHaveBeenCalledWith('company_id', 'company-a');
  });

  it('publishes unique section names from the already-authorized table query', async () => {
    const onSectionsChange = vi.fn();
    mount({ ...context, onSectionsChange });
    await waitFor(() => expect(onSectionsChange).toHaveBeenCalledWith(['Salão', 'Varanda']));
    expect(state.from).not.toHaveBeenCalled();
  });

  it('publishes and filters the same Sem seção category used by Salon for unsectioned tables', async () => {
    state.queries['operator-restaurant-tables'].data = tables.map((table, index) => index === 0 ? { ...table, section: null } : table);
    const onSectionsChange = vi.fn();
    mount({ ...context, section: 'Sem seção', onSectionsChange });
    expect(screen.getByText('Cliente jantar')).toBeInTheDocument();
    expect(screen.getByText('Cliente almoço')).toBeInTheDocument();
    expect(screen.queryByText('Cliente varanda')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente multimesas')).not.toBeInTheDocument();
    await waitFor(() => expect(onSectionsChange).toHaveBeenCalledWith(['Salão', 'Sem seção', 'Varanda']));
  });

  it('offers the Salon shortcut only when the host permits it, without also opening reservation details', () => {
    const onOpenSalon = vi.fn();
    const view = mount({ ...context, onOpenSalon });
    fireEvent.click(screen.getByRole('button', { name: 'Ver mesa da reserva de Cliente multimesas' }));
    expect(onOpenSalon).toHaveBeenCalledWith('table-patio');
    view.rerenderContext(context);
    expect(screen.queryByRole('button', { name: /Ver mesa da reserva/ })).not.toBeInTheDocument();
  });

  it('preserves check-in actual-party and duplicate detection across a filtered-out period, and refreshes Salon', async () => {
    state.queries['today-reservations'].data[1].guest_phone = '+5511999991111';
    const { client } = mount({ ...context, period: 'dinner', search: 'Cliente jantar' });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(within(pendingCard('Cliente jantar')).getByRole('button', { name: 'Realizar check-in' }));
    fireEvent.change(screen.getByLabelText('Total presente'), { target: { value: '3' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar check-in' })); });
    expect(state.rpc).toHaveBeenCalledWith('check_in_reservation', { _reservation_id: 'dinner', _checked_in_party_size: 3, _companions: [] });
    expect(await screen.findByText('Outra reserva para este cliente')).toBeInTheDocument();
    expect(screen.getByText('Cliente almoço')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['service-today-salon', 'company-a'] });
  });

  it('keeps no-show confirmation and the original status RPC', async () => {
    mount({ ...context, search: 'Cliente jantar' });
    fireEvent.click(within(pendingCard('Cliente jantar')).getByRole('button', { name: 'Marcar como no-show' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar No-Show' })); });
    expect(state.rpc).toHaveBeenCalledWith('update_reservation_status', { _reservation_id: 'dinner', _status: 'no-show' });
  });

  it('allows checkins-only actions without opening full reservation details or customer history', async () => {
    mount({ ...context, search: 'Cliente jantar', canViewReservations: false });
    fireEvent.click(screen.getByText('Cliente jantar'));
    expect(screen.queryByTestId('reservation-details')).not.toBeInTheDocument();
    expect(state.details.mock.calls.every(([props]) => !props.open && props.reservation === null && !props.showLeadHistory)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Realizar check-in' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar check-in' })); });
    expect(state.rpc).toHaveBeenCalledWith('check_in_reservation', { _reservation_id: 'dinner', _checked_in_party_size: 4, _companions: [] });
    expect(screen.queryByTestId('reservation-details')).not.toBeInTheDocument();
  });

  it('separates detail, customer-history and event permissions and closes details when access is revoked', () => {
    const view = mount({ ...context, search: 'Cliente jantar', canViewLeads: true, canViewEvents: true });
    fireEvent.click(screen.getByText('Cliente jantar'));
    expect(screen.getByTestId('reservation-details')).toHaveTextContent('Cliente jantar');
    expect(state.details.mock.calls.some(([props]) => props.open && props.showLeadHistory && props.showEventHistory)).toBe(true);
    view.rerenderContext({ ...context, search: 'Cliente jantar', canViewReservations: false, canViewLeads: false, canViewEvents: false });
    expect(screen.queryByTestId('reservation-details')).not.toBeInTheDocument();
    const latest = state.details.mock.calls.slice(-2).map(([props]) => props);
    expect(latest.every(props => !props.open && !props.showLeadHistory && !props.showEventHistory)).toBe(true);
  });

  it('keeps a failed day load distinct from a successful empty list without duplicating the heading', () => {
    state.queries['today-reservations'] = { data: undefined, isError: true, dataUpdatedAt: 0 };
    mount();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as reservas do dia.');
    expect(screen.queryByText('Aguardando chegada')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Check-ins de hoje' })).not.toBeInTheDocument();
  });

  it('computes lateness using the unit time zone across a UTC date boundary', () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-22T21:10:00Z'));
    state.queries['today-reservations'].data = [reservation({ date: '2026-11-23', time: '06:00:00' })];
    mount({ ...context, date: '2026-11-23', timeZone: 'Asia/Tokyo', search: 'Cliente jantar' });
    expect(screen.getByText('Atrasada há 10 min')).toBeInTheDocument();
  });
});
