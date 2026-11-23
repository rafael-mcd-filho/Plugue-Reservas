import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AutomationSetting, useUpsertAutomation } from './useAutomations';

const { fromMock, upsertMock, selectMock, singleMock, successMock, errorMock } = vi.hoisted(() => ({
  fromMock: vi.fn(), upsertMock: vi.fn(), selectMock: vi.fn(), singleMock: vi.fn(), successMock: vi.fn(), errorMock: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: fromMock } }));
vi.mock('sonner', () => ({ toast: { success: successMock, error: errorMock } }));

const payload = { company_id: 'company-1', type: 'post_visit', enabled: true, message_template: 'Obrigado, {nome}!' };
const saved: AutomationSetting = { ...payload, id: 'saved-1', created_at: '2026-11-21T12:00:00Z', updated_at: '2026-11-21T13:00:00Z' };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...renderHook(() => useUpsertAutomation(), { wrapper }), client };
}

describe('useUpsertAutomation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockReturnValue({ upsert: upsertMock });
    upsertMock.mockReturnValue({ select: selectMock });
    selectMock.mockReturnValue({ single: singleMock });
    singleMock.mockResolvedValue({ data: saved, error: null });
  });

  it('writes activation and text once, replaces only its saved card and cancels stale company reads', async () => {
    const { result, client } = setup();
    const otherType = { ...saved, id: 'other-type', type: 'waitlist_entry' };
    const otherCompany = [{ ...saved, company_id: 'company-2' }];
    client.setQueryData(['automation-settings', 'company-1'], [{ ...saved, enabled: false }, otherType]);
    client.setQueryData(['automation-settings', 'company-2'], otherCompany);
    const cancel = vi.spyOn(client, 'cancelQueries');
    await act(async () => { await result.current.mutateAsync(payload); });
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock).toHaveBeenCalledWith({ ...payload, updated_at: expect.any(String) }, { onConflict: 'company_id,type' });
    expect(client.getQueryData(['automation-settings', 'company-1'])).toEqual([otherType, saved]);
    expect(client.getQueryData(['automation-settings', 'company-2'])).toEqual(otherCompany);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['automation-settings', 'company-1'], exact: true });
    expect(successMock).toHaveBeenCalledWith('Automação salva!');
    client.clear();
  });

  it('keeps the previously saved cache after a failed write', async () => {
    singleMock.mockResolvedValue({ data: null, error: new Error('offline') });
    const { result, client } = setup();
    const previous = [{ ...saved, enabled: false }];
    client.setQueryData(['automation-settings', 'company-1'], previous);
    await act(async () => { await expect(result.current.mutateAsync(payload)).rejects.toThrow('offline'); });
    expect(client.getQueryData(['automation-settings', 'company-1'])).toEqual(previous);
    expect(successMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledOnce();
    client.clear();
  });
});
