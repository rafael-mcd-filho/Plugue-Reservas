/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeadProfileDialog, { type LeadProfileDialogProps } from '@/components/leads/LeadProfileDialog';
import type { CrmLeadPresenceVisit } from '@/hooks/useCrmLeads';
import type { CrmLeadProfile } from '@/lib/crm-lead-profile';
import { type ReactNode, useEffect } from 'react';

// The relationship tabs have their own server-contract and behavior coverage.
const relationshipState = vi.hoisted(() => ({ access: true as boolean | null }));
vi.mock('@/components/leads/LeadRelationshipPanel', () => ({ default: function MockLeadRelationshipPanel({ children, onReservationAccessChange, canViewReservations }: { children: ReactNode; onReservationAccessChange: (allowed: boolean) => void; canViewReservations: boolean }) {
  const access = relationshipState.access;
  useEffect(() => { onReservationAccessChange(canViewReservations && access === true); }, [onReservationAccessChange, canViewReservations, access]);
  return children;
} }));

const historyState = vi.hoisted(() => ({
  visits: [] as CrmLeadPresenceVisit[],
}));

const detailState = vi.hoisted(() => ({
  props: [] as Array<Record<string, any>>,
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  abortSignal: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const query = {
    select: detailState.select.mockReturnThis(),
    eq: detailState.eq.mockReturnThis(),
    abortSignal: detailState.abortSignal.mockReturnThis(),
    maybeSingle: detailState.maybeSingle.mockResolvedValue({
      data: { id: 'reservation-1', guest_name: 'João Rocha' },
      error: null,
    }),
  };
  detailState.from.mockReturnValue(query);
  return { supabase: { from: detailState.from } };
});

vi.mock('@/hooks/useCrmLeads', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/useCrmLeads')>();
  return {
    ...original,
    useCrmLeadPresenceHistory: () => ({
      data: {
        customer_key: 'phone:5583999991020',
        visits: historyState.visits,
        meta: { page: 1, page_size: 100, total_visits: historyState.visits.length },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});

vi.mock('@/components/ReservationDetailsDialog', () => ({
  default: (props: Record<string, any>) => {
    detailState.props.push(props);
    return null;
  },
}));

const lead: CrmLeadProfile = {
  key: 'phone:5583999991020',
  guest_phone: '(83) 99999-1020',
  guest_name: 'João Rocha',
  guest_email: 'joao@example.com',
  guest_birthdate: null,
  total_reservations: 60,
  lead_created_at: '2026-01-01T12:00:00Z',
  last_reservation_date: '2026-03-01',
  last_reservation_time: '20:00:00',
  stateCode: 'PB',
  stateName: 'Paraíba',
  source: 'reservation_holder',
  importedLeadId: null,
  importedNotes: null,
  importedAt: null,
  importedByUserId: null,
  importFilename: null,
};

function createVisits(total: number): CrmLeadPresenceVisit[] {
  return Array.from({ length: total }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return {
      id: `event-${index + 1}`,
      visit_id: `reservation-${index + 1}`,
      created_at: `${date}T20:00:00Z`,
      date,
      time: '20:00:00',
      party_size: 2,
      status: 'checked_in',
      occasion: null,
      lead_source: 'reservation_holder',
      visit_origin: 'reservation',
      origin_waitlist_id: null,
      reservation_holder_name: 'João Rocha',
    };
  });
}

function renderDialog(overrides: Partial<LeadProfileDialogProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const content = (next: Partial<LeadProfileDialogProps>) => (
    <QueryClientProvider client={queryClient}>
      <LeadProfileDialog
        open
        onOpenChange={vi.fn()}
        lead={lead}
        companyId="00000000-0000-4000-8000-000000000001"
        slug="empresa-teste"
        {...next}
      />
    </QueryClientProvider>
  );
  const view = render(content(overrides));
  return {
    ...view,
    rerenderDialog: (next: Partial<LeadProfileDialogProps>) => view.rerender(content({ ...overrides, ...next })),
  };
}

afterEach(() => {
  cleanup();
  historyState.visits = [];
  detailState.props = [];
  relationshipState.access = true;
  vi.clearAllMocks();
});

describe('LeadProfileDialog', () => {
  it('blocks presence shortcuts until server reservation access is known, and keeps them blocked after denial', () => {
    relationshipState.access = null;
    historyState.visits = createVisits(1);
    const view = renderDialog();
    expect(screen.queryByRole('button', { name: /Abrir detalhes da presença/ })).not.toBeInTheDocument();
    expect(detailState.from).not.toHaveBeenCalled();
    relationshipState.access = false;
    view.rerenderDialog({});
    expect(screen.queryByRole('button', { name: /Abrir detalhes da presença/ })).not.toBeInTheDocument();
    expect(detailState.props.at(-1)).toMatchObject({ open: false, reservation: null });
  });

  it('closes reservation details and removes all presence shortcuts after server access is revoked', async () => {
    historyState.visits = createVisits(1);
    const view = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' }));
    await waitFor(() => expect(detailState.props.at(-1)?.reservation?.id).toBe('reservation-1'));
    const requests = detailState.from.mock.calls.length;
    relationshipState.access = false;
    view.rerenderDialog({});
    expect(detailState.props.at(-1)).toMatchObject({ open: false, reservation: null });
    expect(screen.queryByRole('button', { name: /Abrir detalhes da presença/ })).not.toBeInTheDocument();
    expect(detailState.from).toHaveBeenCalledTimes(requests);
  });

  it('does not display a late reservation response under a different customer profile', async () => {
    historyState.visits = createVisits(1);
    let complete!: (value: unknown) => void;
    detailState.maybeSingle.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const view = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' }));
    await waitFor(() => expect(detailState.from).toHaveBeenCalledOnce());
    const previousSignal = detailState.abortSignal.mock.calls[0][0] as AbortSignal;
    relationshipState.access = null;
    view.rerenderDialog({ lead: { ...lead, key: 'phone:other', guest_name: 'Outro cliente' } });
    await waitFor(() => expect(previousSignal.aborted).toBe(true));
    complete({ data: { id: 'reservation-1', guest_name: 'João Rocha' }, error: null });
    await waitFor(() => expect(detailState.props.at(-1)).toMatchObject({ open: false, reservation: null }));
    detailState.maybeSingle.mockResolvedValue({ data: { id: 'reservation-1', guest_name: 'João Rocha' }, error: null });
  });

  it('mantém o histórico legível sem abrir ou consultar reservas quando o acesso está bloqueado', () => {
    historyState.visits = createVisits(2);
    renderDialog({ canViewReservations: false });

    expect(screen.getByText('Histórico de Presenças (60)')).toBeInTheDocument();
    expect(screen.getByText('01/01/2026 às 20:00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Abrir detalhes da presença/ })).not.toBeInTheDocument();
    expect(detailState.from).not.toHaveBeenCalled();
    expect(detailState.props.at(-1)).toMatchObject({ open: false, reservation: null });
  });

  it('abre a reserva da unidade em consulta e propaga as permissões de histórico', async () => {
    historyState.visits = createVisits(1);
    const onEdit = vi.fn();
    renderDialog({ readOnly: true, showEventHistory: false, showLeadHistory: true, onEdit });

    expect(screen.queryByRole('button', { name: 'Editar dados do lead' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' }));

    await waitFor(() => expect(detailState.props.at(-1)).toMatchObject({
      open: true,
      readOnly: true,
      showEventHistory: false,
      showLeadHistory: true,
      reservation: { id: 'reservation-1' },
    }));
    expect(detailState.from).toHaveBeenCalledWith('reservations');
    expect(detailState.eq).toHaveBeenCalledWith('company_id', '00000000-0000-4000-8000-000000000001');
    expect(detailState.eq).toHaveBeenCalledWith('id', 'reservation-1');
    expect(detailState.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('fecha o detalhe e remove os atalhos quando o acesso a reservas é revogado', async () => {
    historyState.visits = createVisits(1);
    const view = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' }));
    await waitFor(() => expect(detailState.props.at(-1)?.reservation?.id).toBe('reservation-1'));
    const requestsBeforeRevoke = detailState.from.mock.calls.length;

    view.rerenderDialog({ canViewReservations: false });

    expect(detailState.props.at(-1)).toMatchObject({ open: false, reservation: null });
    expect(screen.queryByRole('button', { name: /Abrir detalhes da presença/ })).not.toBeInTheDocument();
    expect(detailState.from).toHaveBeenCalledTimes(requestsBeforeRevoke);
  });

  it('preserva a edição e os padrões de detalhes nos usos existentes', async () => {
    historyState.visits = createVisits(1);
    const onEdit = vi.fn();
    renderDialog({ onEdit });
    fireEvent.click(screen.getByRole('button', { name: 'Editar dados do lead' }));
    expect(onEdit).toHaveBeenCalledWith(lead);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' }));
    await waitFor(() => expect(detailState.props.at(-1)).toMatchObject({
      open: true, readOnly: false, showEventHistory: true, showLeadHistory: false,
      reservation: { id: 'reservation-1' },
    }));
  });

  it('mantém o histórico integral, mas renderiza somente 25 presenças por página', () => {
    historyState.visits = createVisits(60);
    renderDialog();

    expect(screen.getByText('Histórico de Presenças (60)')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Abrir detalhes da presença/ })).toHaveLength(25);
    expect(screen.getByText('1–25 de 60 presenças')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir detalhes da presença de 26/01/2026' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página do histórico' }));

    expect(screen.getAllByRole('button', { name: /Abrir detalhes da presença/ })).toHaveLength(25);
    expect(screen.getByText('26–50 de 60 presenças')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir detalhes da presença de 01/01/2026' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir detalhes da presença de 26/01/2026' })).toBeInTheDocument();
  });

  it('expõe estados acessíveis de carregamento e erro do perfil sob demanda', () => {
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <LeadProfileDialog
          open
          onOpenChange={vi.fn()}
          lead={null}
          companyId="00000000-0000-4000-8000-000000000001"
          slug="empresa-teste"
          profileLoading
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Carregando perfil do cliente');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <LeadProfileDialog
          open
          onOpenChange={vi.fn()}
          lead={null}
          companyId="00000000-0000-4000-8000-000000000001"
          slug="empresa-teste"
          profileError="Não foi possível carregar o perfil."
          onRetryProfile={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar o perfil.');
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled();
  });
});
