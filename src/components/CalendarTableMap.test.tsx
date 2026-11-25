import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CalendarTableMap, { type CalendarMapReservation, type CalendarTableMapProps } from '@/components/CalendarTableMap';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

const rows = [
  { table_id: 'table-10', table_number: 10, section_code: 'hall', section_name: 'Salão', capacity: 6, available: true, conflict_reservation_id: null, conflict_guest_name: null },
  { table_id: 'table-2', table_number: 2, section_code: 'hall', section_name: 'Salão', capacity: 4, available: true, conflict_reservation_id: null, conflict_guest_name: null },
  { table_id: 'table-3', table_number: 3, section_code: 'hall', section_name: 'Salão', capacity: 4, available: false, conflict_reservation_id: 'reservation-ana', conflict_guest_name: 'Ana Souza' },
  { table_id: 'table-4', table_number: 4, section_code: 'hall', section_name: 'Salão', capacity: 4, available: false, conflict_reservation_id: 'reservation-ana', conflict_guest_name: 'Ana Souza' },
  { table_id: 'table-5', table_number: 5, section_code: 'balcony', section_name: 'Varanda', capacity: 4, available: false, conflict_reservation_id: 'reservation-jose', conflict_guest_name: 'José Silva' },
];
const reservations: CalendarMapReservation[] = [
  { id: 'reservation-ana', guest_name: 'Ana Souza', status: 'checked_in', party_size: 7, checked_in_party_size: 6, timeRange: '18:00–20:00' },
  { id: 'reservation-jose', guest_name: 'José Silva', status: 'confirmed', party_size: 2, checked_in_party_size: null, timeRange: '19:00–20:00' },
];
const clients: QueryClient[] = [];

function mount(overrides: Partial<CalendarTableMapProps> = {}) {
  const onReserve = vi.fn();
  const onOpenReservation = vi.fn();
  const props: CalendarTableMapProps = {
    companyId: 'company-1',
    date: '2026-11-28',
    slot: { time: '18:30', availabilityMode: 'tables', capacityLimit: 20, remainingCapacity: 3, reservationLimit: null, arrivalReservationCount: 2 },
    mapName: 'Mapa do jantar',
    canCreateReservation: true,
    reservations,
    onReserve,
    onOpenReservation,
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><CalendarTableMap {...props} /></QueryClientProvider>);
  return { ...view, onReserve, onOpenReservation, props, client };
}

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: rows, error: null });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

