import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CalendarView from '@/pages/CalendarView';
import type { ManualReservationPreset } from '@/components/ManualReservationDialog';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), map: vi.fn(), availability: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({ companyId: 'company-1', slug: 'restaurante' }),
}));
vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({ hasPermission: () => true }),
}));
vi.mock('@/components/PhoneWhatsAppLink', () => ({ default: () => null }));
vi.mock('@/components/ManualReservationDialog', () => ({
  default: ({ open, preset }: { open: boolean; preset: ManualReservationPreset | null }) => open ? (
    <div role="dialog" aria-label="Nova reserva">{JSON.stringify(preset)}</div>
  ) : null,
}));
vi.mock('@/components/ReservationDetailsDialog', () => ({
  default: ({ open, reservation }: { open: boolean; reservation: { id: string; guest_name: string } | null }) => open && reservation ? (
    <div role="dialog" aria-label="Detalhes da reserva">{reservation.id} · {reservation.guest_name}</div>
  ) : null,
}));
vi.mock('@/components/CalendarSlotAvailability', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.availability(props);
    return <div>Disponibilidade por capacidade</div>;
  },
}));
vi.mock('@/components/CalendarTableMap', () => ({
  default: (props: {
    date: string;
    slot: { time: string; remainingCapacity: number | null };
    onReserve: (preset: ManualReservationPreset) => void;
    onOpenReservation: (id: string) => void;
  }) => {
    mocks.map(props);
    return (
      <div aria-label="Mapa das mesas">
        <p>Mapa de {props.date} às {props.slot.time}</p>
        <button onClick={() => props.onOpenReservation('reservation-ana')}>Abrir mesa reservada</button>
        <button onClick={() => props.onReserve({
          date: props.date,
          time: props.slot.time,
          partySize: 4,
          remainingCapacity: props.slot.remainingCapacity,
          table: { id: 'table-2', number: 2, sectionName: 'Salão', capacity: 4 },
        })}>Reservar mesa livre</button>
      </div>
    );
  },
}));

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reservation-ana', company_id: 'company-1', guest_name: 'Ana Ribeiro',
    guest_phone: '+5562999998888', guest_email: null, date: '2026-10-30', time: '18:00:00',
    party_size: 4, duration_minutes: 60, status: 'confirmed', source: 'panel',
    checked_in_at: null, checked_in_party_size: null, public_tracking_code: 'tracking-ana',
    table_id: 'table-1', table_number: 1, table_capacity: 4, table_section: 'salao',
    created_in_mode: 'tables', occasion: null, notes: null,
    created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
    reservation_payments: [], is_arrival: true, is_occupying: true, ...overrides,
  };
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    time_slot: '18:00:00', source: 'weekly', availability_mode: 'tables',
    active_table_map_id: 'map-1', active_table_map_name: 'Salão principal', duration_minutes: 30,
    capacity_limit: 20, occupying_guest_count: 4, arrival_guest_count: 4, checked_in_guest_count: 0,
    remaining_capacity: 16, arrival_reservation_count: 1, occupying_reservation_count: 1,
    total_tables: 5, occupied_tables: 1, available_tables: 4, unassigned_reservation_count: 0,
    reservation_limit: null, blocked: false, configuration_issue: null, status: 'available',
    reservations: [reservation()], ...overrides,
  };
}

function emptySlot(time: string) {
  return slot({
    time_slot: `${time}:00`, occupying_guest_count: 0, arrival_guest_count: 0,
    remaining_capacity: 20, arrival_reservation_count: 0, occupying_reservation_count: 0,
    occupied_tables: 0, available_tables: 5, reservations: [],
  });
}

type CapacityResponse = { data: ReturnType<typeof slot>[]; error: null };

function mountCalendar(
  rows: ReturnType<typeof slot>[],
  nextDayCapacity?: () => Promise<CapacityResponse>,
) {
  mocks.rpc.mockImplementation(async (name: string, args: { _date?: string }) => {
    if (name === 'get_admin_reservation_day_capacity_with_tables') {
      if (args._date === '2026-10-31' && nextDayCapacity) return nextDayCapacity();
      return { data: rows, error: null };
    }
    if (name === 'get_admin_reservation_calendar_metrics') return { data: [], error: null };
    if (name === 'get_public_reservation_schedule') return {
      data: [{ source: 'weekly', slots: rows.map((row) => String(row.time_slot).slice(0, 5)), availability_mode: rows[0]?.availability_mode ?? 'tables', default_duration_minutes: 30 }],
      error: null,
    };
    throw new Error(`RPC inesperada: ${name}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={queryClient}><CalendarView /></QueryClientProvider>);
}

async function showMap() {
  fireEvent.click(await screen.findByRole('button', { name: 'Mapa' }));
  return screen.findByLabelText('Mapa das mesas');
}

async function selectMapTime(time: string) {
  const control = screen.getByRole('combobox', { name: 'Horário do mapa' });
  if (control.tagName === 'SELECT') {
    fireEvent.change(control, { target: { value: time } });
    return;
  }
  fireEvent.keyDown(control, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${time}`) }));
}

