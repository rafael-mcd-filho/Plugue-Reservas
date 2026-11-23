import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useLastPanelAccess } from './useLastPanelAccess';

const database = vi.hoisted(() => ({
  rows: [] as Array<{ user_id: string; company_id: string; event_type: string; created_at: string }>,
  error: null as Error | null,
  calls: [] as Array<Record<string, string>>,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const filters: Record<string, string> = {};
      database.calls.push(filters);
      const query = {
        select: () => query,
        eq: (key: string, value: string) => { filters[key] = value; return query; },
        order: () => query,
        limit: async () => ({
          data: database.rows.filter(row => Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value))
            .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 1),
          error: database.error,
        }),
      };
      return query;
    },
  },
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  database.calls = [];
  database.error = null;
  database.rows = [
    { user_id: 'support-user', company_id: 'company-a', event_type: 'panel_access', created_at: '2026-11-23T18:00:00Z' },
    { user_id: 'support-user', company_id: 'company-b', event_type: 'panel_access', created_at: '2026-11-23T19:00:00Z' },
    { user_id: 'support-user', company_id: 'company-a', event_type: 'login', created_at: '2026-11-23T20:00:00Z' },
  ];
});

describe('last panel access company scope', () => {
  it('shows access to the open company without borrowing a later support visit to another unit', async () => {
    const view = renderHook(() => useLastPanelAccess(['support-user'], 'company-a'), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data).toEqual({ 'support-user': '2026-11-23T18:00:00Z' });
    expect(database.calls).toEqual([{ user_id: 'support-user', event_type: 'panel_access', company_id: 'company-a' }]);
  });

  it('keeps the existing global user list behavior when no company is requested', async () => {
    const view = renderHook(() => useLastPanelAccess(['support-user', 'support-user']), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data).toEqual({ 'support-user': '2026-11-23T19:00:00Z' });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]).not.toHaveProperty('company_id');
  });

  it('does not reuse a different company result from the query cache', async () => {
    const view = renderHook(({ companyId }) => useLastPanelAccess(['support-user'], companyId), { initialProps: { companyId: 'company-a' }, wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.data?.['support-user']).toBe('2026-11-23T18:00:00Z'));
    view.rerender({ companyId: 'company-b' });
    await waitFor(() => expect(view.result.current.data?.['support-user']).toBe('2026-11-23T19:00:00Z'));
    expect(database.calls.map(call => call.company_id)).toEqual(['company-a', 'company-b']);
  });

  it('reports lookup failures instead of returning no access', async () => {
    database.error = new Error('Unavailable');
    const view = renderHook(() => useLastPanelAccess(['support-user'], 'company-a'), { wrapper: wrapper() });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.data).toBeUndefined();
  });
});
