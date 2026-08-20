import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

import {
  FunnelDataValidationError,
  canReusePreviousFunnelData,
  getFortalezaCalendarDate,
  getFunnelAwareFreshnessLabel,
  getFunnelPresentationState,
  getFunnelQueryKey,
  getFunnelRefetchInterval,
  getFunnelRequestValidationError,
  normalizeFunnelQueryParams,
  shouldRetryFunnelQuery,
  useFunnelData,
  validateFunnelRows,
  type FunnelQueryResult,
} from '@/hooks/useFunnelData';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const START_DATE = new Date(2026, 7, 1, 18, 35, 20);
const END_DATE = new Date(2026, 7, 20, 6, 5, 10);

const validRows = [
  { step: 'page_view', event_count: 100, data_source: 'fast' },
  { step: 'date_select', event_count: '80', data_source: 'fast' },
  { step: 'time_select', event_count: 60, data_source: 'fast' },
  { step: 'form_fill', event_count: 40, data_source: 'fast' },
  { step: 'completed', event_count: 20, data_source: 'fast' },
];

function createRpcRequest(response: { data: unknown; error: unknown }) {
  const request = Promise.resolve(response) as Promise<typeof response> & {
    abortSignal: ReturnType<typeof vi.fn>;
  };
  request.abortSignal = vi.fn(() => request);
  return request;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: 0 },
    },
  });

  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function resultWithCounts(counts: number[]): FunnelQueryResult {
  const params = normalizeFunnelQueryParams({
    scope: { kind: 'company', companyId: COMPANY_ID },
    startDate: START_DATE,
    endDate: END_DATE,
  })!;

  return {
    request: params,
    dataSource: 'fast',
    points: ['page_view', 'date_select', 'time_select', 'form_fill', 'completed'].map((step, index) => ({
      step: step as FunnelQueryResult['points'][number]['step'],
      count: counts[index],
    })),
  };
}

describe('parâmetros do funil', () => {
  it('gera datas canônicas sem carregar horário ou offset para a query key', () => {
    const morning = normalizeFunnelQueryParams({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: new Date(2026, 7, 1, 0, 1),
      endDate: new Date(2026, 7, 20, 9, 10),
      uniqueOnly: true,
    });
    const evening = normalizeFunnelQueryParams({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: new Date(2026, 7, 1, 23, 59),
      endDate: new Date(2026, 7, 20, 22, 45),
      uniqueOnly: true,
    });

    expect(morning).toEqual({
      scope: 'company',
      companyId: COMPANY_ID,
      startDate: '2026-08-01',
      endDate: '2026-08-20',
      uniqueOnly: true,
    });
    expect(evening).toEqual(morning);
    expect(getFunnelQueryKey(morning!)).toEqual(['funnel-data', morning]);
  });

  it('só cria escopo global quando ele é explícito', () => {
    expect(normalizeFunnelQueryParams({
      scope: null,
      startDate: START_DATE,
      endDate: END_DATE,
    })).toBeNull();
    expect(normalizeFunnelQueryParams({
      scope: { kind: 'company', companyId: 'all' },
      startDate: START_DATE,
      endDate: END_DATE,
    })).toBeNull();
    expect(normalizeFunnelQueryParams({
      scope: { kind: 'global' },
      startDate: START_DATE,
      endDate: END_DATE,
    })).toMatchObject({ scope: 'global', companyId: null });
  });

  it('recusa períodos superiores a 366 dias antes de consultar o banco', () => {
    const startDate = new Date(2025, 0, 1);
    const endDate = new Date(2026, 0, 2);

    expect(getFunnelRequestValidationError(startDate, endDate)?.message).toContain('no máximo 366 dias');
    expect(normalizeFunnelQueryParams({
      scope: { kind: 'global' },
      startDate,
      endDate,
    })).toBeNull();
    expect(normalizeFunnelQueryParams({
      scope: { kind: 'global' },
      startDate,
      endDate: new Date(2026, 0, 1),
    })).not.toBeNull();
  });

  it('só agenda polling de cinco minutos quando o período inclui hoje em Fortaleza', () => {
    const current = normalizeFunnelQueryParams({
      scope: { kind: 'global' },
      startDate: new Date(2026, 7, 1),
      endDate: new Date(2026, 7, 20),
    })!;
    const historical = { ...current, endDate: '2026-08-19' };

    expect(getFortalezaCalendarDate(new Date('2026-08-21T02:30:00.000Z'))).toBe('2026-08-20');
    expect(getFunnelRefetchInterval(current, '2026-08-20')).toBe(300_000);
    expect(getFunnelRefetchInterval(historical, '2026-08-20')).toBe(false);
  });
});

