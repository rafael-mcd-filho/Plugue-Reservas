import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublicWaitlistPage from '@/pages/PublicWaitlistPage';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), navigate: vi.fn(), invoke: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, functions: { invoke: mocks.invoke } },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ slug: 'restaurant' }),
}));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: vi.fn() }));
vi.mock('@/hooks/useFunnelTracking', () => ({ getVisitorId: () => 'visitor-1' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><PublicWaitlistPage /></QueryClientProvider>);
}

describe('PublicWaitlistPage phone persistence', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ data: null, error: null });
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'get_public_company_by_slug'
        ? [{ id: 'company-1', name: 'Restaurant', public_waitlist_enabled: true }]
        : [{ tracking_code: 'tracking-1' }],
      error: null,
    }));
  });

  it.each([
    ['(55) 99999-8888', '+5555999998888'],
    ['+1 407 264 1934', '+14072641934'],
    ['+351 912 345 678', '+351912345678'],
  ])('persists %s with its complete country code', async (input, canonical) => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Nome *'), { target: { value: 'Maria Lima' } });
    fireEvent.change(screen.getByLabelText('WhatsApp *'), { target: { value: input } });
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'maria@example.com' } });
    fireEvent.change(screen.getByLabelText('Data de nascimento *'), { target: { value: '1990-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar na fila' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('join_public_waitlist', expect.objectContaining({
      _guest_phone: canonical,
      _slug: 'restaurant',
    })));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/restaurant/fila/tracking-1', { replace: true }));
  });
});
