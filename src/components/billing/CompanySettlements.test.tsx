import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanySettlements, {
  CompanySettlementBalance,
} from './CompanySettlements';

const mock = vi.hoisted(() => ({
  overview: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
  destination: vi.fn(),
  download: vi.fn(),
  roles: ['admin'],
  session: null as unknown,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ roles: mock.roles, user: {id:'platform-owner'}, loading:false }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));
vi.mock('@/lib/impersonationSession', async original => ({
  ...await original<typeof import('@/lib/impersonationSession')>(),
  getImpersonationSession: () => mock.session,
}));
vi.mock('@/lib/reservation-settlements-api', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/reservation-settlements-api')
  >()),
  getSettlementOverview: mock.overview,
  requestWithdrawal: mock.request,
  cancelWithdrawal: mock.cancel,
  savePayoutDestination: mock.destination,
  downloadWithdrawalReceipt: mock.download,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const destination = {
  kind: 'pix',
  holder_name: 'Casa Exemplo Ltda',
  holder_document: '12345678000195',
  pix_key_type: 'email',
  pix_key: 'financeiro@exemplo.com',
};
const baseOverview = {
  company_id: 'company-a',
  terms: {
    id: 'term-a',
    fee_bps: 1000,
    release_policy: 'after_reservation',
    hold_days: 0,
    enabled: true,
  },
  pending_cents: 0,
  available_cents: 180000,
  blocked_cents: 0,
  reserved_cents: 0,
  paid_cents: 0,
  gross_cents: 200000,
  fee_cents: 20000,
  provider_cost_cents: 6000,
  refunded_cents: 0,
  chargeback_cents: 0,
  merchant_net_cents: 180000,
  destination,
  withdrawals: [],
  ledger: [],
  withdrawal_count: 0,
  ledger_count: 0,
};
const withdrawal = {
  id: 'withdrawal-a',
  company_id: 'company-a',
  amount_cents: 50000,
  status: 'requested',
  destination_snapshot: destination,
  created_at: '2026-11-08T14:00:00Z',
  receipt_path: null,
};
function renderPanel(balanceOnly = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      {balanceOnly ? (
        <CompanySettlementBalance companyId="company-a" />
      ) : (
        <CompanySettlements companyId="company-a" />
      )}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.roles = ['admin'];
  mock.session = null;
  mock.overview.mockResolvedValue(baseOverview);
  mock.request.mockResolvedValue(withdrawal);
  mock.cancel.mockResolvedValue({ ...withdrawal, status: 'cancelled' });
});
afterEach(cleanup);

