import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyPublicPage from '@/pages/CompanyPublicPage';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ slug: 'restaurant' }) }));
vi.mock('@/publicCompanyBootstrap', () => ({ getPrefetchedPublicCompany: () => null }));
vi.mock('@/hooks/useSettings', () => ({ useSystemBranding: () => ({ data: null }) }));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: vi.fn() }));
vi.mock('@/hooks/useFunnelTracking', () => ({
  useFunnelTracking: () => ({ trackStep: vi.fn(), startJourney: vi.fn(), getImmediateTrackingSnapshot: vi.fn(), clearJourney: vi.fn() }),
}));
vi.mock('@/components/ui/rich-text-editor', () => ({ RichTextContent: () => null }));
vi.mock('@/components/ReservationModal', () => ({ default: () => null }));

const company = {
  id: 'company-1', name: 'Restaurante Teste', slug: 'restaurant',
  public_header_style: 'classic', opening_hours: [
    { day: 'Seg', open: '17:00', close: '22:30', closed: true },
    { day: 'Ter', open: '17:00', close: '22:30', closed: false },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><CompanyPublicPage /></QueryClientProvider>);
  return client;
}

describe('CompanyPublicPage opening hours', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 12, 18).getTime());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 12, 18));
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'get_public_company_by_slug' ? [company]
        : name === 'get_public_reservation_schedule_range' ? [{
          reservation_date: '2026-10-12', source: 'date_specific', slots: ['19:00', '20:00'],
        }] : [],
      error: null,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updates both the current status and today\'s row without replacing company hours', async () => {
    const client = renderPage();
    expect(await screen.findByText('Aberto agora')).toBeInTheDocument();
    expect(screen.getByText('Fecha às 22:30')).toBeInTheDocument();
    const today = screen.getByText('Segunda · hoje').parentElement!;
    expect(today).toHaveTextContent('17:00 – 22:30');
    expect(today).not.toHaveTextContent('Fechado');
    expect(mocks.rpc).toHaveBeenCalledWith('get_public_reservation_schedule_range', {
      _company_id: 'company-1', _start_date: '2026-10-11', _end_date: '2026-10-20',
    });
    client.clear();
  });

  it('does not show a closed weekly status while the rules are still loading', async () => {
    let resolveSchedule!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveSchedule = resolve; });
    mocks.rpc.mockImplementation((name: string) => name === 'get_public_reservation_schedule_range'
      ? pending : Promise.resolve({ data: name === 'get_public_company_by_slug' ? [company] : [], error: null }));
    const client = renderPage();
    expect(await screen.findByText('Consultando funcionamento...')).toBeInTheDocument();
    expect(screen.queryByText('Abre amanhã')).not.toBeInTheDocument();
    expect(screen.queryByText('Fechado')).not.toBeInTheDocument();
    resolveSchedule({ data: [{ reservation_date: '2026-10-12', source: 'date_specific', slots: ['19:00'] }], error: null });
    await waitFor(() => expect(screen.getByText('Aberto agora')).toBeInTheDocument());
    client.clear();
  });
});
