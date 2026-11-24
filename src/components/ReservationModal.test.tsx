import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addDays, eachDayOfInterval, format } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReservationModal from '@/components/ReservationModal';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: supabaseMocks.from,
    rpc: supabaseMocks.rpc,
    functions: { invoke: supabaseMocks.invoke },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/affiliateLinks', () => ({ getAffiliateAttribution: () => null }));

function queryResult(data: unknown) {
  const result = { data, error: null };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    order: vi.fn(() => builder),
    abortSignal: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => unknown, reject: (reason?: unknown) => unknown) => (
      Promise.resolve(result).then(resolve, reject)
    ),
  };
  return builder;
}

function paymentRequirement(date: string, requiresPayment = false, companyId = 'company-1') {
  return {
    schema: 'reservation-payment-requirement', version: 1, company_id: companyId, date,
    requires_payment: requiresPayment,
    ...(!requiresPayment ? { reason: 'no_rule' } : {}),
  };
}

function renderModal(initialDate: string | null, props: Partial<ComponentProps<typeof ReservationModal>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  const renderContent = (next: Partial<ComponentProps<typeof ReservationModal>> = {}) => (
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
        {...next}
      />
    </QueryClientProvider>
  );
  const view = render(renderContent());
  return { ...view, queryClient, rerenderModal: (next: Partial<ComponentProps<typeof ReservationModal>>) => view.rerender(renderContent(next)) };
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

function paymentPreviewCalls() {
  return supabaseMocks.invoke.mock.calls.filter(([name, options]) => name === 'create-reservation-payment' && options.body?.action === 'preview');
}

function reservationCreationCalls() {
  return supabaseMocks.invoke.mock.calls.filter(([name, options]) => name === 'create-reservation-payment' && options.body?.action !== 'preview');
}

function mockKnownCustomerPrefill() {
  const defaultRpcImplementation = supabaseMocks.rpc.getMockImplementation()!;
  supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_prefill'
    ? Promise.resolve({ data: [{ guest_name: 'Maria Silva', guest_email: 'maria@example.test', guest_birthdate: '1990-08-14' }], error: null })
    : defaultRpcImplementation(name, ...args));
}

async function fillKnownCustomer() {
  fireEvent.change(await screen.findByLabelText('WhatsApp'), { target: { value: '+55 11 99999-8888' } });
  await screen.findByText('Cadastro encontrado');
  await waitFor(() => expect(screen.getByLabelText('Nome completo')).toHaveValue('Maria Silva'));
}

async function goToReservationForm() {
  await selectTomorrow();
  await confirmPartySize();
  fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
  await screen.findByLabelText('WhatsApp');
}