describe('CalendarTableMap', () => {
  it('consulta a data e faixa selecionadas e reserva uma mesa respeitando as vagas restantes', async () => {
    const { onReserve } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Mesa 10, Livre na faixa' }));
    expect(screen.getByText('Mapa do jantar · 28/11/2026 às 18:30')).toBeVisible();
    expect(mocks.rpc).toHaveBeenCalledWith('get_reservation_table_options', {
      _company_id: 'company-1', _date: '2026-11-28', _time: '18:30:00', _party_size: 1, _duration_minutes: null, _reservation_id: null,
    });
    expect(onReserve).toHaveBeenCalledWith({
      date: '2026-11-28', time: '18:30', partySize: 3, remainingCapacity: 3,
      table: { id: 'table-10', number: 10, sectionName: 'Salão', capacity: 6 },
    });
    const tables = within(screen.getByRole('region', { name: 'Salão' })).getAllByRole('button');
    expect(tables.map(button => button.getAttribute('aria-label'))).toEqual([
      'Mesa 2, Livre na faixa', 'Mesa 3, Com check-in', 'Mesa 4, Com check-in', 'Mesa 10, Livre na faixa',
    ]);
  });

  it.each([
    { remainingCapacity: 0, reservationLimit: null, reason: 'Limite de pessoas atingido nesta faixa.' },
    { remainingCapacity: 3, reservationLimit: 2, reason: 'Limite de reservas atingido nesta faixa.' },
  ])('impede novas reservas ao atingir os limites da faixa sem bloquear detalhes ($reason)', async ({ remainingCapacity, reservationLimit, reason }) => {
    const { onReserve, onOpenReservation } = mount({
      slot: { time: '18:30', availabilityMode: 'tables', capacityLimit: 20, remainingCapacity, reservationLimit, arrivalReservationCount: 2 },
    });
    const free = await screen.findByRole('button', { name: 'Mesa 2, Livre na faixa' });
    expect(free).toBeDisabled();
    expect(screen.getByText(reason)).toBeVisible();
    fireEvent.click(free);
    fireEvent.click(screen.getByRole('button', { name: 'Mesa 3, Com check-in' }));
    expect(onReserve).not.toHaveBeenCalled();
    expect(onOpenReservation).toHaveBeenCalledWith('reservation-ana');
  });

  it('abre a mesma reserva a partir de cada mesa atribuída e usa o conflito da agenda', async () => {
    const { onReserve, onOpenReservation } = mount();
    const first = await screen.findByRole('button', { name: 'Mesa 3, Com check-in' });
    expect(first).toHaveTextContent('Ana Souza');
    expect(first).toHaveTextContent('6 pessoas');
    expect(first).toHaveTextContent('18:00–20:00');
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: 'Mesa 4, Com check-in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mesa 5, Reserva na faixa' }));
    expect(onOpenReservation.mock.calls).toEqual([['reservation-ana'], ['reservation-ana'], ['reservation-jose']]);
    expect(onReserve).not.toHaveBeenCalled();
  });

  it('filtra situação e busca por cliente ou mesa preservando os grupos por ambiente', async () => {
    mount();
    await screen.findByRole('button', { name: 'Mesa 3, Com check-in' });
    const filters = within(screen.getByRole('group', { name: 'Filtrar situação das mesas' }));
    fireEvent.click(filters.getByRole('button', { name: 'Livres' }));
    expect(screen.getByRole('button', { name: 'Mesa 2, Livre na faixa' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mesa 3, Com check-in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Varanda' })).not.toBeInTheDocument();
    fireEvent.click(filters.getByRole('button', { name: 'Reservadas' }));
    expect(screen.getByRole('button', { name: 'Mesa 5, Reserva na faixa' })).toBeVisible();
    fireEvent.click(filters.getByRole('button', { name: 'Com check-in' }));
    expect(screen.getByRole('button', { name: 'Mesa 3, Com check-in' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mesa 4, Com check-in' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mesa 5, Reserva na faixa' })).not.toBeInTheDocument();
    fireEvent.click(filters.getByRole('button', { name: 'Todas' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar cliente ou mesa no mapa' }), { target: { value: 'jose' } });
    expect(screen.getByRole('button', { name: 'Mesa 5, Reserva na faixa' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mesa 2, Livre na faixa' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Mesa 10' } });
    expect(screen.getByRole('button', { name: 'Mesa 10, Livre na faixa' })).toBeVisible();
    fireEvent.click(filters.getByRole('button', { name: 'Com check-in' }));
    expect(screen.getByText('Nenhuma mesa encontrada para estes filtros.')).toBeVisible();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('mantém o mapa consultável sem permissão de criar e não inventa detalhes de conflitos desconhecidos', async () => {
    mocks.rpc.mockResolvedValue({ data: [
      rows[0],
      { ...rows[2], conflict_reservation_id: 'reservation-outside', conflict_guest_name: 'Cliente de outra faixa' },
      { ...rows[4], conflict_reservation_id: null, conflict_guest_name: 'Nome sem vínculo válido' },
    ], error: null });
    const { onReserve, onOpenReservation } = mount({ canCreateReservation: false });
    expect(await screen.findByRole('button', { name: 'Mesa 10, Livre na faixa' })).toBeDisabled();
    const occupied = screen.getByRole('button', { name: 'Mesa 3, Reserva na faixa' });
    expect(occupied).toHaveTextContent('Cliente de outra faixa');
    expect(occupied).toBeDisabled();
    const unavailable = screen.getByRole('button', { name: 'Mesa 5, Indisponível' });
    expect(unavailable).toBeDisabled();
    expect(unavailable).not.toHaveTextContent('José Silva');
    expect(unavailable).not.toHaveTextContent('Nome sem vínculo válido');
    fireEvent.click(occupied);
    fireEvent.click(unavailable);
    expect(onReserve).not.toHaveBeenCalled();
    expect(onOpenReservation).not.toHaveBeenCalled();
  });

  it('mostra falha de consulta e permite tentar novamente sem anunciar mesas livres antes da resposta', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Offline' } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar o mapa desta faixa.');
    expect(screen.queryByText('Nenhuma mesa ativa no mapa desta faixa.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Mesa 2, Livre na faixa' })).toBeVisible();
  });

  it('não apresenta mesas da faixa anterior ao trocar data, empresa e horário', async () => {
    const { props, rerender, client } = mount();
    await screen.findByRole('button', { name: 'Mesa 2, Livre na faixa' });
    let resolveNext: (result: unknown) => void = () => {};
    mocks.rpc.mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
    const next = { ...props, companyId: 'company-2', date: '2026-12-01', slot: { ...props.slot, time: '20:00' } };
    rerender(<QueryClientProvider client={client}><CalendarTableMap {...next} /></QueryClientProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando mesas');
    expect(screen.queryByRole('button', { name: 'Mesa 2, Livre na faixa' })).not.toBeInTheDocument();
    resolveNext({ data: [], error: null });
    expect(await screen.findByText('Nenhuma mesa ativa no mapa desta faixa.')).toBeVisible();
    expect(mocks.rpc).toHaveBeenLastCalledWith('get_reservation_table_options', expect.objectContaining({ _company_id: 'company-2', _date: '2026-12-01', _time: '20:00:00', _duration_minutes: null }));
  });
});
