import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CentralReservationAsaasCard from './CentralReservationAsaasCard';
import type { CentralReservationAsaasConfig } from '@/lib/reservation-asaas-config-api';

const mocks = vi.hoisted(() => ({ manage: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/reservation-asaas-config-api', () => ({ manageCentralReservationAsaasConfig: mocks.manage }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, warning: mocks.warning, error: mocks.error } }));

const configured: CentralReservationAsaasConfig = {
  status: 'configured', environment: 'production', account_id: 'wallet-central',
  has_api_token: true, token_last_four: 'abcd', last_validated_at: '2026-11-07T12:00:00Z',
  last_error: null, webhook_id: 'hook-central', webhook_url: 'https://offline.invalid/asaas-webhook',
  webhook_email: 'finance@example.test',
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><CentralReservationAsaasCard /></QueryClientProvider>);
}

describe('CentralReservationAsaasCard', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.manage.mockResolvedValue(configured); });
  afterEach(cleanup);

  it('shows one central account without revealing a stored token and can test the saved integration', async () => {
    renderCard();
    await screen.findByText('Conta central conectada');
    expect(screen.getByLabelText('Token da sua conta Asaas')).toHaveValue('');
    expect(screen.getByLabelText('Token da sua conta Asaas')).toHaveAttribute('type', 'password');
    expect(screen.getByText(/Uma conta recebe os pagamentos/)).toBeInTheDocument();
    expect(screen.getByText(/valores brutos/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Detalhes do webhook'));
    expect(screen.getByText('hook-central')).toBeVisible();
    expect(screen.getByText(configured.webhook_url)).toBeVisible();
    expect(screen.getByText(/token de autenticação do webhook é gerenciado automaticamente/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Testar integração' }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ action: 'test', environment: 'production', webhook_email: 'finance@example.test' }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Conta central e webhook validados.'));
  });

  it('saves a replacement token with the selected environment and clears it after success', async () => {
    renderCard();
    const tokenInput = await screen.findByLabelText('Token da sua conta Asaas');
    fireEvent.change(tokenInput, { target: { value: 'new-private-token' } });
    fireEvent.change(screen.getByLabelText('E-mail para avisos do Asaas'), { target: { value: 'billing@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar e configurar webhook' }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledWith({ action: 'save', environment: 'production', api_token: 'new-private-token', webhook_email: 'billing@example.test' }));
    await waitFor(() => expect(tokenInput).toHaveValue(''));
  });

  it('keeps validation failures visible instead of showing a connected account', async () => {
    mocks.manage.mockResolvedValue({ ...configured, status: 'error', last_error: 'Webhook com fila interrompida' });
    renderCard();
    await screen.findByText('Webhook com fila interrompida');
    expect(screen.queryByText('Conta central conectada')).not.toBeInTheDocument();
    expect(screen.getByText('Configuração pendente')).toBeInTheDocument();
  });

  it('reports configuration lookup failures and offers retry without a financial or connection success state', async () => {
    mocks.manage.mockRejectedValue(new Error('Falha de consulta offline'));
    renderCard();
    await screen.findByText('Falha de consulta offline');
    expect(screen.queryByText('Conta central conectada')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });
});
