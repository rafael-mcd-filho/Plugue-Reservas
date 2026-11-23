import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreatePlatformWhatsAppNotice, usePlatformWhatsAppNotices, useRetryPlatformWhatsAppNotice } from './usePlatformWhatsAppNotices';

const mock = vi.hoisted(() => ({
  user: { id: 'admin-a' } as { id: string } | null, roles: ['superadmin'] as string[],
  fetch: vi.fn(), create: vi.fn(), retry: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mock.user, roles: mock.roles }) }));
vi.mock('@/lib/platform-whatsapp-notices', () => ({
  fetchPlatformWhatsAppNotices: mock.fetch, createPlatformWhatsAppNotice: mock.create, retryPlatformWhatsAppNotice: mock.retry,
}));

const response = { rows: [], total: 0, instance_name: 'RWSL', contact_kind: 'responsible' };
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.user = { id: 'admin-a' }; mock.roles = ['superadmin'];
  mock.fetch.mockResolvedValue(response); mock.create.mockResolvedValue(response); mock.retry.mockResolvedValue(response);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe('platform notice hooks', () => {
  it('does not request WhatsApp history while disabled or outside global superadmin access', async () => {
    const context = setup();
    const view = renderHook(({ enabled }) => usePlatformWhatsAppNotices({ enabled, offset: 0, limit: 25 }), { wrapper: context.wrapper, initialProps: { enabled: false } });
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.roles = ['admin']; view.rerender({ enabled: true });
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.roles = ['superadmin']; view.rerender({ enabled: true });
    await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(1));
    expect(mock.fetch).toHaveBeenCalledWith({ offset: 0, limit: 25 }, expect.any(AbortSignal));
  });
  it('never reuses another actor or revoked authorization history', async () => {
    const context = setup();
    mock.fetch.mockResolvedValueOnce({ ...response, total: 1, rows: [{ id: 'private-row', status: 'accepted' }] });
    const view = renderHook(() => usePlatformWhatsAppNotices({ enabled: true, offset: 0, limit: 25 }), { wrapper: context.wrapper });
    await waitFor(() => expect(view.result.current.data?.total).toBe(1));
    mock.roles = ['operator']; view.rerender();
    expect(view.result.current.data).toBeUndefined();
    mock.roles = ['superadmin']; mock.user = { id: 'admin-b' }; view.rerender();
    await waitFor(() => expect(view.result.current.data?.total).toBe(0));
    expect(view.result.current.data?.rows).toEqual([]);
  });
  it('preserves a failed request as an error rather than empty successful history', async () => {
    const context = setup(); mock.fetch.mockRejectedValueOnce(new Error('Serviço indisponível.'));
    const view = renderHook(() => usePlatformWhatsAppNotices({ enabled: true }), { wrapper: context.wrapper });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.data).toBeUndefined(); expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it('invalidates notice history after create and retry without displaying a sent toast', async () => {
    const context = setup(); const invalidate = vi.spyOn(context.client, 'invalidateQueries');
    const create = renderHook(() => useCreatePlatformWhatsAppNotice(), { wrapper: context.wrapper });
    const retry = renderHook(() => useRetryPlatformWhatsAppNotice(), { wrapper: context.wrapper });
    const input = { request_id: 'request-opaque', company_ids: ['company'], caption: 'Aviso', image_path: 'path' };
    await act(async () => { await create.result.current.mutateAsync(input); });
    await act(async () => { await retry.result.current.mutateAsync({ notice_id: 'notice' }); });
    expect(mock.create).toHaveBeenCalledWith(input); expect(mock.retry).toHaveBeenCalledWith({ notice_id: 'notice' });
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['platform-whatsapp-notices'] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ['platform-whatsapp-notices'] });
  });
  it('denies unauthorized mutations before either API call', async () => {
    mock.roles = ['admin']; const context = setup();
    const create = renderHook(() => useCreatePlatformWhatsAppNotice(), { wrapper: context.wrapper });
    const retry = renderHook(() => useRetryPlatformWhatsAppNotice(), { wrapper: context.wrapper });
    await expect(create.result.current.mutateAsync({ request_id: '', company_ids: [], image_path: '', caption: '' })).rejects.toThrow('Sem permissão');
    await expect(retry.result.current.mutateAsync({ notice_id: '' })).rejects.toThrow('Sem permissão');
    expect(mock.create).not.toHaveBeenCalled(); expect(mock.retry).not.toHaveBeenCalled();
  });
});
