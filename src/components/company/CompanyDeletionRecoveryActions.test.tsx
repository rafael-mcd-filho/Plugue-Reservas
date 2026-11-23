import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CompanyDeletionRecoveryActions } from '@/components/company/CompanyDeletionRecoveryActions';
import type { CompanyDeletionRequest } from '@/hooks/useCompanies';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const queryClients: QueryClient[] = [];

function renderRecovery(phase: string, status: CompanyDeletionRequest['status'] = 'needs_attention') {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClients.push(queryClient);
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <CompanyDeletionRecoveryActions request={{ company_id: 'company-one', phase, status }} />
    </QueryClientProvider>,
  );
  return { invalidateQueries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: { status: 'running' }, error: null });
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
});

describe('company deletion recovery', () => {
  it('retries a failed database phase without offering to skip external cleanup', async () => {
    const { invalidateQueries } = renderRecovery('tracking_events');

    expect(screen.queryByRole('button', { name: 'Pular etapa externa' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retomar exclusão' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('retry_company_deletion', {
      _company_id: 'company-one',
    }));
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['company-deletion-requests'] }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['companies'] });
    expect(toast.success).toHaveBeenCalledWith('Exclusão retomada. O processamento continuará automaticamente.');
  });

  it('offers skipping only for a failed external teardown phase', async () => {
    renderRecovery('external_teardown');

    expect(screen.getByRole('button', { name: 'Retomar exclusão' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pular etapa externa' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('force_skip_company_deletion_teardown', {
      _company_id: 'company-one',
    }));
  });

  it('prevents competing recovery actions while a retry is pending', async () => {
    let resolveRetry!: (result: { data: null; error: null }) => void;
    mocks.rpc.mockReturnValue(new Promise((resolve) => { resolveRetry = resolve; }));
    renderRecovery('external_teardown');

    fireEvent.click(screen.getByRole('button', { name: 'Retomar exclusão' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retomar exclusão' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Pular etapa externa' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Pular etapa externa' }));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    resolveRetry({ data: null, error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retomar exclusão' })).toBeEnabled());
  });

  it('keeps the failed request visible and reports a refused retry', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Solicitação não está pausada.' } });
    const { invalidateQueries } = renderRecovery('tracking_events');

    fireEvent.click(screen.getByRole('button', { name: 'Retomar exclusão' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Erro ao retomar exclusão: Solicitação não está pausada.'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retomar exclusão' })).toBeEnabled();
  });

  it('does not offer manual recovery for a request still running', () => {
    renderRecovery('external_teardown', 'running');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
