import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompanyNpsActivation } from '@/hooks/useCompanyNpsActivation';

const mock = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mock.from },
}));

const clients: QueryClient[] = [];

function createContext() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

describe('useCompanyNpsActivation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.from.mockReturnValue({ select: mock.select });
    mock.select.mockReturnValue({ eq: mock.eq });
    mock.eq.mockImplementation((_column: string, companyId: string) => ({
      maybeSingle: () => mock.maybeSingle(companyId),
    }));
    mock.maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    cleanup();
    clients.splice(0).forEach(client => client.clear());
  });

  it.each([true, false])('returns the confirmed activation state: %s', async enabled => {
    const config = { company_id: 'company-1', enabled };
    mock.maybeSingle.mockResolvedValue({ data: config, error: null });
    const { wrapper } = createContext();
    const { result } = renderHook(() => useCompanyNpsActivation('company-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(config);
    expect(mock.from).toHaveBeenCalledWith('company_nps_configs');
    expect(mock.select).toHaveBeenCalledWith('company_id, enabled');
    expect(mock.eq).toHaveBeenCalledWith('company_id', 'company-1');
  });

  it('does not query without a company and does not confirm an inactive state', () => {
    const { wrapper } = createContext();
    const { result } = renderHook(() => useCompanyNpsActivation(), { wrapper });

    expect(mock.from).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isSuccess).toBe(false);
  });

  it('returns null successfully when no company configuration exists', async () => {
    const { wrapper } = createContext();
    const { result } = renderHook(() => useCompanyNpsActivation('company-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('exposes a read error without converting it into confirmed disabled evaluations', async () => {
    const error = new Error('Configuration read failed');
    mock.maybeSingle.mockResolvedValue({ data: null, error });
    const { wrapper } = createContext();
    const { result } = renderHook(() => useCompanyNpsActivation('company-1'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(error);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isSuccess).toBe(false);
  });

  it('updates both consumers when the existing activation query key is invalidated', async () => {
    mock.maybeSingle.mockResolvedValue({
      data: { company_id: 'company-1', enabled: false }, error: null,
    });
    const { client, wrapper } = createContext();
    const { result } = renderHook(() => ({
      reports: useCompanyNpsActivation('company-1'),
      automations: useCompanyNpsActivation('company-1'),
    }), { wrapper });

    await waitFor(() => expect(result.current.reports.isSuccess).toBe(true));
    expect(result.current.automations.data?.enabled).toBe(false);
    expect(mock.maybeSingle).toHaveBeenCalledTimes(1);

    mock.maybeSingle.mockResolvedValue({
      data: { company_id: 'company-1', enabled: true }, error: null,
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['company-nps-activation', 'company-1'] });
    });

    await waitFor(() => expect(result.current.reports.data?.enabled).toBe(true));
    expect(result.current.automations.data?.enabled).toBe(true);
    expect(mock.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('keeps activation data isolated between companies', async () => {
    mock.maybeSingle.mockImplementation(async (companyId: string) => ({
      data: { company_id: companyId, enabled: companyId === 'company-1' }, error: null,
    }));
    const { client, wrapper } = createContext();
    const { result } = renderHook(() => ({
      first: useCompanyNpsActivation('company-1'),
      second: useCompanyNpsActivation('company-2'),
    }), { wrapper });

    await waitFor(() => expect(result.current.second.isSuccess).toBe(true));
    expect(result.current.first.data?.enabled).toBe(true);
    expect(result.current.second.data?.enabled).toBe(false);
    expect(client.getQueryData(['company-nps-activation', 'company-1'])).toEqual({
      company_id: 'company-1', enabled: true,
    });
    expect(client.getQueryData(['company-nps-activation', 'company-2'])).toEqual({
      company_id: 'company-2', enabled: false,
    });
  });

  it('reports a refetch failure even when a previous active state remains cached', async () => {
    mock.maybeSingle.mockResolvedValue({
      data: { company_id: 'company-1', enabled: true }, error: null,
    });
    const { client, wrapper } = createContext();
    const { result } = renderHook(() => useCompanyNpsActivation('company-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    mock.maybeSingle.mockResolvedValue({ data: null, error: new Error('Unavailable') });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['company-nps-activation', 'company-1'] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.enabled).toBe(true);
    expect(result.current.isSuccess).toBe(false);
  });
});
