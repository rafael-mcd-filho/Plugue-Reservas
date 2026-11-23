import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reservations from './Reservations';
import OperatorTodayReservations from './OperatorTodayReservations';

const state = vi.hoisted(() => ({ queries: {} as Record<string, any>, refetch: vi.fn().mockResolvedValue({}) }));
vi.mock('@tanstack/react-query', async (original) => ({
  ...await original<typeof import('@tanstack/react-query')>(),
  useQuery: ({ queryKey }: any) => {
    const query = { data: [], isLoading: false, isPending: false, isFetching: false, isError: false, dataUpdatedAt: 1795264200000, refetch: state.refetch, ...state.queries[queryKey[0]] };
    if (queryKey[0] === 'reservations' && queryKey[2] === 'list' && typeof queryKey[3] === 'string' && Array.isArray(query.data)) {
      const rows = query.data;
      query.data = { company_id: 'unit-a', rows, total: rows.length, total_people: 0, by_status: [], page: 1, page_size: 15 };
    }
    return query;
  },
}));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'unit-a', slug: 'unidade' }) }));
vi.mock('@/hooks/useCompanyPermissions', () => ({ useCompanyPermissions: () => ({ hasPermission: () => true }) }));
vi.mock('@/components/ReservationDetailsDialog', () => ({ default: () => null }));
vi.mock('@/components/PhoneWhatsAppLink', () => ({ default: () => null }));
vi.mock('@/components/ui/date-range-picker', () => ({ DateRangePicker: () => null }));

const clients: QueryClient[] = [];
function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  state.queries = { 'operator-public-schedule': { data: { slots: [], source: 'default' } } };
  state.refetch.mockClear();
});
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; });

describe('operational loading and error feedback', () => {
  it.each(['list', 'overview'] as const)('does not turn paused initial %s loading into zero results', (view) => {
    state.queries.reservations = { data: undefined, isPending: true, isFetching: false, isLoading: false, dataUpdatedAt: 0 };
    mount(<Reservations view={view} />);
    if (view === 'list') expect(screen.getByPlaceholderText(/Buscar por nome/)).toBeInTheDocument();
    else expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/Última atualização:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Nenhuma reserva encontrada.')).not.toBeInTheDocument();
  });

  it('keeps check-in totals unknown when the initial query is paused', () => {
    state.queries['today-reservations'] = { data: undefined, isPending: true, isFetching: false, isLoading: false, dataUpdatedAt: 0 };
    mount(<OperatorTodayReservations />);
    expect(screen.queryByText('Aguardando chegada')).not.toBeInTheDocument();
    expect(screen.queryByText(/Última atualização:/)).not.toBeInTheDocument();
  });

  it.each(['list', 'overview'] as const)('does not present failed %s reservations as an empty successful report', (view) => {
    state.queries.reservations = { data: undefined, isError: true, dataUpdatedAt: 0 };
    mount(<Reservations view={view} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as reservas.');
    expect(screen.queryByText('Nenhuma reserva encontrada.')).not.toBeInTheDocument();
    if (view === 'list') expect(screen.getByPlaceholderText(/Buscar por nome/)).toBeInTheDocument();
    else expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/Última atualização/)).not.toBeInTheDocument();
  });

  it('keeps reservation filters and cached rows available after a failed refresh', () => {
    state.queries.reservations = { data: [], isError: true };
    mount(<Reservations view="list" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
    expect(screen.getByPlaceholderText(/Buscar por nome/)).toBeInTheDocument();
  });

  it('shows a failed reservation refresh inside the already open day dialog', () => {
    const { rerender } = mount(<Reservations view="overview" />);
    fireEvent.click(screen.getByRole('button', { name: /Hoje/ }));
    state.queries.reservations = { data: [], isError: true };
    rerender(<QueryClientProvider client={clients[0]}><Reservations view="overview" /></QueryClientProvider>);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Não foi possível atualizar as reservas.');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('does not show zero check-in totals or empty lists when the initial request fails', async () => {
    state.queries['today-reservations'] = { data: undefined, isError: true, dataUpdatedAt: 0 };
    mount(<OperatorTodayReservations />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as reservas de hoje.');
    expect(screen.queryByText('Aguardando chegada')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })));
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it('preserves check-in lists and real empty results after a background failure', () => {
    state.queries['today-reservations'] = { data: [], isError: true };
    mount(<OperatorTodayReservations />);
    expect(screen.getByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
    expect(screen.getByText('Aguardando chegada')).toBeInTheDocument();
  });

  it('reports missing capacity without fabricating available places or hiding reservations', () => {
    state.queries['operator-public-schedule'] = { data: undefined, isError: true, dataUpdatedAt: 0 };
    mount(<OperatorTodayReservations />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar os horários.');
    expect(screen.getByText('Aguardando chegada')).toBeInTheDocument();
    expect(screen.queryByText(/Configuração pendente/)).not.toBeInTheDocument();
  });

  it('keeps the selected search and cached guest visible when a later refresh fails', () => {
    const data = [{ id: 'reservation-1', company_id: 'unit-a', table_id: null, guest_name: 'Cliente de exemplo', guest_phone: '5562999990000', date: '2026-11-21', time: '18:00:00', party_size: 3, status: 'confirmed', created_in_mode: 'capacity', reservation_payments: [] }];
    state.queries['today-reservations'] = { data };
    const { rerender } = mount(<OperatorTodayReservations />);
    fireEvent.change(screen.getByPlaceholderText('Buscar reserva por nome ou telefone...'), { target: { value: 'Cliente de exemplo' } });
    expect(screen.getByText('Cliente de exemplo')).toBeInTheDocument();
    state.queries['today-reservations'] = { data, isError: true };
    rerender(<QueryClientProvider client={clients[0]}><OperatorTodayReservations /></QueryClientProvider>);
    expect(screen.getByPlaceholderText('Buscar reserva por nome ou telefone...')).toHaveValue('Cliente de exemplo');
    expect(screen.getByText('Cliente de exemplo')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Mostrando os últimos dados disponíveis.');
  });
});