describe('CompanySettlements', () => {
  it('shows server availability and the contracted rate without deducting Asaas cost again', async () => {
    mock.overview.mockResolvedValue({ ...baseOverview, terms: { ...baseOverview.terms, pix_fee_bps: 200, credit_card_fee_bps: 1000 } });
    renderPanel(true);
    expect((await screen.findAllByText(/1\.800,00/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Intermediação: Pix 2% · Cartão 10%')).toBeInTheDocument();
    expect(
      screen.getByText(/tarifas de processamento estão incluídas/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/1\.740,00/)).not.toBeInTheDocument();
  });
  it('does not display a fictitious zero balance or enable a withdrawal when the balance query fails', async () => {
    mock.overview.mockRejectedValue(new Error('Conciliação indisponível'));
    renderPanel();
    expect(await screen.findByText('Saldo indisponível')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Solicitar saque' }),
    ).toBeDisabled();
    expect(screen.queryByText(/R\$\s*0,00/)).not.toBeInTheDocument();
  });
  it('rejects overspending and fractional cents before a request and requires explicit confirmation', async () => {
    renderPanel();
    await screen.findByText('Intermediação: Pix 10% · Cartão 10%');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar saque' }));
    fireEvent.change(screen.getByLabelText('Valor do saque (R$)'), {
      target: { value: '1800,01' },
    });
    expect(
      screen.getByRole('button', { name: 'Conferir pedido' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Valor do saque (R$)'), {
      target: { value: '1,001' },
    });
    expect(
      screen.getByRole('button', { name: 'Conferir pedido' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Valor do saque (R$)'), {
      target: { value: '500,00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir pedido' }));
    expect(mock.request).not.toHaveBeenCalled();
    expect(screen.getByText('Confirmar pedido de saque')).toBeInTheDocument();
    expect(
      within(screen.getByRole('dialog')).getByText('financeiro@exemplo.com', {
        exact: false,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar solicitação' }),
    );
    await waitFor(() =>
      expect(mock.request).toHaveBeenCalledWith(
        'company-a',
        50000,
        expect.any(String),
      ),
    );
  });
  it('keeps the same idempotency key when a request response fails and the user retries', async () => {
    mock.request
      .mockRejectedValueOnce(new Error('Resposta indisponível'))
      .mockResolvedValueOnce(withdrawal);
    renderPanel();
    await screen.findByText('Intermediação: Pix 10% · Cartão 10%');
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar saque' }));
    fireEvent.change(screen.getByLabelText('Valor do saque (R$)'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir pedido' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar solicitação' }),
    );
    expect(
      await screen.findByText('Resposta indisponível'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar solicitação' }),
    );
    await waitFor(() => expect(mock.request).toHaveBeenCalledTimes(2));
    expect(mock.request.mock.calls[0][2]).toEqual(
      mock.request.mock.calls[1][2],
    );
  });
  it('does not query or expose private payout data during support impersonation', async () => {
    mock.roles = ['support'];
    mock.session = { effectiveRole: 'admin' };
    renderPanel();
    expect(screen.getByText('Acesso aos saques')).toBeInTheDocument();
    expect(mock.overview).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Solicitar saque' })).not.toBeInTheDocument();
    expect(screen.queryByText('financeiro@exemplo.com', { exact: false })).not.toBeInTheDocument();
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('permits the real superadmin to request a withdrawal while impersonating this company admin', async () => {
    mock.roles=['superadmin'];
    mock.session={actorUserId:'platform-owner',companyId:'company-a',effectiveRole:'admin',status:'active'};
    renderPanel();
    await screen.findByText('Intermediação: Pix 10% · Cartão 10%');
    expect(screen.getByRole('button',{name:'Solicitar saque'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Alterar destino'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Solicitar saque'}));
    expect(screen.getByRole('dialog',{name:'Solicitar saque'})).toBeInTheDocument();
  });
  it('only offers cancellation before payment begins and requires a confirmation', async () => {
    mock.overview.mockResolvedValue({
      ...baseOverview,
      withdrawals: [
        withdrawal,
        { ...withdrawal, id: 'processing-b', status: 'processing' },
      ],
      withdrawal_count: 2,
    });
    renderPanel();
    await screen.findByText('Intermediação: Pix 10% · Cartão 10%');
    expect(
      screen.getAllByRole('button', { name: 'Cancelar pedido' }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }));
    expect(mock.cancel).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar cancelamento' }),
    );
    await waitFor(() =>
      expect(mock.cancel).toHaveBeenCalledWith('company-a', 'withdrawal-a'),
    );
  });
  it('submits the payout destination separately without altering an existing withdrawal', async () => {
    mock.destination.mockResolvedValue(destination);
    renderPanel();
    await screen.findByText('Intermediação: Pix 10% · Cartão 10%');
    fireEvent.click(screen.getByRole('button', { name: 'Alterar destino' }));
    fireEvent.change(screen.getByLabelText('Chave Pix'), {
      target: { value: 'novo@exemplo.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar destino' }));
    await waitFor(() =>
      expect(mock.destination).toHaveBeenCalledWith(
        'company-a',
        expect.objectContaining({ pix_key: 'novo@exemplo.com' }),
      ),
    );
    expect(mock.request).not.toHaveBeenCalled();
  });
});