describe('validação e estados do funil', () => {
  it('aceita somente as cinco etapas únicas com inteiros não negativos', () => {
    expect(validateFunnelRows([...validRows].reverse())).toEqual([
      { step: 'page_view', count: 100 },
      { step: 'date_select', count: 80 },
      { step: 'time_select', count: 60 },
      { step: 'form_fill', count: 40 },
      { step: 'completed', count: 20 },
    ]);

    expect(() => validateFunnelRows(validRows.slice(0, 4))).toThrow(FunnelDataValidationError);
    expect(() => validateFunnelRows([
      validRows[0],
      validRows[0],
      ...validRows.slice(2),
    ])).toThrow(FunnelDataValidationError);
    expect(() => validateFunnelRows([
      { ...validRows[0], event_count: -1 },
      ...validRows.slice(1),
    ])).toThrow(FunnelDataValidationError);
    expect(() => validateFunnelRows([
      validRows[0],
      { ...validRows[1], event_count: 101 },
      ...validRows.slice(2),
    ])).toThrow(FunnelDataValidationError);
  });

  it.each([
    [{ data: undefined, isPending: true, isFetching: true, isError: false }, 'loading'],
    [{ data: undefined, isPending: false, isFetching: true, isError: true }, 'loading'],
    [{ data: resultWithCounts([10, 8, 6, 4, 2]), isPending: false, isFetching: true, isError: false }, 'refreshing'],
    [{ data: resultWithCounts([10, 8, 6, 4, 2]), isPending: false, isFetching: true, isError: true }, 'refreshing'],
    [{ data: resultWithCounts([10, 8, 6, 4, 2]), isPending: false, isFetching: false, isError: true }, 'stale-error'],
    [{ data: undefined, isPending: false, isFetching: false, isError: true }, 'error'],
    [{ data: resultWithCounts([0, 0, 0, 0, 0]), isPending: false, isFetching: false, isError: false }, 'valid-empty'],
    [{ data: resultWithCounts([10, 8, 6, 4, 2]), isPending: false, isFetching: false, isError: false }, 'ready'],
  ] as const)('distingue o estado visual %s', (input, expected) => {
    expect(getFunnelPresentationState(input)).toBe(expected);
  });

  it('não repete timeout, autenticação, permissão, cancelamento ou resposta inválida', () => {
    expect(shouldRetryFunnelQuery(0, { code: '57014', message: 'statement timeout' })).toBe(false);
    expect(shouldRetryFunnelQuery(0, { status: 401, message: 'JWT expired' })).toBe(false);
    expect(shouldRetryFunnelQuery(0, { code: '42501', message: 'permission denied' })).toBe(false);
    expect(shouldRetryFunnelQuery(0, new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(shouldRetryFunnelQuery(0, new FunnelDataValidationError('inválido'))).toBe(false);
    expect(shouldRetryFunnelQuery(0, new Error('network unavailable'))).toBe(true);
    expect(shouldRetryFunnelQuery(1, new Error('network unavailable'))).toBe(false);
  });

  it('só reaproveita dados anteriores quando empresa e modo de contagem continuam identificados', () => {
    const current = normalizeFunnelQueryParams({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: START_DATE,
      endDate: END_DATE,
      uniqueOnly: false,
    })!;

    expect(canReusePreviousFunnelData(current, {
      ...current,
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    })).toBe(true);
    expect(canReusePreviousFunnelData(current, { ...current, companyId: crypto.randomUUID() })).toBe(false);
    expect(canReusePreviousFunnelData(current, { ...current, uniqueOnly: true })).toBe(false);
  });

  it('prioriza erro parcial no status geral mesmo durante sincronização', () => {
    expect(getFunnelAwareFreshnessLabel({
      hasFunnelError: true,
      isSyncing: true,
      isStale: false,
    })).toBe('Erro parcial');
    expect(getFunnelAwareFreshnessLabel({
      hasFunnelError: false,
      isSyncing: false,
      isStale: false,
    })).toBe('Atualizado');
  });
});

describe('consulta do funil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chama o wrapper da empresa com datas inclusivas e conecta o AbortSignal', async () => {
    const request = createRpcRequest({ data: validRows, error: null });
    mocks.rpc.mockReturnValue(request);
    const { result } = renderHook(() => useFunnelData({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: START_DATE,
      endDate: END_DATE,
      uniqueOnly: true,
      enabled: true,
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mocks.rpc).toHaveBeenCalledWith('get_tracking_funnel_report', {
      _company_id: COMPANY_ID,
      _start_date: '2026-08-01',
      _end_date: '2026-08-20',
      _unique_only: true,
    });
    expect(request.abortSignal).toHaveBeenCalledTimes(1);
    expect(request.abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(result.current.data).toMatchObject({ dataSource: 'fast' });
  });

  it('usa o wrapper global sem transformar escopo ausente em consulta global', async () => {
    mocks.rpc.mockImplementation(() => createRpcRequest({ data: validRows, error: null }));
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: Parameters<typeof useFunnelData>[0]['scope'] }) => useFunnelData({
        scope,
        startDate: START_DATE,
        endDate: END_DATE,
        enabled: true,
      }),
      { initialProps: { scope: null }, wrapper },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(mocks.rpc).not.toHaveBeenCalled();

    rerender({ scope: { kind: 'global' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledWith('get_global_tracking_funnel_report', {
      _start_date: '2026-08-01',
      _end_date: '2026-08-20',
      _unique_only: false,
    });
  });

  it('trata uma resposta malformada como erro, nunca como funil zerado', async () => {
    mocks.rpc.mockReturnValue(createRpcRequest({ data: validRows.slice(0, 4), error: null }));
    const { result } = renderHook(() => useFunnelData({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: START_DATE,
      endDate: END_DATE,
      enabled: true,
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('preserva e identifica o período anterior somente enquanto o novo carrega', async () => {
    let resolveSecondRequest!: (response: { data: unknown; error: unknown }) => void;
    const secondRequest = new Promise<{ data: unknown; error: unknown }>((resolve) => {
      resolveSecondRequest = resolve;
    }) as Promise<{ data: unknown; error: unknown }> & { abortSignal: ReturnType<typeof vi.fn> };
    secondRequest.abortSignal = vi.fn(() => secondRequest);
    mocks.rpc
      .mockReturnValueOnce(createRpcRequest({ data: validRows, error: null }))
      .mockReturnValueOnce(secondRequest);

    const { result, rerender } = renderHook(
      ({ startDate, endDate }: { startDate: Date; endDate: Date }) => useFunnelData({
        scope: { kind: 'company', companyId: COMPANY_ID },
        startDate,
        endDate,
        enabled: true,
      }),
      {
        initialProps: { startDate: new Date(2026, 6, 1), endDate: new Date(2026, 6, 31) },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ startDate: START_DATE, endDate: END_DATE });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.request).toMatchObject({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    resolveSecondRequest({ data: validRows, error: null });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data?.request).toMatchObject({
      startDate: '2026-08-01',
      endDate: '2026-08-20',
    });
  });

  it('cancela a requisição em andamento ao desmontar a consulta', async () => {
    let attachedSignal: AbortSignal | undefined;
    const pendingRequest = new Promise<{ data: unknown; error: unknown }>(() => {}) as Promise<{
      data: unknown;
      error: unknown;
    }> & { abortSignal: ReturnType<typeof vi.fn> };
    pendingRequest.abortSignal = vi.fn((signal: AbortSignal) => {
      attachedSignal = signal;
      return pendingRequest;
    });
    mocks.rpc.mockReturnValue(pendingRequest);

    const { unmount } = renderHook(() => useFunnelData({
      scope: { kind: 'company', companyId: COMPANY_ID },
      startDate: START_DATE,
      endDate: END_DATE,
      enabled: true,
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(attachedSignal).toBeDefined());
    unmount();
    expect(attachedSignal?.aborted).toBe(true);
  });

  it('mostra período excessivo como erro local sem chamar a RPC', async () => {
    const { result } = renderHook(() => useFunnelData({
      scope: { kind: 'global' },
      startDate: new Date(2025, 0, 1),
      endDate: new Date(2026, 0, 2),
      enabled: true,
    }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
