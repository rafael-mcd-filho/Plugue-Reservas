import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CalendarView from '@/pages/CalendarView';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  availability: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useCompanySlug: () => ({ companyId: 'company-1', slug: 'beco-magico-goiania' }),
}));

vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({ hasPermission: () => true }),
}));

vi.mock('@/components/ManualReservationDialog', () => ({ default: () => null }));

vi.mock('@/components/PhoneWhatsAppLink', () => ({
  default: ({ phone }: { phone: string }) => <span>{phone}</span>,
}));

vi.mock('@/components/ReservationDetailsDialog', () => ({
  default: ({ open, reservation }: {
    open: boolean;
    reservation: { id: string; guest_name: string; time: string; duration_minutes: number } | null;
  }) => open && reservation ? (
    <div role="dialog" aria-label="Detalhes da reserva">
      {reservation.id} · {reservation.guest_name} · {reservation.time} · {reservation.duration_minutes} min
    </div>
  ) : null,
}));

vi.mock('@/components/CalendarSlotAvailability', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.availability(props);
    return <div>Disponibilidade das mesas</div>;
  },
}));

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reservation-heloisa',
    company_id: 'company-1',
    guest_name: 'Heloísa de Sousa Vieira',
    guest_phone: '+5562999659667',
    guest_email: null,
    date: '2026-10-30',
    time: '18:00:00',
    party_size: 5,
    duration_minutes: 60,
    status: 'checked_in',
    source: 'panel',
    checked_in_at: '2026-10-30T21:00:00Z',
    checked_in_party_size: 5,
    public_tracking_code: 'tracking-heloisa',
    table_id: 'table-22',
    table_number: 22,
    table_capacity: 6,
    table_section: 'salao-corvinal',
    created_in_mode: 'tables',
    occasion: 'Outro',
    notes: null,
    created_at: '2026-10-20T12:00:00Z',
    updated_at: '2026-10-30T21:00:00Z',
    reservation_payments: [],
    is_arrival: true,
    is_occupying: true,
    ...overrides,
  };
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    time_slot: '18:00:00',
    slot_label: '18:00 - 18:30',
    source: 'weekly',
    availability_mode: 'tables',
    active_table_map_id: 'map-1',
    active_table_map_name: 'Salão',
    duration_minutes: 30,
    capacity_limit: 218,
    occupying_guest_count: 5,
    arrival_guest_count: 5,
    checked_in_guest_count: 5,
    remaining_capacity: 213,
    arrival_reservation_count: 1,
    occupying_reservation_count: 1,
    total_tables: 52,
    occupied_tables: 1,
    available_tables: 51,
    unassigned_reservation_count: 0,
    reservation_limit: null,
    blocked: false,
    configuration_issue: null,
    status: 'available',
    reservations: [reservation()],
    ...overrides,
  };
}

function renderCalendar(rows: ReturnType<typeof slot>[]) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_admin_reservation_day_capacity_with_tables') return { data: rows, error: null };
    if (name === 'get_admin_reservation_calendar_metrics') {
      return { data: [{ reservation_date: '2026-10-30', reservation_count: 2, guest_count: 7 }], error: null };
    }
    if (name === 'get_public_reservation_schedule') {
      return {
        data: [{ source: 'weekly', slots: ['18:00', '18:30'], availability_mode: 'tables', default_duration_minutes: 60 }],
        error: null,
      };
    }
    throw new Error(`RPC inesperada: ${name}`);
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(<QueryClientProvider client={queryClient}><CalendarView /></QueryClientProvider>);
}

async function expandSlots() {
  fireEvent.click(await screen.findByRole('button', { name: 'Expandir todas' }));
}

function getSlot(timeRange: string) {
  const section = screen.getByText(timeRange).closest('section');
  if (!section) throw new Error(`Faixa não encontrada: ${timeRange}`);
  return within(section);
}

