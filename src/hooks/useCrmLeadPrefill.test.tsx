import type { PropsWithChildren } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrmLeadPrefill } from '@/hooks/useCrmLeadPrefill';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  queries: [] as Array<{ table: string; companyId?: string; filter?: string }>,
  rows: {} as Record<string, unknown[]>,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mocks.from },
}));

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useCrmLeadPrefill international identity', () => {
  beforeEach(() => {
    mocks.queries.length = 0;
    mocks.rows = {};
    mocks.from.mockReset();
    mocks.from.mockImplementation((table: string) => {
      const query = { table } as (typeof mocks.queries)[number];
      mocks.queries.push(query);
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          if (column === 'company_id') query.companyId = value;
          return builder;
        }),
        or: vi.fn((filter: string) => {
          query.filter = filter;
          return builder;
        }),
        order: vi.fn(() => builder),
        limit: vi.fn(() => Promise.resolve({ data: mocks.rows[table] ?? [], error: null })),
      };
      return builder;
    });
  });

  it('uses company and full international identity for every source', async () => {
    mocks.rows.crm_leads = [{
      id: 'lead-us',
      full_name: 'John Smith',
      phone: '4072641934',
      phone_e164: '+14072641934',
      email: 'john@example.com',
      imported_at: '2026-10-01T00:00:00Z',
    }];

    const { result } = renderHook(() => useCrmLeadPrefill('company-1', '+1 407 264 1934'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(expect.objectContaining({
      phone: '+14072641934',
      phone_normalized: '+14072641934',
      full_name: 'John Smith',
    }));
    expect(mocks.queries).toHaveLength(5);
    for (const query of mocks.queries) {
      expect(query.companyId).toBe('company-1');
      expect(query.filter).toContain('_e164.eq.+14072641934');
      expect(query.filter).not.toContain('eq."4072641934"');
      expect(query.filter).not.toContain('554072641934');
    }
  });

  it('retains exact legacy Brazilian lookup without stripping DDD 55', async () => {
    const { result } = renderHook(() => useCrmLeadPrefill('company-br', '(55) 99999-8888'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    for (const query of mocks.queries) {
      expect(query.filter).toContain('_e164.eq.+5555999998888');
      expect(query.filter).toContain('eq."55999998888"');
      expect(query.filter).not.toContain('eq."999998888"');
    }
  });

  it('rejects legacy matches belonging to another canonical country identity', async () => {
    mocks.rows.reservations = [{
      id: 'reservation-br',
      guest_name: 'Contato brasileiro',
      guest_phone: '11999998888',
      guest_phone_e164: '+5511999998888',
      created_at: '2026-10-01T00:00:00Z',
    }];

    const { result } = renderHook(() => useCrmLeadPrefill('company-1', '+14072641934'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('does not search partial, invalid, disabled, or unscoped telephone numbers', () => {
    renderHook(() => useCrmLeadPrefill('company-1', '+1407'), { wrapper });
    renderHook(() => useCrmLeadPrefill('company-1', '+14072641934', false), { wrapper });
    renderHook(() => useCrmLeadPrefill(null, '+14072641934'), { wrapper });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