describe('CalendarView: mapa da data selecionada', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 30, 12, 0));
    mocks.rpc.mockReset(); mocks.map.mockReset(); mocks.availability.mockReset();
    Element.prototype.scrollIntoView ??= vi.fn();
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('alterna para o mapa no horário atual e preserva as faixas expandidas ao retornar', async () => {
    vi.setSystemTime(new Date(2026, 9, 30, 18, 40));
    mountCalendar([slot(), slot({ time_slot: '18:30:00', arrival_reservation_count: 0, arrival_guest_count: 0, reservations: [reservation({ is_arrival: false })] })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Expandir todas' }));
    expect(screen.getByText('Ana Ribeiro')).toBeVisible();
    await showMap();
    expect(screen.getByRole('button', { name: 'Mapa' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Mapa de 2026-10-30 às 18:30')).toBeVisible();
    expect(mocks.map).toHaveBeenLastCalledWith(expect.objectContaining({
      companyId: 'company-1', date: '2026-10-30', mapName: 'Salão principal',
      reservations: [expect.objectContaining({ id: 'reservation-ana', guest_name: 'Ana Ribeiro', timeRange: '18:00–19:00' })],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Horários' }));
    expect(screen.getByRole('button', { name: 'Horários' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Ana Ribeiro')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Recolher todas' })).toBeVisible();
  });

  it('inclui horários vazios no mapa mesmo com Ocultar vazias e prefere a primeira chegada', async () => {
    mountCalendar([emptySlot('17:00'), slot(), emptySlot('18:30')]);
    await screen.findByText('18:00 - 18:30');
    expect(screen.queryByText('17:00 - 17:30')).not.toBeInTheDocument();
    await showMap();
    expect(screen.getByText('Mapa de 2026-10-30 às 18:00')).toBeVisible();
    await selectMapTime('17:00');
    expect(await screen.findByText('Mapa de 2026-10-30 às 17:00')).toBeVisible();
    await selectMapTime('18:30');
    expect(await screen.findByText('Mapa de 2026-10-30 às 18:30')).toBeVisible();
  });

  it('seleciona o primeiro horário quando o dia só tem faixas vazias', async () => {
    mountCalendar([emptySlot('17:00'), emptySlot('18:00')]);
    await showMap();
    expect(screen.getByText('Mapa de 2026-10-30 às 17:00')).toBeVisible();
  });

  it('consulta a nova data sem mostrar seu mapa com reservas ou horários do dia anterior', async () => {
    let resolveNextDay!: (value: CapacityResponse) => void;
    const nextDay = new Promise<CapacityResponse>((resolve) => { resolveNextDay = resolve; });
    mountCalendar([slot()], () => nextDay);
    await showMap();
    fireEvent.click(screen.getByRole('button', { name: '31 de outubro: 0 pessoas' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_admin_reservation_day_capacity_with_tables', { _company_id: 'company-1', _date: '2026-10-31' }));
    expect(screen.queryByLabelText('Mapa das mesas')).not.toBeInTheDocument();
    expect(mocks.map.mock.calls.some(([props]) => props.date === '2026-10-31')).toBe(false);
    await act(async () => resolveNextDay({ data: [emptySlot('20:00'), slot({ time_slot: '21:00:00', reservations: [reservation({ date: '2026-10-31', time: '21:00:00', guest_name: 'Bruno Costa' })] })], error: null }));
    expect(await screen.findByText('Mapa de 2026-10-31 às 21:00')).toBeVisible();
    expect(mocks.map.mock.calls.some(([props]) => props.date === '2026-10-31' && props.slot.time === '18:00')).toBe(false);
    expect(mocks.map).toHaveBeenLastCalledWith(expect.objectContaining({
      reservations: [expect.objectContaining({ guest_name: 'Bruno Costa', date: '2026-10-31', timeRange: '21:00–22:00' })],
    }));
  });

  it('mantém a disponibilidade por capacidade para dias sem reserva por mesas', async () => {
    mountCalendar([slot({ availability_mode: 'capacity', reservations: [reservation({ table_id: null, created_in_mode: 'capacity' })] })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Mapa' }));
    expect(await screen.findByText('Disponibilidade por capacidade')).toBeVisible();
    expect(screen.getByText('Esta data usa reservas por capacidade. A disponibilidade é apresentada em pessoas.')).toBeVisible();
    expect(screen.queryByLabelText('Mapa das mesas')).not.toBeInTheDocument();
    expect(mocks.map).not.toHaveBeenCalled();
    expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-10-30', slot: expect.objectContaining({ availabilityMode: 'capacity', time: '18:00' }) }));
  });

  it('abre os detalhes e leva a data, horário e mesa livres para o formulário de reserva', async () => {
    mountCalendar([slot()]);
    await showMap();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir mesa reservada' }));
    expect(screen.getByRole('dialog', { name: 'Detalhes da reserva' })).toHaveTextContent('reservation-ana · Ana Ribeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Reservar mesa livre' }));
    const preset = JSON.parse(screen.getByRole('dialog', { name: 'Nova reserva' }).textContent ?? '{}');
    expect(preset).toEqual({ date: '2026-10-30', time: '18:00', partySize: 4, remainingCapacity: 16, table: { id: 'table-2', number: 2, sectionName: 'Salão', capacity: 4 } });
  });
});
