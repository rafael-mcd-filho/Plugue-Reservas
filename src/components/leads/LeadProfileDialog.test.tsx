/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeadProfileDialog from '@/components/leads/LeadProfileDialog';
import type { CrmLeadPresenceVisit } from '@/hooks/useCrmLeads';
import type { CrmLeadProfile } from '@/lib/crm-lead-profile';

const historyState = vi.hoisted(() => ({
  visits: [] as CrmLeadPresenceVisit[],
}));

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
  default: () => null,
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

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LeadProfileDialog
        open
        onOpenChange={vi.fn()}
        lead={lead}
        companyId="00000000-0000-4000-8000-000000000001"
        slug="empresa-teste"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  historyState.visits = [];
});

describe('LeadProfileDialog', () => {
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
