import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanyDeletionRequests, type CompanyDeletionRequest } from '@/hooks/useCompanies';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

const queryClients: QueryClient[] = [];

function request(id: string, status: CompanyDeletionRequest['status']) {
  return { id, status } as CompanyDeletionRequest;
}

function renderRequests() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useCompanyDeletionRequests(), { wrapper }), invalidateQueries };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
});

describe('company deletion progress', () => {
  it('refreshes companies once when an existing request completes', async () => {
    mocks.rpc.mockResolvedValue({ data: [request('one', 'running')], error: null });
    const { result, invalidateQueries } = renderRequests();
    await waitFor(() => expect(result.current.data?.[0].status).toBe('running'));
    expect(invalidateQueries).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({ data: [request('one', 'completed')], error: null });
    await act(async () => { await result.current.refetch(); });
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ['companies'] });

    await act(async () => { await result.current.refetch(); });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for completed history on the initial fetch', async () => {
    mocks.rpc.mockResolvedValue({ data: [request('old', 'completed')], error: null });
    const { result, invalidateQueries } = renderRequests();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await act(async () => { await result.current.refetch(); });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('refreshes when a deletion was requested and completed between polls', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const { result, invalidateQueries } = renderRequests();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    mocks.rpc.mockResolvedValue({ data: [request('new', 'completed')], error: null });
    await act(async () => { await result.current.refetch(); });
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ['companies'] });
  });
});