describe('ReservationModal', () => {
  beforeEach(() => {
    supabaseMocks.from.mockReset();
    supabaseMocks.rpc.mockReset();
    supabaseMocks.invoke.mockReset();
    supabaseMocks.invoke.mockImplementation(async (name: string, options: { body?: Record<string, unknown> } = {}) => {
      const body = options.body ?? {};
      if (name === 'create-reservation-payment' && body.action === 'preview') {
        return { data: paymentRequirement(String(body.date), false, String(body.company_id)), error: null };
      }
      if (name === 'create-reservation-payment') {
        const reservation = body.reservation as { id?: string } | undefined;
        return { data: { requires_payment: false, reason: 'no_rule', reservation_created: true, reservation_id: reservation?.id }, error: null };
      }
      return { data: null, error: null };
    });

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
      if (name === 'get_public_reservation_section_options') {
        return queryResult({ enabled: false, options: [] });
      }
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

  describe('escolha de ambiente', () => {
    const options = [
      { id: 'section-salao', section_id: 'section-salao', payment_rule_section_id: 'option-normal', section_name: 'Salão', public_name: 'Reserva normal', description: 'Ambiente interno', amount_type: 'per_person', base_amount: 50, pix_amount: 50, credit_card_amount: 55, available: true },
      { id: 'section-sacada', section_id: 'section-sacada', payment_rule_section_id: 'option-premium', section_name: 'Sacada', public_name: 'Sacada Premium', description: 'Vista para o jardim', amount_type: 'per_person', base_amount: 100, pix_amount: 100, credit_card_amount: 110, available: true },
    ];

    function mockOptions(value: unknown = options) {
      const defaultRpc = supabaseMocks.rpc.getMockImplementation()!;
      supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_section_options'
        ? queryResult({ enabled: true, rule_id: 'rule-sections', options: value })
        : defaultRpc(name, ...args));
    }

    async function goToEnvironments() {
      await selectTomorrow();
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      await screen.findByRole('radiogroup', { name: 'Escolha seu ambiente' });
    }

    it('exige escolha explícita, mostra total do grupo e envia somente o identificador comercial', async () => {
      mockOptions();
      mockKnownCustomerPrefill();
      renderModal(null);
      await goToEnvironments();

      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continuar com este ambiente' })).toBeDisabled();
      expect(screen.getByText(/200,00 no Pix/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: /Sacada Premium/ }));
      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Continuar com este ambiente' }));
      await fillKnownCustomer();
      expect(screen.getByText('Sacada Premium')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar Reserva' }));

      await waitFor(() => expect(reservationCreationCalls()).toHaveLength(1));
      const reservation = reservationCreationCalls()[0][1].body.reservation;
      expect(reservation).toEqual(expect.objectContaining({ section_option_id: 'option-premium', selected_section_id: 'section-sacada', table_id: null, table_map_id: null }));
      expect(reservation).not.toHaveProperty('base_amount');
      expect(reservation).not.toHaveProperty('selected_section_name');
    });

    it('exibe o preço uma única vez quando Pix e cartão têm o mesmo valor', async () => {
      mockOptions(options.map((option) => ({ ...option, credit_card_amount: option.pix_amount })));
      renderModal(null);
      await goToEnvironments();
      const choices = screen.getByRole('radiogroup', { name: 'Escolha seu ambiente' });
      expect(within(choices).getByText(/R\$\s*200,00 no Pix ou cartão/)).toBeInTheDocument();
      expect(within(choices).getByText(/R\$\s*100,00 no Pix ou cartão/)).toBeInTheDocument();
      expect(within(choices).queryByText(/no Pix ·/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: /Sacada Premium/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Continuar com este ambiente' }));
      await screen.findByLabelText('WhatsApp');
      expect(screen.getByText(/R\$\s*200,00 no Pix ou cartão/)).toBeInTheDocument();
    });

    it('bloqueia ambiente esgotado e permite escolher outro', async () => {
      mockOptions(options.map((option) => ({ ...option, available: option.id !== 'section-sacada' })));
      renderModal(null);
      await goToEnvironments();
      expect(screen.getByRole('radio', { name: /Sacada Premium/ })).toBeDisabled();
      expect(screen.getByText('Esgotado para este horário e grupo')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('radio', { name: /Reserva normal/ }));
      expect(screen.getByRole('button', { name: 'Continuar com este ambiente' })).toBeEnabled();
    });

    it('permite escolher o ambiente e reservar quando não há pagamento ativo', async () => {
      mockOptions(options.map((option) => ({ ...option, payment_rule_section_id: null, amount_type: null, base_amount: null, pix_amount: null, credit_card_amount: null })));
      mockKnownCustomerPrefill();
      renderModal(null);
      await goToEnvironments();
      expect(screen.getAllByText('Sem pagamento antecipado')).toHaveLength(2);
      fireEvent.click(screen.getByRole('radio', { name: /Sacada Premium/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Continuar com este ambiente' }));
      await fillKnownCustomer();
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar Reserva' }));
      await waitFor(() => expect(reservationCreationCalls()).toHaveLength(1));
      expect(reservationCreationCalls()[0][1].body.reservation).toEqual(expect.objectContaining({ selected_section_id: 'section-sacada', table_id: null }));
      expect(reservationCreationCalls()[0][1].body.reservation).not.toHaveProperty('section_option_id');
      const calendar = await screen.findByRole('link', { name: 'Adicionar ao Google Calendar' });
      expect(decodeURIComponent(calendar.getAttribute('href')!)).toContain('Sacada Premium');
      expect(decodeURIComponent(calendar.getAttribute('href')!)).not.toContain('Mesa 1');
    });

    it('segue direto aos dados quando o pagamento tem valor único', async () => {
      const defaultRpc = supabaseMocks.rpc.getMockImplementation()!;
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_section_options'
        ? queryResult({ enabled: false, rule_id: 'rule-single', options: [] }) : defaultRpc(name, ...args));
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview'
        ? Promise.resolve({ data: paymentRequirement(String(options.body.date), true), error: null }) : defaultInvoke(name, options));
      renderModal(null);
      await goToReservationForm();
      expect(screen.queryByRole('radiogroup', { name: 'Escolha seu ambiente' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Continuar com este ambiente' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();
    });

    it('bloqueia valor único quando os ambientes permitidos estão cheios, apesar de vagas gerais', async () => {
      const defaultRpc = supabaseMocks.rpc.getMockImplementation()!;
      supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_section_options'
        ? queryResult({ enabled: false, rule_id: 'rule-single', automatic_allocation_available: false, options: [] }) : defaultRpc(name, ...args));
      renderModal(null);
      await selectTomorrow();
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      await screen.findByText('Não há vagas nos ambientes disponíveis para este horário e grupo. Escolha outro horário.');
      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      expect(reservationCreationCalls()).toHaveLength(0);
    });

    it('impede avançar quando a agenda ficou incompatível com o preço por ambiente', async () => {
      const defaultRpc = supabaseMocks.rpc.getMockImplementation()!;
      supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_section_options'
        ? queryResult({ enabled: false, rule_id: 'rule-sections', configuration_error: 'A regra exige escolha de ambiente.', options: [] })
        : defaultRpc(name, ...args));
      renderModal(null);
      await selectTomorrow();
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      await screen.findByText('Este horário está temporariamente indisponível. Escolha outro horário ou fale com o estabelecimento.');
      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      expect(reservationCreationCalls()).toHaveLength(0);
    });

    it('descarta a escolha quando muda a quantidade de pessoas', async () => {
      mockOptions();
      renderModal(null);
      await goToEnvironments();
      fireEvent.click(screen.getByRole('radio', { name: /Sacada Premium/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Continuar com este ambiente' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Alterar pessoas' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));
      await confirmPartySize(3);
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      await screen.findByRole('radiogroup', { name: 'Escolha seu ambiente' });
      expect(screen.getByRole('radio', { name: /Sacada Premium/ })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Continuar com este ambiente' })).toBeDisabled();
      expect(screen.getByText(/300,00 no Pix/)).toBeInTheDocument();
    });

    it('mantém o cliente no horário e permite tentar novamente se a consulta de ambientes falhar', async () => {
      const defaultRpc = supabaseMocks.rpc.getMockImplementation()!;
      let failing = true;
      supabaseMocks.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_public_reservation_section_options'
        ? { ...queryResult(null), abortSignal: () => failing ? Promise.resolve({ data: null, error: { message: 'Offline' } }) : queryResult({ enabled: true, rule_id: 'rule-sections', options }) }
        : defaultRpc(name, ...args));
      renderModal(null);
      await selectTomorrow();
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      await screen.findByText('Não foi possível consultar os ambientes para este horário.');
      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
      await screen.findByRole('radiogroup', { name: 'Escolha seu ambiente' });
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

  it.each([
    { mode: 'tables', legacy: false },
    { mode: 'capacity', legacy: false },
    { mode: 'tables', legacy: true },
    { mode: 'capacity', legacy: true },
  ])('mantem o horario marcado como lotado visivel e bloqueado em $mode (fallback: $legacy)', async ({ mode, legacy }) => {
    const defaultRpcImplementation = supabaseMocks.rpc.getMockImplementation()!;
    supabaseMocks.rpc.mockImplementation(async (name: string, ...args: unknown[]) => {
      if (legacy && name === 'get_public_reservation_booking_context') {
        return {
          data: null,
          error: { code: 'PGRST202', message: 'Could not find get_public_reservation_booking_context' },
        };
      }

      const result = await defaultRpcImplementation(name, ...args);
      if (name === 'get_public_reservation_schedule') {
        return {
          ...result,
          data: [{ ...result.data[0], slots: ['18:00', '19:00'], availability_mode: mode }],
        };
      }
      if (name !== 'get_public_reservation_booking_context' && name !== 'get_public_reservation_availability') {
        return result;
      }

      const openSlot = {
        ...result.data[0],
        schedule_slots: ['18:00', '19:00'],
        schedule_availability_mode: mode,
        availability_mode: mode,
        total_tables: 10,
        occupied_tables: 0,
        available_tables: 10,
        max_reservations_per_slot: null,
        max_guests_per_slot: mode === 'capacity' ? 10 : null,
      };
      return {
        ...result,
        data: [
          {
            ...openSlot,
            time_slot: '18:00:00',
            available: false,
            unavailable_reason: 'manually_full',
            available_tables: 0,
            recommended_table_id: null,
          },
          { ...openSlot, time_slot: '19:00:00' },
        ],
      };
    });

    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    await confirmPartySize();

    const fullSlot = await screen.findByRole('button', { name: /^18:00.*Lotado/ });
    expect(fullSlot).toBeDisabled();
    fireEvent.click(fullSlot);
    expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();

    const openSlot = screen.getByRole('button', { name: /^19:00/ });
    expect(openSlot).toBeEnabled();
    fireEvent.click(openSlot);
    expect(await screen.findByLabelText('WhatsApp')).toBeInTheDocument();
  });

  it('busca o cadastro com o telefone internacional completo e o escopo da unidade', async () => {
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'));
    await selectTomorrow();
    await confirmPartySize();
    fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

    fireEvent.change(await screen.findByLabelText('WhatsApp'), { target: { value: '+1 407 264 1934' } });

    await waitFor(() => expect(supabaseMocks.rpc).toHaveBeenCalledWith(
      'get_public_reservation_prefill',
      expect.objectContaining({ _company_id: 'company-1', _guest_phone: '+14072641934' }),
    ));
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

  it.each(['Voltar', 'Escape'])('consulta os termos e retorna por %s sem perder a reserva ou enviar o formulário', async (closeMethod) => {
    const onOpenChange = vi.fn();
    renderModal(format(addDays(new Date(), 1), 'yyyy-MM-dd'), { onOpenChange, exitRecoveryEnabled: true });
    await selectTomorrow();
    await confirmPartySize();
    fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

    fireEvent.change(await screen.findByLabelText('Nome completo'), { target: { value: 'Maria Silva' } });
    fireEvent.change(screen.getByLabelText('E-mail (opcional)'), { target: { value: 'maria@example.com' } });
    fireEvent.change(screen.getByLabelText('WhatsApp'), { target: { value: '+1 407 264 1934' } });
    const phoneValue = (screen.getByLabelText('WhatsApp') as HTMLInputElement).value;
    const trigger = screen.getByRole('button', { name: 'Termos de Uso' });
    trigger.focus();
    fireEvent.click(trigger);

    const terms = screen.getByRole('dialog', { name: 'Termos de Uso' });
    expect(within(terms).getByText(/Restaurante Teste/)).toBeInTheDocument();
    expect(within(terms).getByText(/deve ser integralmente abatido/)).toBeInTheDocument();
    if (closeMethod === 'Escape') {
      fireEvent.keyDown(terms, { key: 'Escape', code: 'Escape' });
    } else {
      fireEvent.click(within(terms).getByRole('button', { name: 'Voltar à reserva' }));
    }

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termos de Uso' })).not.toBeInTheDocument());
    expect(screen.getByLabelText('Nome completo')).toHaveValue('Maria Silva');
    expect(screen.getByLabelText('E-mail (opcional)')).toHaveValue('maria@example.com');
    expect(screen.getByLabelText('WhatsApp')).toHaveValue(phoneValue);
    expect(screen.getByText(/às 18:00/)).toBeInTheDocument();
    expect(screen.getByText('2 pessoas')).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(supabaseMocks.rpc.mock.calls.some(([name]) => name === 'create_public_reservation')).toBe(false);
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
      expect.stringContaining('https://api.whatsapp.com/send?phone=5511999999999&text='),
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

  describe('texto do botão conforme a exigência de pagamento', () => {
    function expectNoExtraPaymentContent() {
      expect(screen.queryByRole('region', { name: 'Condições de pagamento da reserva' })).not.toBeInTheDocument();
      expect(screen.queryByText(/Esta data exige pagamento de sinal|Sinal por pessoa|Sinal por reserva|Reserva sem pagamento antecipado|Consultando condições da reserva|Não foi possível consultar as condições desta data|Aguarde a consulta|Cancelamento e devolução/)).not.toBeInTheDocument();
      expect(screen.queryByText(/R\$\s*\d/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
    }

    it('consulta na escolha da data, sem nome, telefone ou criação de reserva', async () => {
      renderModal(null);
      expect(paymentPreviewCalls()).toHaveLength(0);
      await selectTomorrow();

      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(1));
      expect(paymentPreviewCalls()[0][1].body).toEqual({
        action: 'preview', company_id: 'company-1', date: format(addDays(new Date(), 1), 'yyyy-MM-dd'),
      });
      expect(screen.queryByLabelText('WhatsApp')).not.toBeInTheDocument();
      expect(reservationCreationCalls()).toHaveLength(0);
      expect(supabaseMocks.rpc.mock.calls.some(([name]) => name === 'create_public_reservation')).toBe(false);
      expectNoExtraPaymentContent();
    });

    it('mantém Confirmar Reserva e o espaço anterior quando não exige pagamento', async () => {
      renderModal(null);
      await selectTomorrow();
      expectNoExtraPaymentContent();
      await confirmPartySize();
      await screen.findByRole('button', { name: /^18:00/ });
      expectNoExtraPaymentContent();
      fireEvent.click(screen.getByRole('button', { name: /^18:00/ }));

      expect(await screen.findByRole('button', { name: 'Confirmar Reserva' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Continuar para pagamento' })).not.toBeInTheDocument();
      expectNoExtraPaymentContent();
      const terms = screen.getByRole('button', { name: 'Termos de Uso' });
      expect(terms.closest('p')?.nextElementSibling).toContainElement(screen.getByRole('button', { name: 'Confirmar Reserva' }));
    });

    it('altera somente o texto final para Continuar para pagamento quando exigido', async () => {
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview'
        ? Promise.resolve({ data: paymentRequirement(String(options.body.date), true), error: null })
        : defaultInvoke(name, options));
      renderModal(null);
      await selectTomorrow();
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(1));
      expectNoExtraPaymentContent();
      await confirmPartySize();
      await screen.findByRole('button', { name: /^18:00/ });
      expectNoExtraPaymentContent();
      fireEvent.click(screen.getByRole('button', { name: /^18:00/ }));

      const submit = await screen.findByRole('button', { name: 'Continuar para pagamento' });
      expect(submit).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Confirmar Reserva' })).not.toBeInTheDocument();
      expectNoExtraPaymentContent();
      expect(screen.getByRole('button', { name: 'Termos de Uso' }).closest('p')?.nextElementSibling).toContainElement(submit);
      expect(paymentPreviewCalls()).toHaveLength(1);
    });

    it('não repete a consulta ao mudar quantidade ou horário na mesma data', async () => {
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview'
        ? Promise.resolve({ data: paymentRequirement(String(options.body.date), true), error: null })
        : defaultInvoke(name, options));
      renderModal(null);
      await goToReservationForm();
      expect(await screen.findByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Alterar pessoas' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Aumentar número de pessoas' }));
      await confirmPartySize(3);
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));

      expect(await screen.findByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();
      expect(paymentPreviewCalls()).toHaveLength(1);
      expectNoExtraPaymentContent();
    });

    it('mantém o botão original e permite a criação normal durante a consulta pendente', async () => {
      let releaseRequirement: (value: unknown) => void = () => undefined;
      const pendingRequirement = new Promise(resolve => { releaseRequirement = resolve; });
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview'
        ? pendingRequirement
        : defaultInvoke(name, options));
      mockKnownCustomerPrefill();
      renderModal(null);
      await goToReservationForm();
      await fillKnownCustomer();

      expect(screen.getByRole('button', { name: 'Confirmar Reserva' })).toBeEnabled();
      expectNoExtraPaymentContent();
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar Reserva' }));
      await waitFor(() => expect(reservationCreationCalls()).toHaveLength(1));
      expect(await screen.findByText(/está tudo pronto para você/)).toBeInTheDocument();
      await act(async () => releaseRequirement({ data: paymentRequirement(format(addDays(new Date(), 1), 'yyyy-MM-dd'), true), error: null }));
    });

    it.each([
      { data: null, error: null },
      { data: { requires_payment: true }, error: null },
      { data: { schema: 'legacy', requires_payment: true }, error: null },
      { data: null, error: { message: 'Falha de conexão na consulta antecipada.' } },
    ])('preserva o fluxo original se a consulta falhar ou retornar contrato antigo: %j', async previewResponse => {
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview'
        ? Promise.resolve(previewResponse)
        : defaultInvoke(name, options));
      mockKnownCustomerPrefill();
      renderModal(null);
      await goToReservationForm();
      await fillKnownCustomer();

      expect(screen.getByRole('button', { name: 'Confirmar Reserva' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Continuar para pagamento' })).not.toBeInTheDocument();
      expectNoExtraPaymentContent();
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar Reserva' }));
      await waitFor(() => expect(reservationCreationCalls()).toHaveLength(1));
      expect(await screen.findByText(/está tudo pronto para você/)).toBeInTheDocument();
      expect(paymentPreviewCalls()).toHaveLength(1);
    });

    it('não aplica a resposta de uma data anterior depois de escolher outra', async () => {
      const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
      const nextDate = addDays(new Date(), 2);
      let releaseOldRequirement: (value: unknown) => void = () => undefined;
      const oldRequirement = new Promise(resolve => { releaseOldRequirement = resolve; });
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => {
        if (options.body.action !== 'preview') return defaultInvoke(name, options);
        return options.body.date === tomorrow ? oldRequirement : Promise.resolve({ data: paymentRequirement(String(options.body.date), true), error: null });
      });
      renderModal(null);
      await selectTomorrow();
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Alterar data' }));
      fireEvent.click(await screen.findByRole('button', { name: new RegExp(`\\b${format(nextDate, 'dd')}\\b`) }));
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(2));
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      expect(await screen.findByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();

      await act(async () => releaseOldRequirement({ data: paymentRequirement(tomorrow), error: null }));
      expect(screen.getByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();
      expect(paymentPreviewCalls().map(([, options]) => options.body.date)).toEqual([tomorrow, format(nextDate, 'yyyy-MM-dd')]);
      expectNoExtraPaymentContent();
    });

    it('isola a consulta por unidade e ignora a resposta antiga ainda pendente', async () => {
      const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
      let releaseOldRequirement: (value: unknown) => void = () => undefined;
      const oldRequirement = new Promise(resolve => { releaseOldRequirement = resolve; });
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => {
        if (options.body.action !== 'preview') return defaultInvoke(name, options);
        return options.body.company_id === 'company-1' ? oldRequirement : Promise.resolve({
          data: paymentRequirement(String(options.body.date), true, String(options.body.company_id)), error: null,
        });
      });
      const view = renderModal(null);
      await selectTomorrow();
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(1));
      view.rerenderModal({ companyId: 'company-2', companyName: 'Outra unidade' });
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(2));
      await confirmPartySize();
      fireEvent.click(await screen.findByRole('button', { name: /^18:00/ }));
      expect(await screen.findByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();

      await act(async () => releaseOldRequirement({ data: paymentRequirement(tomorrow), error: null }));
      expect(screen.getByRole('button', { name: 'Continuar para pagamento' })).toBeEnabled();
      expect(paymentPreviewCalls().map(([, options]) => options.body.company_id)).toEqual(['company-1', 'company-2']);
      expect(reservationCreationCalls()).toHaveLength(0);
      expectNoExtraPaymentContent();
    });

    it('cancela a consulta ao fechar e faz uma leitura nova ao reabrir', async () => {
      let releaseOldRequirement: (value: unknown) => void = () => undefined;
      const oldRequirement = new Promise(resolve => { releaseOldRequirement = resolve; });
      const defaultInvoke = supabaseMocks.invoke.getMockImplementation()!;
      let attempts = 0;
      supabaseMocks.invoke.mockImplementation((name: string, options: { body: Record<string, unknown> }) => options.body.action === 'preview' && attempts++ === 0
        ? oldRequirement
        : defaultInvoke(name, options));
      const view = renderModal(null);
      await selectTomorrow();
      await waitFor(() => expect(paymentPreviewCalls()).toHaveLength(1));
      const firstSignal = paymentPreviewCalls()[0][1].signal as AbortSignal;
      view.rerenderModal({ open: false });
      await waitFor(() => expect(firstSignal.aborted).toBe(true));
      view.rerenderModal({ open: true });
      await goToReservationForm();
      expect(await screen.findByRole('button', { name: 'Confirmar Reserva' })).toBeEnabled();

      await act(async () => releaseOldRequirement({ data: paymentRequirement(format(addDays(new Date(), 1), 'yyyy-MM-dd'), true), error: null }));
      expect(screen.getByRole('button', { name: 'Confirmar Reserva' })).toBeEnabled();
      expect(paymentPreviewCalls()).toHaveLength(2);
      expectNoExtraPaymentContent();
    });

    it('envia a reserva pelo contrato original, sem cotação ou fingerprint adicional', async () => {
      mockKnownCustomerPrefill();
      renderModal(null);
      await goToReservationForm();
      await fillKnownCustomer();
      fireEvent.click(await screen.findByRole('button', { name: 'Confirmar Reserva' }));

      await waitFor(() => expect(reservationCreationCalls()).toHaveLength(1));
      const body = reservationCreationCalls()[0][1].body;
      expect(Object.keys(body).sort()).toEqual(['company_id', 'complete_without_payment', 'reservation']);
      expect(body).toEqual(expect.objectContaining({
        company_id: 'company-1', complete_without_payment: true,
        reservation: expect.objectContaining({ guest_name: 'Maria Silva', party_size: 2 }),
      }));
      expect(supabaseMocks.rpc.mock.calls.some(([name]) => name === 'create_public_reservation')).toBe(false);
      expect(await screen.findByText(/está tudo pronto para você/)).toBeInTheDocument();
    });

  });
});
