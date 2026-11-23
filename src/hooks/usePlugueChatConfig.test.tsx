import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PlugueChatTemplate, useUpsertPlugueChatTemplate } from './usePlugueChatConfig';

const { fromMock, upsertMock, selectMock, singleMock, successMock, errorMock } = vi.hoisted(() => ({
  fromMock: vi.fn(), upsertMock: vi.fn(), selectMock: vi.fn(), singleMock: vi.fn(), successMock: vi.fn(), errorMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: fromMock } }));
vi.mock('sonner', () => ({ toast: { success: successMock, error: errorMock } }));

const payload = {
  company_id: 'company-1', type: 'post_visit', enabled: true, template_id: 'approved-template',
  template_name: 'Approved', post_visit_include_review_link: true,
};
const saved: PlugueChatTemplate = {
  ...payload, id: 'saved-1', created_at: '2026-11-21T12:00:00Z', updated_at: '2026-11-21T13:00:00Z',
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const result = renderHook(() => useUpsertPlugueChatTemplate(), { wrapper });
  return { ...result, client };
}

describe('useUpsertPlugueChatTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockReturnValue({ upsert: upsertMock });
    upsertMock.mockReturnValue({ select: selectMock });
    selectMock.mockReturnValue({ single: singleMock });
    singleMock.mockResolvedValue({ data: saved, error: null });
  });

  it('persists the whole card once and updates only the selected company cache', async () => {
    const { result, client } = setup();
    const otherType = { ...saved, id: 'other-type', type: 'confirmation_message' };
    const previous = { ...saved, enabled: false, template_id: 'old-template' };
    const otherCompany = [{ ...saved, company_id: 'company-2' }];
    client.setQueryData(['pluguechat-templates', 'company-1'], [previous, otherType]);
    client.setQueryData(['pluguechat-templates', 'company-2'], otherCompany);
    const cancel = vi.spyOn(client, 'cancelQueries');

    await act(async () => { await result.current.mutateAsync(payload); });

    expect(fromMock).toHaveBeenCalledWith('pluguechat_automation_templates');
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock).toHaveBeenCalledWith({ ...payload, updated_at: expect.any(String) }, { onConflict: 'company_id,type' });
    expect(selectMock).toHaveBeenCalledWith('*');
    expect(client.getQueryData(['pluguechat-templates', 'company-1'])).toEqual([otherType, saved]);
    expect(client.getQueryData(['pluguechat-templates', 'company-2'])).toEqual(otherCompany);
    expect(cancel).toHaveBeenNthCalledWith(1, { queryKey: ['pluguechat-templates', 'company-1'], exact: true });
    expect(cancel).toHaveBeenNthCalledWith(2, { queryKey: ['pluguechat-templates', 'company-1'], exact: true });
    expect(successMock).toHaveBeenCalledWith('Template salvo.');
    client.clear();
  });

  it('keeps cached settings unchanged and reports a failed save', async () => {
    const failure = new Error('Failed to save');
    singleMock.mockResolvedValue({ data: null, error: failure });
    const { result, client } = setup();
    const previous = [{ ...saved, enabled: false }];
    client.setQueryData(['pluguechat-templates', 'company-1'], previous);

    await act(async () => { await expect(result.current.mutateAsync(payload)).rejects.toThrow('Failed to save'); });

    expect(client.getQueryData(['pluguechat-templates', 'company-1'])).toEqual(previous);
    expect(successMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith('Erro ao salvar template. Tente novamente.');
    client.clear();
  });
});
