import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import {
  getCompanyDeletionRequestErrorMessage,
  useCancelCompanyDeletion,
  useRequestCompanyDeletion,
} from '@/hooks/useCompanies';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe('exclusão permanente de empresa (fluxo assíncrono)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('solicita exclusão via RPC com confirmação e motivo', async () => {
    mocks.rpc.mockResolvedValue({
      data: { request_id: 'req-1', grace_period_ends_at: '2026-08-27T00:00:00Z', impact_preview: {} },
      error: null,
    });
    const { queryClient, wrapper } = createWrapper();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRequestCompanyDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        companyId: COMPANY_ID,
        confirmationText: 'Minha Empresa',
        reason: 'Encerramento de contrato',
      });
    });

    expect(mocks.rpc).toHaveBeenCalledWith('request_company_deletion', {
      _company_id: COMPANY_ID,
      _confirmation_text: 'Minha Empresa',
      _reason: 'Encerramento de contrato',
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['companies'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['company-deletion-requests'] });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('cancela uma solicitação em período de carência', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'canceled' }, error: null });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCancelCompanyDeletion(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync(COMPANY_ID);
    });

    expect(mocks.rpc).toHaveBeenCalledWith('cancel_company_deletion', { _company_id: COMPANY_ID });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Exclusão cancelada.');
  });

  it.each([
    [{ code: '55006', message: 'active request exists' }, 'Já existe uma solicitação de exclusão ativa para esta empresa.'],
    [{ code: '42501', message: 'not superadmin' }, 'Somente superadministradores podem solicitar a exclusão de empresas.'],
    [
      { code: '22023', message: 'Digite exatamente o nome ou o identificador (slug) da empresa para confirmar.' },
      'O texto digitado não corresponde ao nome ou identificador da empresa.',
    ],
  ])('traduz o erro PostgreSQL %s', async (databaseError, expectedMessage) => {
    mocks.rpc.mockResolvedValue({ data: null, error: databaseError });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRequestCompanyDeletion(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ companyId: COMPANY_ID, confirmationText: 'x', reason: 'y' }),
      ).rejects.toEqual(databaseError);
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(expectedMessage);
    });
  });

  it('mantém uma mensagem útil para falhas não mapeadas', () => {
    expect(getCompanyDeletionRequestErrorMessage({ message: 'Falha desconhecida' })).toBe(
      'Erro ao solicitar exclusão: Falha desconhecida',
    );
    expect(getCompanyDeletionRequestErrorMessage(null)).toBe('Não foi possível solicitar a exclusão da empresa.');
  });
});
