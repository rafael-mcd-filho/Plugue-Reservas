import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDays, eachDayOfInterval, format } from 'date-fns';
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

function renderModal(initialDate: string, props: Partial<ComponentProps<typeof ReservationModal>> = {}) {
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
        {...props}
      />
    </QueryClientProvider>,
  );
}

async function selectTomorrow() {
  const tomorrowLabel = await screen.findByText(/Amanh/);
  fireEvent.click(tomorrowLabel.closest('button')!);
}

async function confirmPartySize(partySize = 2) {
  fireEvent.click(await screen.findByRole('button', {
    name: `Ver horários para ${partySize} ${partySize === 1 ? 'pessoa' : 'pessoas'}`,
  }));
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

    supabaseMocks.rpc.mockImplementation((name: string, params: Record<string, string | number> = {}) => {
      if (name === 'get_public_reservation_schedule_range') {
        return Promise.resolve({
          data: eachDayOfInterval({
            start: new Date(`${params._start_date}T12:00:00`),
            end: new Date(`${params._end_date}T12:00:00`),
          }).map((date) => ({
            reservation_date: format(date, 'yyyy-MM-dd'),
            source: 'default',
            slots: ['18:00'],
            availability_mode: 'tables',
            max_party_size_per_reservation: 8,
            default_duration_minutes: 60,
          })),
          error: null,
        });
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

    await selectTomorrow();
    await confirmPartySize();

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

    await selectTomorrow();
    await confirmPartySize();
    fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

    await screen.findByLabelText('WhatsApp');
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_schedule')).toHaveLength(1);
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_public_reservation_availability')).toHaveLength(1);
    expect(supabaseMocks.rpc.mock.calls.filter(([name]) => name === 'get_occupied_table_ids')).toHaveLength(1);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'table_maps')).toHaveLength(1);
    expect(supabaseMocks.from.mock.calls.filter(([table]) => table === 'restaurant_tables')).toHaveLength(1);
  });

  it('pede confirmacao explicita da quantidade antes de mostrar os horarios', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));

    await selectTomorrow();

    expect(await screen.findByRole('heading', { name: 'Confirme a quantidade de pessoas' })).toBeInTheDocument();
    expect(screen.getByText('Inclua você, os demais adultos e as crianças.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await confirmPartySize();

    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirme a quantidade de pessoas' })).not.toBeInTheDocument();
  });

  it('consulta disponibilidade para a quantidade alterada e aguarda a resposta ao confirmar', async () => {
    const defaultRpcImplementation = supabaseMocks.rpc.getMockImplementation()!;
    let releaseAvailability: (result: unknown) => void = () => undefined;
    const pendingAvailability = new Promise((resolve) => {
      releaseAvailability = resolve;
    });
    supabaseMocks.rpc.mockImplementation((name: string, params: { _party_size?: number }) => {
      if (name === 'get_public_reservation_booking_context' && params._party_size === 3) {
        return pendingAvailability;
      }
      return defaultRpcImplementation(name, params);
    });

    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));
    await confirmPartySize(3);

    await waitFor(() => expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      'get_public_reservation_booking_context',
      expect.objectContaining({ _party_size: 3 }),
    ));
    expect(screen.getByRole('heading', { name: 'Confirme a quantidade de pessoas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();

    await act(async () => {
      releaseAvailability(await defaultRpcImplementation('get_public_reservation_booking_context', { _party_size: 3 }));
    });

    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
    expect(screen.getByText(/· 3 pessoas/)).toBeInTheDocument();
  });

  it('nao repete a confirmacao ao voltar ou escolher outra data com a mesma quantidade', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    await confirmPartySize();
    await screen.findByRole('button', { name: /^18:00/ });

    fireEvent.click(screen.getByRole('button', { name: /Voltar/ }));
    const nextDate = addDays(new Date(), 2);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`\\b${format(nextDate, 'dd')}\\b`) }));

    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirme a quantidade de pessoas' })).not.toBeInTheDocument();
    expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      'get_public_reservation_booking_context',
      expect.objectContaining({ _date: format(nextDate, 'yyyy-MM-dd'), _party_size: 2 }),
    );
  });

  it('nao avanca com a resposta de uma quantidade que foi alterada durante a consulta', async () => {
    const defaultRpcImplementation = supabaseMocks.rpc.getMockImplementation()!;
    let releaseAvailability: (result: unknown) => void = () => undefined;
    const pendingAvailability = new Promise((resolve) => {
      releaseAvailability = resolve;
    });
    supabaseMocks.rpc.mockImplementation((name: string, params: { _party_size?: number }) => {
      if (name === 'get_public_reservation_booking_context' && params._party_size === 3) {
        return pendingAvailability;
      }
      return defaultRpcImplementation(name, params);
    });

    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));
    await confirmPartySize(3);
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar número de pessoas' }));

    await act(async () => {
      releaseAvailability(await defaultRpcImplementation('get_public_reservation_booking_context', { _party_size: 3 }));
    });

    expect(screen.getByRole('heading', { name: 'Confirme a quantidade de pessoas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver horários para 4 pessoas' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();

    await confirmPartySize(4);
    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
    expect(screen.getByText(/· 4 pessoas/)).toBeInTheDocument();
  });

  it('permite alterar a data no painel sem avancar para os horarios', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();

    fireEvent.click(await screen.findByRole('button', { name: 'Alterar data' }));

    expect(await screen.findByText(/Selecione uma data para continuar/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirme a quantidade de pessoas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();

    await selectTomorrow();
    expect(await screen.findByRole('heading', { name: 'Confirme a quantidade de pessoas' })).toBeInTheDocument();
  });

  it('permite alterar pessoas nos horarios e confirma a nova quantidade antes de continuar', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    await confirmPartySize();
    await screen.findByRole('button', { name: /^18:00/ });

    fireEvent.click(screen.getByRole('button', { name: 'Alterar pessoas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));

    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();
    await confirmPartySize(3);

    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
    expect(screen.getByText(/· 3 pessoas/)).toBeInTheDocument();
  });

  it('mantem os dados preenchidos ao alterar pessoas e exige uma nova escolha de horario', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    await confirmPartySize();
    fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

    fireEvent.change(await screen.findByLabelText('Nome completo'), { target: { value: 'Maria Silva' } });
    fireEvent.change(screen.getByLabelText('E-mail (opcional)'), { target: { value: 'maria@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Alterar pessoas' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));
    await confirmPartySize(3);

    const timeButton = await screen.findByRole('button', { name: /^18:00/ });
    expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
    fireEvent.click(timeButton);

    expect(await screen.findByLabelText('Nome completo')).toHaveValue('Maria Silva');
    expect(screen.getByLabelText('E-mail (opcional)')).toHaveValue('maria@example.com');
    expect(screen.getByText('3 pessoas')).toBeInTheDocument();
    expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      'get_public_reservation_booking_context',
      expect.objectContaining({ _party_size: 3 }),
    );
  });

  it('encaminha grupos grandes ao WhatsApp e permite reduzir para seguir pelo site', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'), {
      largePartyThreshold: 3,
      companyWhatsapp: '11999999999',
    });
    await selectTomorrow();
    fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));

    expect(await screen.findByRole('link', { name: /Falar no WhatsApp/ })).toHaveAttribute(
      'href',
      expect.stringContaining('https://wa.me/5511999999999'),
    );
    expect(screen.queryByRole('button', { name: /Ver horários para/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^18:00/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Diminuir número de pessoas' }));
    await confirmPartySize();

    expect(await screen.findByRole('button', { name: /^18:00/ })).toBeInTheDocument();
  });

  it('respeita os limites do contador e usa pessoa no singular', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'), {
      initialPartySize: 1,
      largePartyThreshold: 20,
    });
    await selectTomorrow();

    expect(await screen.findByRole('button', { name: 'Diminuir número de pessoas' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ver horários para 1 pessoa' })).toBeInTheDocument();

    for (let count = 1; count < 20; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Aumentar número de pessoas' }));
    }

    expect(screen.getByRole('button', { name: 'Aumentar número de pessoas' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Diminuir número de pessoas' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Ver horários para/ })).not.toBeInTheDocument();
  });
});
