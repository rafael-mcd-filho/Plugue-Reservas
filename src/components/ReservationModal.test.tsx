import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReservationModal from '@/components/ReservationModal';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: supabaseMocks.from,
    rpc: supabaseMocks.rpc,
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function queryResult(data: unknown) {
  const result = { data, error: null };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => unknown, reject: (reason?: unknown) => unknown) => (
      Promise.resolve(result).then(resolve, reject)
    ),
  };
  return builder;
}

function renderModal(initialDate: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ReservationModal
        open
        onOpenChange={vi.fn()}
        slug="restaurant"
        companyId="company-1"
        companyName="Restaurante Teste"
        openingHours={[]}
        initialDate={initialDate}
      />
    </QueryClientProvider>,
  );
}

describe('ReservationModal', () => {
  beforeEach(() => {
    supabaseMocks.from.mockReset();
    supabaseMocks.rpc.mockReset();

    supabaseMocks.from.mockImplementation((table: string) => {
      if (table === 'table_maps') {
        return queryResult([{
          id: 'map-1',
          name: 'Principal',
          is_default: true,
          is_enabled: true,
          active_from: null,
          active_to: null,
          priority: 0,
        }]);
      }
      if (table === 'restaurant_tables') {
        return queryResult([{
          id: 'table-1',
          number: 1,
          capacity: 4,
          section: 'Salao',
          table_map_id: 'map-1',
        }]);
      }
      return queryResult([]);
    });

    supabaseMocks.rpc.mockImplementation((name: string) => {
      if (name === 'get_public_reservation_schedule_range') {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === 'get_public_reservation_booking_context') {
        return Promise.resolve({
          data: [{
            schedule_source: 'default',
            schedule_rule_id: null,
            schedule_rule_name: null,
            schedule_block_id: null,
            schedule_block_name: null,
            schedule_slots: ['18:00'],
            schedule_max_party_size_per_reservation: 8,
            schedule_availability_mode: 'tables',
            schedule_default_duration_minutes: 60,
            time_slot: '18:00:00',
            total_tables: 1,
            occupied_tables: 0,
            available_tables: 1,
            available: true,
            unavailable_reason: null,
            reservation_count: 0,
            max_party_size_per_reservation: 8,
            max_reservations_per_slot: 1,
            availability_mode: 'tables',
            duration_minutes: 60,
            max_guests_per_slot: null,
            recommended_table_id: 'table-1',
            recommended_table_number: 1,
            recommended_table_capacity: 4,
            recommended_table_section: 'Salao',
            recommended_table_map_id: 'map-1',
          }],
          error: null,
        });
      }
      if (name === 'get_public_reservation_schedule') {
        return Promise.resolve({
          data: [{
            source: 'default',
            slots: ['18:00'],
            availability_mode: 'tables',
            max_party_size_per_reservation: 8,
            default_duration_minutes: 60,
          }],
          error: null,
        });
      }
      if (name === 'get_public_reservation_availability') {
        return Promise.resolve({
          data: [{
            time_slot: '18:00:00',
            total_tables: 1,
            occupied_tables: 0,
            available_tables: 1,
            available: true,
            unavailable_reason: null,
            reservation_count: 0,
            max_party_size_per_reservation: 8,
            max_reservations_per_slot: 1,
            availability_mode: 'tables',
            duration_minutes: 60,
            max_guests_per_slot: null,
          }],
          error: null,
        });
      }
      if (name === 'get_occupied_table_ids') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('reutiliza a disponibilidade e a mesa recomendada ao voltar para o mesmo horario', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));

    const tomorrowLabel = await screen.findByText(/Amanh/);
    fireEvent.click(tomorrowLabel.closest('button')!);

    const timeButton = await screen.findByRole('button', { name: /^18:00/ });
    fireEvent.click(timeButton);

    await screen.findByLabelText('WhatsApp');
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_occupied_table_ids')).toHaveLength(0);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'table_maps')).toHaveLength(0);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'restaurant_tables')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Voltar/ }));
    await screen.findByText(/Selecione um hor.rio para continuar/);
    fireEvent.click(screen.getByRole('button', { name: /^18:00/ }));

    await screen.findByLabelText('WhatsApp');
    await waitFor(() => {
      expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_occupied_table_ids')).toHaveLength(0);
      expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_booking_context')).toHaveLength(1);
    });
    expect(screen.queryByText(/Confirmando disponibilidade/)).not.toBeInTheDocument();
  });

  it('mantem o fluxo antigo como fallback durante o deploy da nova RPC', async () => {
    const defaultRpcImplementation = supabaseMocks.rpc.getMockImplementation()!;
    supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => {
      if (name === 'get_public_reservation_booking_context') {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find get_public_reservation_booking_context in the schema cache',
          },
        });
      }
      return defaultRpcImplementation(name, ...args);
    });

    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));

    const tomorrowLabel = await screen.findByText(/Amanh/);
    fireEvent.click(tomorrowLabel.closest('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

    await screen.findByLabelText('WhatsApp');
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_schedule')).toHaveLength(1);
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_availability')).toHaveLength(1);
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_occupied_table_ids')).toHaveLength(1);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'table_maps')).toHaveLength(1);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'restaurant_tables')).toHaveLength(1);
  });
});
