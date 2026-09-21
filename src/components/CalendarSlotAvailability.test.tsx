import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CalendarSlotAvailability, { type CalendarSlotAvailabilitySlot } from '@/components/CalendarSlotAvailability';

const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

const tableRows = [
  {
    table_id: 'table-3',
    table_number: 3,
    section_code: 'SALAO',
    section_name: 'Salão',
    capacity: 4,
    available: true,
    conflict_reservation_id: null,
    conflict_guest_name: null,
  },
  {
    table_id: 'table-7',
    table_number: 7,
    section_code: 'SALAO',
    section_name: 'Salão',
    capacity: 4,
    available: false,
    conflict_reservation_id: 'reservation-1',
    conflict_guest_name: 'Ana Souza',
  },
  {
    table_id: 'table-21',
    table_number: 21,
    section_code: 'VARANDA',
    section_name: 'Varanda',
    capacity: 6,
    available: true,
    conflict_reservation_id: null,
    conflict_guest_name: null,
  },
];

const tablesSlot: CalendarSlotAvailabilitySlot = {
  time: '18:00',
  availabilityMode: 'tables',
  capacityLimit: 186,
  remainingCapacity: 171,
  reservationLimit: null,
  arrivalReservationCount: 5,
};

function renderAvailability(
  slot: CalendarSlotAvailabilitySlot,
  overrides: Partial<Parameters<typeof CalendarSlotAvailability>[0]> = {},
) {
  const onReserve = vi.fn();
  const onOpenReservation = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <CalendarSlotAvailability
        companyId="company-1"
        date="2026-09-23"
        slot={slot}
        canCreateReservation
        showOccupied={false}
        onShowOccupiedChange={vi.fn()}
        minSeats={0}
        onMinSeatsChange={vi.fn()}
        reservationTimeRanges={{ 'reservation-1': '18:00–20:00' }}
        onReserve={onReserve}
        onOpenReservation={onOpenReservation}
        {...overrides}
      />
    </QueryClientProvider>,
  );

  return { onReserve, onOpenReservation };
}

describe('CalendarSlotAvailability', () => {
  beforeEach(() => {
    supabaseMocks.rpc.mockReset();
    supabaseMocks.rpc.mockResolvedValue({ data: tableRows, error: null });
  });

  it('lista as mesas livres por setor e abre a reserva com a mesa definida', async () => {
    const { onReserve } = renderAvailability(tablesSlot);

    const row = await screen.findByRole('button', { name: /Mesa 3/ });
    expect(screen.getByRole('button', { name: /Salão/ })).toHaveTextContent('1 livres de 2 · 4 vagas');
    expect(screen.getByRole('button', { name: /Varanda/ })).toBeInTheDocument();
    expect(screen.queryByText(/Mesa 7/)).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(supabaseMocks.rpc).toHaveBeenCalledWith('get_reservation_table_options', expect.objectContaining({
      _company_id: 'company-1',
      _date: '2026-09-23',
      _time: '18:00:00',
    }));
    expect(onReserve).toHaveBeenCalledWith({
      date: '2026-09-23',
      time: '18:00',
      partySize: 4,
      remainingCapacity: 171,
      table: { id: 'table-3', number: 3, sectionName: 'Salão', capacity: 4 },
    });
  });

  it('mostra a mesa ocupada com o cliente e abre os detalhes da reserva', async () => {
    const { onReserve, onOpenReservation } = renderAvailability(tablesSlot, { showOccupied: true });

    const occupiedRow = await screen.findByRole('button', { name: /Mesa 7/ });
    expect(occupiedRow).toHaveTextContent('0/4 vagas');
    expect(occupiedRow).toHaveTextContent('Ocupada · Ana Souza · 18:00–20:00');

    fireEvent.click(occupiedRow);

    expect(onOpenReservation).toHaveBeenCalledWith('reservation-1');
    expect(onReserve).not.toHaveBeenCalled();
  });

  it('desabilita as mesas quando o limite de pessoas da faixa foi atingido', async () => {
    const { onReserve } = renderAvailability({ ...tablesSlot, remainingCapacity: 0 });

    const row = await screen.findByRole('button', { name: /Mesa 3/ });
    expect(row).toBeDisabled();
    expect(screen.getByText('Limite de pessoas atingido nesta faixa.')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onReserve).not.toHaveBeenCalled();
  });

  it('no modo por capacidade oferece tamanhos de grupo até as vagas restantes', () => {
    const { onReserve } = renderAvailability({
      ...tablesSlot,
      availabilityMode: 'capacity',
      remainingCapacity: 5,
    });

    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(screen.getByText('5 de 186')).toBeInTheDocument();
    expect(screen.getByText('5 pessoas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '6 pessoas' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Outro… (até 5)' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '4 pessoas' }));

    expect(onReserve).toHaveBeenCalledWith({
      date: '2026-09-23',
      time: '18:00',
      partySize: 4,
      remainingCapacity: 5,
    });
  });

  it('mantém a disponibilidade visível sem oferecer ações de reserva em modo somente leitura', () => {
    const { onReserve } = renderAvailability({
      ...tablesSlot,
      availabilityMode: 'capacity',
      remainingCapacity: 5,
    }, { canCreateReservation: false });

    expect(screen.getByText('5 de 186')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 pessoas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Outro… (até 5)' })).not.toBeInTheDocument();
    expect(onReserve).not.toHaveBeenCalled();
  });
});
