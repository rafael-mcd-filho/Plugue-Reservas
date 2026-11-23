import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrepaymentBalanceDashboard from './PrepaymentBalanceDashboard';

const mock = vi.hoisted(() => ({ overview: vi.fn(), roles: ['admin'], session: null as unknown }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ roles: mock.roles, loading: false, user: {id:'platform-owner'} }) }));
vi.mock('@/lib/impersonationSession', async original => ({ ...await original<typeof import('@/lib/impersonationSession')>(), getImpersonationSession: () => mock.session }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/reservation-settlements-api', async original => ({
  ...await original<typeof import('@/lib/reservation-settlements-api')>(), getSettlementOverview: mock.overview,
}));

const overview = {
  company_id: 'company-a', terms: { fee_bps: 1000, enabled: true, release_policy: 'after_reservation', hold_days: 0 },
  gross_cents: 200000, fee_cents: 20000, refunded_cents: 0, chargeback_cents: 0,
  merchant_net_cents: 180000, paid_cents: 50000, reserved_cents: 20000, pending_cents: 10000,
  blocked_cents: 0, available_cents: 100000, provider_cost_cents: 6000,
};

function setup(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const open = vi.fn();
  const element = <QueryClientProvider client={client}><PrepaymentBalanceDashboard companyId="company-a" onOpenWithdrawals={open} /></QueryClientProvider>;
  const result = render(element);
  return { client, open, ...result, element };
}
beforeEach(() => { vi.clearAllMocks(); mock.roles = ['admin']; mock.session = null; mock.overview.mockResolvedValue(overview); });
afterEach(cleanup);

describe('PrepaymentBalanceDashboard', () => {
  it('uses accumulated server balances and does not deduct the Asaas fee again', async () => {
    mock.overview.mockResolvedValue({ ...overview, terms: { ...overview.terms, pix_fee_bps: 0, credit_card_fee_bps: 1250 } });
    const { client } = setup();
    expect(await screen.findByTestId('available-balance')).toHaveTextContent(/1\.000,00/);
    const dashboard = screen.getByRole('region', { name: 'Saldo acumulado' });
    expect(within(dashboard).getByText('Total confirmado')).toBeInTheDocument();
    expect(within(within(dashboard).getByText('Total confirmado').parentElement!).getByText(/2\.000,00/)).toBeInTheDocument();
    expect(within(within(dashboard).getByText('Líquido da empresa').parentElement!).getByText(/1\.800,00/)).toBeInTheDocument();
    expect(within(dashboard).getByText('Independente do período')).toBeInTheDocument();
    expect(within(dashboard).getByText('Pix 0% · Cartão 12,5%')).toBeInTheDocument();
    expect(within(dashboard).queryByText(/940,00/)).not.toBeInTheDocument();
    expect(client.getQueryCache().getAll()[0].queryKey).toEqual(['reservation-settlements', 'company-a', 0]);
    expect(mock.overview).toHaveBeenCalledWith('company-a');
  });

  it('opens the withdrawal workflow without changing the accumulated balance', async () => {
    const { open } = setup();
    await screen.findByTestId('available-balance');
    fireEvent.click(screen.getByRole('button', { name: 'Gerenciar saques' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByTestId('available-balance')).toHaveTextContent(/1\.000,00/);
  });

  it('never turns a query error into a zero balance and supports retry', async () => {
    mock.overview.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(overview);
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('valores acumulados estão indisponíveis');
    expect(screen.queryByTestId('available-balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*0,00/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar saldo' }));
    await screen.findByTestId('available-balance');
    expect(mock.overview).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete financial data instead of rendering NaN or a guessed balance', async () => {
    mock.overview.mockResolvedValue({ ...overview, available_cents: null });
    setup();
    await screen.findByRole('alert');
    expect(screen.queryByTestId('available-balance')).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('shows no cached money and makes no request in a support impersonation session', async () => {
    const client = new QueryClient();
    client.setQueryData(['reservation-settlements', 'company-a', 0], overview);
    mock.roles = ['support']; mock.session = { effectiveRole: 'admin' };
    setup(client);
    expect(screen.getByText(/Entre com o administrador da empresa/)).toBeInTheDocument();
    expect(screen.queryByTestId('available-balance')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.overview).not.toHaveBeenCalled());
  });

  it('allows a superadmin impersonating this company administrator and responds to session activation', async () => {
    mock.roles=['superadmin'];
    mock.session={actorUserId:'platform-owner',companyId:'company-a',effectiveRole:'admin',status:'pending'};
    setup();
    expect(screen.getByRole('status')).toHaveTextContent('Consultando saldo');
    expect(mock.overview).not.toHaveBeenCalled();
    act(()=>{ mock.session={...(mock.session as object),status:'active'}; window.dispatchEvent(new Event('superadmin-impersonation-change')); });
    expect(await screen.findByTestId('available-balance')).toHaveTextContent(/1\.000,00/);
    expect(screen.queryByText(/Entre com o administrador da empresa/)).not.toBeInTheDocument();
  });
});
