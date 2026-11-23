import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanyAnnouncementNotifications, useCompanyNotifications, useMarkNotificationsRead, useNotifications } from './useSettings';

const mock = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, summaries: [] as Array<Record<string, unknown>>, rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'notifications') throw new Error(`Unexpected table ${table}`);
      const filters: Array<{ column: string; value: unknown }> = [];
      const query = {
        select: () => query,
        neq: (column: string, value: unknown) => { filters.push({ column, value }); return query; },
        order: () => Promise.resolve({
          data: mock.rows.filter((row) => filters.every(({ column, value }) => row[column] !== value)), error: null,
        }),
      };
      return query;
    },
    rpc: (...args: unknown[]) => mock.rpc(...args),
  },
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.rows = [];
  mock.summaries = [];
  mock.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_notification_delivery_summaries') return { data: mock.summaries, error: null };
    if (name === 'get_company_announcement_notifications') return { data: mock.rows.filter((row) => row.type !== 'reservation_change'), error: null };
    if (name === 'get_company_notifications') return { data: mock.rows, error: null };
    if (name === 'mark_notifications_read') return { data: 1, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
});

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('superadmin announcement history', () => {
  it('excludes customer reservation changes while retaining other announcement types and their delivery summaries', async () => {
    mock.rows = [
      { id: 'change', type: 'reservation_change', title: 'Reserva remarcada' },
      { id: 'info', type: 'info', title: 'Aviso do superadmin' },
      { id: 'other', type: 'another_type', title: 'Outro tipo existente' },
    ];
    mock.summaries = [
      { notification_id: 'change', recipient_count: 3, read_count: 1 },
      { notification_id: 'info', recipient_count: 5, read_count: 2, last_read_at: '2026-11-22T15:00:00Z' },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      expect.objectContaining({ id: 'info', recipient_count: 5, read_count: 2, last_read_at: '2026-11-22T15:00:00Z' }),
      expect.objectContaining({ id: 'other', recipient_count: 0, read_count: 0, last_read_at: null }),
    ]);
    queryClient.clear();
  });
});

describe('company announcement query and existing notification bell', () => {
  it('uses a separate announcement query while keeping operational changes available to the bell', async () => {
    mock.rows = [{ id: 'change', type: 'reservation_change' }, { id: 'info', type: 'info' }];
    const { result } = renderHook(() => ({
      banner: useCompanyAnnouncementNotifications('company-a', 20),
      bell: useCompanyNotifications('company-a', 12),
    }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.banner.isSuccess && result.current.bell.isSuccess).toBe(true));
    expect(result.current.banner.data?.map((notice) => notice.id)).toEqual(['info']);
    expect(result.current.bell.data?.map((notice) => notice.id)).toEqual(['change', 'info']);
    expect(mock.rpc).toHaveBeenCalledWith('get_company_announcement_notifications', { _company_id: 'company-a', _limit: 20 });
    expect(mock.rpc).toHaveBeenCalledWith('get_company_notifications', { _company_id: 'company-a', _limit: 12 });
  });

  it.each(['PGRST202', '42883'])('falls back to the existing bounded query only when the new RPC is absent (%s)', async (code) => {
    mock.rpc.mockImplementation(async (name: string) => name === 'get_company_announcement_notifications'
      ? { data: null, error: { code, message: 'Function does not exist' } }
      : { data: [{ id: 'info', type: 'info' }, { id: 'change', type: 'reservation_change' }], error: null });
    const { result } = renderHook(() => useCompanyAnnouncementNotifications('company-a', 20), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((notice) => notice.id)).toEqual(['info']);
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(['get_company_announcement_notifications', 'get_company_notifications']);
    expect(mock.rpc).toHaveBeenLastCalledWith('get_company_notifications', { _company_id: 'company-a', _limit: 20 });
  });

  it('does not hide permission or connectivity errors behind a legacy fallback', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Permission denied' } });
    const { result } = renderHook(() => useCompanyAnnouncementNotifications('company-a'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(result.current.data).toBeUndefined();
  });

  it('refreshes both announcement and bell queries after marking an announcement read', async () => {
    mock.rows = [{ id: 'info', type: 'info', is_read: false }];
    const { result } = renderHook(() => ({
      banner: useCompanyAnnouncementNotifications('company-a', 20),
      bell: useCompanyNotifications('company-a', 12),
      mark: useMarkNotificationsRead(),
    }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.banner.isSuccess && result.current.bell.isSuccess).toBe(true));
    mock.rows[0].is_read = true;
    await act(async () => { await result.current.mark.mutateAsync({ companyId: 'company-a', ids: ['info'] }); });
    await waitFor(() => {
      expect(mock.rpc.mock.calls.filter(([name]) => name === 'get_company_announcement_notifications')).toHaveLength(2);
      expect(mock.rpc.mock.calls.filter(([name]) => name === 'get_company_notifications')).toHaveLength(2);
    });
    expect(result.current.banner.data?.[0].is_read).toBe(true);
    expect(result.current.bell.data?.[0].is_read).toBe(true);
  });
});
