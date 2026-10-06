import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveFunnelPresence } from '@/hooks/useLiveFunnelPresence';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}));

const clients: QueryClient[] = [];

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 3 } } });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const presenceRows = [
  { stage: 'page_view', stage_count: '2', total_active: '3', window_minutes: 5 },
  { stage: 'date_select', stage_count: 1, total_active: 3, window_minutes: 5 },
];

describe('useLiveFunnelPresence', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockReturnValue({
      abortSignal: () => Promise.resolve({ data: presenceRows, error: null }),
    });
  });

  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear());
    vi.restoreAllMocks();
  });

  it.each([undefined, 'all'])('não consulta a agregação global para empresa %s', (companyId) => {
    const { result } = renderHook(() => useLiveFunnelPresence(companyId), { wrapper: createWrapper() });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('carrega as contagens da empresa e completa as etapas sem sessões', async () => {
    const { result } = renderHook(() => useLiveFunnelPresence('company-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcMock).toHaveBeenCalledWith('get_live_funnel_presence', {
      _company_id: 'company-1', _window_minutes: 5,
    });
    expect(result.current.data).toEqual({
      totalActive: 3,
      windowMinutes: 5,
      stages: [
        { stage: 'page_view', count: 2 },
        { stage: 'date_select', count: 1 },
        { stage: 'time_select', count: 0 },
        { stage: 'form_fill', count: 0 },
        { stage: 'completed', count: 0 },
      ],
    });
  });

  it('encerra o carregamento após erro mesmo com retries globais habilitados', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rpcMock.mockReturnValue({
      abortSignal: () => Promise.resolve({ data: null, error: { code: '42501', message: 'Acesso negado' } }),
    });
    const { result } = renderHook(() => useLiveFunnelPresence('company-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('cancela a consulta anterior ao trocar de empresa e carrega somente a nova', async () => {
    let previousSignal: AbortSignal | undefined;
    rpcMock.mockReturnValueOnce({
      abortSignal: (signal: AbortSignal) => {
        previousSignal = signal;
        return new Promise(() => undefined);
      },
    });
    const { result, rerender } = renderHook(({ companyId }) => useLiveFunnelPresence(companyId), {
      initialProps: { companyId: 'company-1' }, wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    rerender({ companyId: 'company-2' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(previousSignal?.aborted).toBe(true);
    expect(rpcMock).toHaveBeenLastCalledWith('get_live_funnel_presence', {
      _company_id: 'company-2', _window_minutes: 5,
    });
    expect(result.current.data?.totalActive).toBe(3);
  });
});
