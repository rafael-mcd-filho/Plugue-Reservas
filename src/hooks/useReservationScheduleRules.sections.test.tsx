import { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReservationScheduleRules, useSaveReservationScheduleRule, type ReservationScheduleRuleDraft } from './useReservationScheduleRules';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
}
function builder(result: () => unknown) {
  const query = { select: vi.fn((_selection: string) => query), eq: () => query, is: () => query, order: () => query, limit: () => query,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject) };
  return query;
}
const draft: ReservationScheduleRuleDraft = {
  company_id: 'company-one', name: 'Jantar', scope: 'weekly', weekdays: null, start_date: null, end_date: null,
  enabled: true, priority: 100, publish_at: null,
  blocks: [{ name: 'Padrão', weekdays: [1], availability_mode: 'capacity', slots: [{ time: '18:00', is_full: false,
    duration_minutes: 60, max_party_size_per_reservation: 8, max_reservations_per_slot: null, max_guests_per_slot: 20,
    allow_section_selection: true, sections: [{ section_id: 'section-one', capacity_guests: 10, enabled: true, sort_order: 0 }],
  }] }],
};

describe('compatibilidade da escolha de ambientes na agenda', () => {
  beforeEach(() => { mocks.from.mockReset(); mocks.rpc.mockReset(); });

  it('continua listando regras antigas quando a relação nova ainda não existe', async () => {
    const query = builder(() => query.select.mock.calls.at(-1)?.[0].includes('slot_sections')
      ? { data: null, error: { code: 'PGRST200', message: 'Missing relationship reservation_schedule_rule_slot_sections' } }
      : { data: [{ id: 'rule-one', reservation_schedule_rule_blocks: [], reservation_schedule_rule_slots: [] }], error: null });
    mocks.from.mockReturnValue(query);
    const { result } = renderHook(() => useReservationScheduleRules('company-one'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].id).toBe('rule-one');
    expect(query.select).toHaveBeenCalledTimes(2);
  });

  it('não esconde uma falha de permissão como se o banco fosse antigo', async () => {
    const query = builder(() => ({ data: null, error: { code: '42501', message: 'Access denied' } }));
    mocks.from.mockReturnValue(query);
    const { result } = renderHook(() => useReservationScheduleRules('company-one'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(query.select).toHaveBeenCalledTimes(1);
  });

  it('impede o banco antigo de ignorar silenciosamente uma escolha de ambientes', async () => {
    mocks.from.mockReturnValue(builder(() => ({ data: null, error: { code: '42P01', message: 'Missing relation' } })));
    const { result } = renderHook(() => useSaveReservationScheduleRule(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync(draft)).rejects.toThrow('ainda não está disponível'); });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('envia opções e cotas na mesma gravação da agenda', async () => {
    mocks.from.mockReturnValue(builder(() => ({ data: [], error: null })));
    mocks.rpc.mockResolvedValue({ data: 'rule-one', error: null });
    const { result } = renderHook(() => useSaveReservationScheduleRule(), { wrapper });
    await act(async () => { await result.current.mutateAsync(draft); });
    expect(mocks.rpc).toHaveBeenCalledWith('upsert_reservation_schedule_rule', expect.objectContaining({
      _blocks: [expect.objectContaining({ slots: [expect.objectContaining({ allow_section_selection: true, sections: draft.blocks[0].slots[0].sections })] })],
    }));
  });
});
