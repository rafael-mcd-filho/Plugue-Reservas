import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuditLogs } from '@/hooks/useSettings';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  logs: vi.fn(),
  profiles: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.from,
  },
}));

const clients: QueryClient[] = [];

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-one',
    user_id: 'active-user',
    action: 'update_user',
    entity_type: 'user',
    entity_id: 'target-user',
    details: { target_email: 'target@example.test' },
    ip_address: null,
    created_at: '2026-10-06T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.logs.mockResolvedValue({ data: [], error: null });
  mocks.profiles.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'audit_logs') {
      const query = {
        select: () => query,
        order: () => query,
        limit: mocks.logs,
      };
      return query;
    }
    if (table === 'profiles') {
      return { select: () => ({ in: mocks.profiles }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('useAuditLogs actor history', () => {
  it('returns deleted-only history with its snapshots without querying profiles', async () => {
    const deleted = auditRow({
      user_id: null,
      actor_user_id: 'deleted-user',
      actor_name: 'Historical name',
      actor_email: 'deleted@example.test',
    });
    const unnamed = auditRow({
      id: 'log-two',
      user_id: null,
      actor_user_id: 'another-deleted-user',
      actor_name: null,
      actor_email: null,
    });
    mocks.logs.mockResolvedValue({ data: [deleted, unnamed], error: null });

    const { result } = renderHook(() => useAuditLogs(100), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([deleted, unnamed]);
    expect(mocks.logs).toHaveBeenCalledWith(100);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.profiles).not.toHaveBeenCalled();
  });

  it('preserves snapshots while resolving missing fields for active and legacy actors', async () => {
    const active = auditRow({
      actor_user_id: 'active-user',
      actor_name: 'Original active name',
      actor_email: 'original@example.test',
    });
    const deleted = auditRow({
      id: 'deleted-log',
      user_id: null,
      actor_user_id: 'deleted-user',
      actor_name: 'Deleted name',
      actor_email: 'deleted@example.test',
    });
    const legacy = auditRow({ id: 'legacy-log', user_id: 'legacy-user' });
    const partial = auditRow({
      id: 'partial-log',
      user_id: 'legacy-user',
      actor_user_id: 'legacy-user',
      actor_name: 'Original legacy name',
      actor_email: null,
    });
    const missingProfile = auditRow({ id: 'missing-profile-log', user_id: 'missing-user' });
    mocks.logs.mockResolvedValue({ data: [active, deleted, legacy, partial, missingProfile], error: null });
    mocks.profiles.mockResolvedValue({
      data: [
        { id: 'active-user', full_name: 'Renamed active user', email: 'new@example.test' },
        { id: 'legacy-user', full_name: 'Current legacy name', email: 'legacy@example.test' },
      ],
      error: null,
    });

    const { result } = renderHook(() => useAuditLogs(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      active,
      deleted,
      { ...legacy, actor_user_id: 'legacy-user', actor_name: 'Current legacy name', actor_email: 'legacy@example.test' },
      { ...partial, actor_email: 'legacy@example.test' },
      { ...missingProfile, actor_user_id: 'missing-user', actor_name: null, actor_email: null },
    ]);
    expect(mocks.profiles).toHaveBeenCalledWith('id', ['legacy-user', 'missing-user']);
  });

  it('does not depend on current profiles when every live actor has a snapshot', async () => {
    const row = auditRow({
      actor_user_id: 'active-user',
      actor_name: 'Original name',
      actor_email: 'original@example.test',
    });
    mocks.logs.mockResolvedValue({ data: [row], error: null });
    mocks.profiles.mockResolvedValue({ data: null, error: { message: 'Profile unavailable' } });

    const { result } = renderHook(() => useAuditLogs(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([row]);
    expect(mocks.profiles).not.toHaveBeenCalled();
  });
});