describe('CalendarView: chegadas e continuidade de reservas', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00-03:00'));
    mocks.rpc.mockReset();
    mocks.availability.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('mostra Heloísa como chegada uma vez e recolhe a continuidade sem alterar ocupação ou detalhes', async () => {
    renderCalendar([
      slot(),
      slot({
        time_slot: '18:30:00',
        duration_minutes: 150,
        occupying_guest_count: 7,
        arrival_guest_count: 2,
        checked_in_guest_count: 7,
        remaining_capacity: 211,
        occupying_reservation_count: 2,
        occupied_tables: 2,
        available_tables: 50,
        reservations: [
          reservation({
            id: 'reservation-lucas',
            guest_name: 'Lucas',
            guest_phone: '+5562999998888',
            time: '18:30:00',
            party_size: 2,
            checked_in_party_size: 2,
            table_id: 'table-32',
            table_number: 32,
          }),
          reservation({ is_arrival: false }),
        ],
      }),
    ]);
    await expandSlots();

    const first = getSlot('18:00 - 18:30');
    const second = getSlot('18:30 - 21:00');
    expect(first.getByText('Heloísa de Sousa Vieira')).toBeVisible();
    expect(first.getByText('18:00–19:00')).toBeVisible();
    expect(first.queryByRole('button', { name: /reserva iniciada antes/ })).not.toBeInTheDocument();
    expect(second.getByRole('tab', { name: 'Reservas (1)' })).toBeVisible();
    expect(second.getByText('Lucas')).toBeVisible();
    expect(second.queryByText('Heloísa de Sousa Vieira')).not.toBeInTheDocument();
    expect(second.getByText('Vagas 211')).toBeVisible();
    expect(second.getByText('Mesas 50/52')).toBeVisible();
    expect(second.getByText('2 reservas / 7 pessoas')).toBeVisible();
    expect(screen.getByText('Reservas ativas').parentElement).toHaveTextContent('Reservas ativas2');
    expect(screen.getByText('Pessoas').parentElement).toHaveTextContent('Pessoas7');

    const continuity = second.getByRole('button', { name: /1 reserva iniciada antes ocupa parte desta faixa/ });
    expect(continuity).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(continuity);

    expect(continuity).toHaveAttribute('aria-expanded', 'true');
    const continuationName = second.getByText('Heloísa de Sousa Vieira');
    expect(continuationName).toBeVisible();
    expect(second.getByText('até 19:00')).toBeVisible();
    expect(second.getByText(/Mesa 22/)).toBeVisible();
    expect(second.queryByText('+5562999659667')).not.toBeInTheDocument();
    fireEvent.click(second.getByRole('button', { name: 'Ver detalhes da reserva de Heloísa de Sousa Vieira' }));
    expect(screen.getByRole('dialog', { name: 'Detalhes da reserva' })).toHaveTextContent(
      'reservation-heloisa · Heloísa de Sousa Vieira · 18:00:00 · 60 min',
    );

    fireEvent.click(second.getByRole('tab', { name: /Disponibilidade/ }));
    expect(mocks.availability).toHaveBeenLastCalledWith(expect.objectContaining({
      slot: expect.objectContaining({
        occupiedGuests: 7,
        remainingCapacity: 211,
        arrivalReservationCount: 1,
        occupyingReservationCount: 2,
        availableTableCount: 50,
      }),
      reservationTimeRanges: expect.objectContaining({ 'reservation-heloisa': '18:00–19:00' }),
    }));
    expect(mocks.rpc.mock.calls.every(([name]) => name.startsWith('get_'))).toBe(true);
  });

  it('mantém visível a faixa com apenas continuidade e conta zero novas reservas', async () => {
    renderCalendar([
      slot(),
      slot({
        time_slot: '18:30:00',
        duration_minutes: 150,
        arrival_guest_count: 0,
        arrival_reservation_count: 0,
        reservations: [reservation({ is_arrival: false })],
      }),
    ]);
    await expandSlots();

    const second = getSlot('18:30 - 21:00');
    expect(second.getByRole('tab', { name: 'Reservas (0)' })).toBeVisible();
    expect(second.getByText('0 reservas / 0 pessoas')).toBeVisible();
    expect(second.getByText('1 reserva / 5 pessoas')).toBeVisible();
    expect(second.getByText('Vagas 213')).toBeVisible();
    expect(second.queryByText('Heloísa de Sousa Vieira')).not.toBeInTheDocument();

    fireEvent.click(second.getByRole('button', { name: /1 reserva iniciada antes ocupa parte desta faixa/ }));
    expect(second.getByText('Heloísa de Sousa Vieira')).toBeVisible();
    expect(second.getByText('até 19:00')).toBeVisible();
  });

  it('resume no plural as continuidades no modo por capacidade', async () => {
    const previousReservations = [
      reservation({ is_arrival: false, created_in_mode: 'capacity', table_id: null }),
      reservation({ id: 'reservation-lorrayne', guest_name: 'Lorrayne Kamilly', is_arrival: false, created_in_mode: 'capacity', table_id: null }),
      reservation({ id: 'reservation-odilia', guest_name: 'Odília Santos', is_arrival: false, created_in_mode: 'capacity', table_id: null }),
    ];
    renderCalendar([slot({
      time_slot: '18:30:00',
      duration_minutes: 150,
      availability_mode: 'capacity',
      occupying_guest_count: 15,
      arrival_guest_count: 0,
      checked_in_guest_count: 15,
      remaining_capacity: 203,
      arrival_reservation_count: 0,
      occupying_reservation_count: 3,
      reservations: previousReservations,
    })]);
    await expandSlots();

    const second = getSlot('18:30 - 21:00');
    const continuity = second.getByRole('button', { name: /3 reservas iniciadas antes ocupam parte desta faixa/ });
    expect(continuity).toHaveAttribute('aria-expanded', 'false');
    expect(second.queryByText('Heloísa de Sousa Vieira')).not.toBeInTheDocument();
    expect(second.getByText('Vagas 203')).toBeVisible();
    fireEvent.click(continuity);
    for (const name of ['Heloísa de Sousa Vieira', 'Lorrayne Kamilly', 'Odília Santos']) {
      expect(second.getByText(name)).toBeVisible();
    }
    expect(second.getAllByText('até 19:00')).toHaveLength(3);
    expect(second.queryByText(/Mesa 22/)).not.toBeInTheDocument();
    fireEvent.click(continuity);
    expect(second.queryByText('Heloísa de Sousa Vieira')).not.toBeInTheDocument();
  });
});
