import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ManualReservationDialog, { type ManualReservationPreset } from '@/components/ManualReservationDialog';

const supabaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
}));

const crmLeadPrefillMocks = vi.hoisted(() => ({
  useCrmLeadPrefill: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: supabaseMocks.rpc,
    functions: { invoke: supabaseMocks.invoke },
  },
}));

vi.mock('@/hooks/useCrmLeadPrefill', () => ({
  MIN_CRM_LEAD_PREFILL_PHONE_DIGITS: 10,
  useCrmLeadPrefill: crmLeadPrefillMocks.useCrmLeadPrefill,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderDialog(preset: ManualReservationPreset | null) {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ManualReservationDialog
        open
        onOpenChange={onOpenChange}
        companyId="company-1"
        preset={preset}
        onCreated={onCreated}
      />
    </QueryClientProvider>,
  );

  return { onCreated, onOpenChange };
}

function fillGuest() {
  fireEvent.change(screen.getByLabelText('Nome *'), { target: { value: 'Maria Lima' } });
  fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: '11999998888' } });
}

describe('ManualReservationDialog', () => {
  beforeEach(() => {
    supabaseMocks.rpc.mockReset();
    supabaseMocks.rpc.mockResolvedValue({ data: { id: 'reservation-1' }, error: null });
    supabaseMocks.invoke.mockReset();
    supabaseMocks.invoke.mockResolvedValue({ data: null, error: null });
    crmLeadPrefillMocks.useCrmLeadPrefill.mockReset();
    crmLeadPrefillMocks.useCrmLeadPrefill.mockReturnValue({ data: null, isFetching: false });
  });

  it('cria a reserva na mesa escolhida, com data e horário travados', async () => {
    const { onCreated, onOpenChange } = renderDialog({
      date: '2026-09-23',
      time: '18:00',
      partySize: 4,
      table: { id: 'table-3', number: 3, sectionName: 'Salão', capacity: 4 },
    });

    expect(screen.getByText('Mesa 3 · Salão · 4 lugares')).toBeInTheDocument();
    expect(screen.queryByLabelText('Data *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Horário *')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Pessoas *')).toHaveValue(4);

    fillGuest();
    fireEvent.click(screen.getByRole('button', { name: 'Criar reserva' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'reservation-1' }));
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('create_panel_reservation', expect.objectContaining({
      _company_id: 'company-1',
      _date: '2026-09-23',
      _time: '18:00:00',
      _party_size: 4,
      _table_id: 'table-3',
    }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('mantém data e horário editáveis sem mesa definida', async () => {
    const { onCreated } = renderDialog({ date: '2026-09-23', time: '20:00', partySize: 6, remainingCapacity: 5 });

    expect(screen.getByLabelText('Data *')).toHaveValue('2026-09-23');
    expect(screen.getByLabelText('Horário *')).toHaveValue('20:00');
    expect(screen.getByLabelText('Pessoas *')).toHaveValue(5);
    expect(screen.getByText('Restam 5 vagas neste horário.')).toBeInTheDocument();

    fillGuest();
    fireEvent.click(screen.getByRole('button', { name: 'Criar reserva' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('create_panel_reservation', expect.objectContaining({
      _time: '20:00:00',
      _party_size: 5,
      _table_id: null,
    }));
  });

  it('remove dados autopreenchidos quando o telefone muda para outro sem lead', async () => {
    crmLeadPrefillMocks.useCrmLeadPrefill.mockImplementation((_companyId, phoneDigits) => ({
      data: phoneDigits === '11999998888'
        ? {
          id: 'lead-a',
          full_name: 'Ana Souza',
          phone: '11999998888',
          phone_normalized: '11999998888',
          email: 'ana@example.com',
          birthdate: '1990-05-12',
        }
        : null,
      isFetching: false,
    }));

    renderDialog({ date: '2026-09-23', time: '20:00', partySize: 2 });

    fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: '11999998888' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Nome *')).toHaveValue('Ana Souza');
      expect(screen.getByLabelText('Email')).toHaveValue('ana@example.com');
      expect(screen.getByLabelText('Data de nascimento')).toHaveValue('1990-05-12');
    });

    fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: '11888887777' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Nome *')).toHaveValue('');
      expect(screen.getByLabelText('Email')).toHaveValue('');
      expect(screen.getByLabelText('Data de nascimento')).toHaveValue('');
    });
  });

  it('preserva dados editados manualmente ao trocar o telefone autopreenchido', async () => {
    crmLeadPrefillMocks.useCrmLeadPrefill.mockImplementation((_companyId, phoneDigits) => ({
      data: phoneDigits === '11999998888'
        ? {
          id: 'lead-a',
          full_name: 'Ana Souza',
          phone: '11999998888',
          phone_normalized: '11999998888',
          email: 'ana@example.com',
          birthdate: '1990-05-12',
        }
        : null,
      isFetching: false,
    }));

    renderDialog({ date: '2026-09-23', time: '20:00', partySize: 2 });

    fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: '11999998888' } });
    await waitFor(() => expect(screen.getByLabelText('Nome *')).toHaveValue('Ana Souza'));

    fireEvent.change(screen.getByLabelText('Nome *'), { target: { value: 'Nome revisado' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'novo@example.com' } });
    fireEvent.change(screen.getByLabelText('Data de nascimento'), { target: { value: '1991-06-13' } });
    fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: '11888887777' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Nome *')).toHaveValue('Nome revisado');
      expect(screen.getByLabelText('Email')).toHaveValue('novo@example.com');
      expect(screen.getByLabelText('Data de nascimento')).toHaveValue('1991-06-13');
    });
  });
});
