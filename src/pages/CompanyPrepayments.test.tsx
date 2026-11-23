import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyPrepayments from '@/pages/CompanyPrepayments';

const mock = vi.hoisted(() => ({ payments: vi.fn(), config: vi.fn(), check: vi.fn(), refund: vi.fn(), download: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mock.from } }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'company-a', slug: 'casa' }) }));
vi.mock('@/hooks/useCompanyFeatures', () => ({ useCompanyFeatureFlags: () => ({ data: { features: { reservation_prepayment: true } }, isLoading: false }) }));
vi.mock('@/lib/asaas-prepayment-api', () => ({
  getAsaasConfig: mock.config, checkReservationPayment: mock.check, refundReservationPayment: mock.refund,
}));
vi.mock('@/lib/asaas-prepayment-queries', () => ({ fetchCompanyReservationPayments: mock.payments, fetchCompanyReservationPaymentUsage: vi.fn() }));
vi.mock('@/lib/export-utils', () => ({ downloadSpreadsheet: mock.download }));
vi.mock('@/components/billing/CompanySettlements', () => ({ default: () => <div>Fluxo de saques</div>, CompanySettlementBalance: () => <div>Saldo calculado no servidor</div> }));
vi.mock('@/components/billing/PrepaymentBalanceDashboard', () => ({ default: ({ companyId, onOpenWithdrawals }: { companyId: string; onOpenWithdrawals: () => void }) => <section aria-label="Saldo acumulado" data-company={companyId}><p>Saldo calculado no servidor</p><button onClick={onOpenWithdrawals}>Solicitar saque</button></section> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: () => <div>Gráfico</div>, Bar: () => null, CartesianGrid: () => null,
  Legend: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));

function payment(status: string, id = 'payment-a') {
  const now = new Date().toISOString();
  return {
    id, reservation_id: `reservation-${id}`, status, billing_type: 'PIX', charged_amount: 100,
    base_amount: 100, asaas_payment_id: `pay_${id}`, asaas_payment_link_id: null,
    payment_link_external_reference: `plugue:company-a:${id}`, payment_token: `token-${id}`,
    created_at: now, paid_at: status === 'paid' ? now : null,
    cancelled_at: status === 'cancelled' ? now : null, expires_at: now,
    reservation: { guest_name: `Cliente ${id}`, status: 'confirmed', date: now.slice(0, 10), time: '19:00', party_size: 2 },
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={queryClient}><CompanyPrepayments /></QueryClientProvider>);
  return queryClient;
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.config.mockResolvedValue({ status: 'configured', managed_by_platform: true, from_company_account: false, last_validated_at: null, last_error: null, has_api_token: true, webhook_auth_token: null, webhook_url: null });
  mock.from.mockReturnValue({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) });
  mock.payments.mockResolvedValue([]);
  mock.download.mockResolvedValue(undefined);
  mock.check.mockResolvedValue({ status: 'paid' });
  mock.refund.mockResolvedValue({ status: 'refund_pending' });
});
afterEach(() => cleanup());

describe('CompanyPrepayments financial reliability', () => {
  it('opens the financial summary with workflows ordered by financial priority without querying integration settings', async () => {
    renderPage();
    const tabs = screen.getAllByRole('tablist')[0];
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Resumo financeiro', 'Pagamentos', 'Saques', 'Regras',
    ]);
    expect(within(tabs).getByRole('tab', { name: 'Resumo financeiro' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Movimentação por período')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Configurações' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recebimentos na conta central')).not.toBeInTheDocument();
    await waitFor(() => expect(mock.from).toHaveBeenCalled());
    expect(mock.config).not.toHaveBeenCalled();
  });

  it('keeps the accumulated balance above date-filtered workflows and opens withdrawals from its shortcut', async () => {
    renderPage();
    const dashboard = screen.getByRole('region', { name: 'Saldo acumulado' });
    const tabs = screen.getByRole('tablist', { name: 'Áreas dos pagamentos' });
    expect(dashboard).toHaveAttribute('data-company', 'company-a');
    expect(dashboard.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dashboard).not.toContainElement(screen.getByText('Movimentação por período'));
    openTab('Pagamentos');
    expect(dashboard).toBeInTheDocument();
    fireEvent.click(within(dashboard).getByRole('button', { name: 'Solicitar saque' }));
    expect(await screen.findByText('Fluxo de saques')).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Saques' })).toHaveAttribute('aria-selected', 'true');
    expect(dashboard).toBeInTheDocument();
  });

  it('keeps rules secondary and opens rule creation in a dialog rather than another tab', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    mock.from.mockReturnValue({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
      insert,
    });
    renderPage();
    expect(screen.queryByRole('button', { name: 'Nova regra' })).not.toBeInTheDocument();
    openTab('Regras');
    await screen.findByText('Nenhuma regra ativa');
    expect(screen.queryByRole('tab', { name: 'Nova regra' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nova regra' }));
    const dialog = screen.getByRole('dialog', { name: 'Nova regra de antecipação' });
    expect(within(dialog).getByLabelText('Nome da regra')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Adicionar regra' })).toBeInTheDocument();
    expect(within(dialog).getByText(/entra desativada/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Parcelas')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Pagamento em parcela única.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Nome da regra'), { target: { value: 'Dia especial' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar regra' }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Dia especial', credit_card_enabled: true, max_credit_card_installments: 1, enabled: false,
    })));
  });

  it('reports a list failure instead of claiming there are no payments and lets the user retry', async () => {
    mock.payments.mockRejectedValue(new Error('Banco indisponível'));
    renderPage();
    openTab('Pagamentos');
    expect(await screen.findByText(/Não foi possível carregar os pagamentos/)).toBeInTheDocument();
    expect(screen.queryByText('Nenhum pagamento encontrado')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar Excel' })).toBeDisabled();
    const callsBefore = mock.payments.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mock.payments.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('hides financial totals on a query failure instead of displaying zero revenue', async () => {
    mock.payments.mockRejectedValue(new Error('Falha na segunda página'));
    renderPage();
    openTab('Resumo financeiro');
    expect(await screen.findByText(/Os totais não estão disponíveis/)).toBeInTheDocument();
    expect(screen.queryByText('Valor bruto confirmado')).not.toBeInTheDocument();
    expect(screen.queryByText('Totais do período')).not.toBeInTheDocument();
  });

  it('shows provider references and exports all filtered rows, beyond the visible page', async () => {
    const timestamp = new Date().toISOString();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...payment('paid', `payment-${index}`), created_at: timestamp, paid_at: timestamp,
    }));
    mock.payments.mockResolvedValue(rows);
    renderPage();
    openTab('Pagamentos');
    expect(await screen.findByText('pay_payment-0')).toBeInTheDocument();
    expect(screen.getByText('plugue:company-a:payment-0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar Excel' }));
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1));
    const exported = mock.download.mock.calls[0][0];
    expect(exported.rows).toHaveLength(10);
    expect(exported.rows[0].slice(0, 6)).toEqual(['company-a', 'payment-0', 'reservation-payment-0', 'pay_payment-0', null, 'plugue:company-a:payment-0']);
    expect(exported.rows.some((row: unknown[]) => row.includes('token-payment-0'))).toBe(false);
  });

  it('includes cancelled amounts and distinguishes the period report from withdrawal availability', async () => {
    mock.payments.mockResolvedValue([payment('cancelled')]);
    renderPage();
    openTab('Resumo financeiro');
    const cancelledLabel = await screen.findByText('Valor cancelado');
    expect(within(cancelledLabel.parentElement!).getByText(/100,00/)).toBeInTheDocument();
    expect(screen.getByText(/não representa o saldo disponível para saque/)).toBeInTheDocument();
  });

  it('shows installment reconciliation warnings and avoids offering a single-installment refund', async () => {
    mock.payments.mockResolvedValue([{ ...payment('paid'), metadata: {
      asaas_installment_id: 'installment-group', needs_manual_installment_reconciliation: true,
    } }]);
    renderPage();
    openTab('Pagamentos');
    expect(await screen.findByText(/A plataforma precisa conferir todas as parcelas e os estornos/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Estornar' })).not.toBeInTheDocument();
  });

  it('withholds totals when a partial refund has no known completed amount', async () => {
    mock.payments.mockResolvedValue([payment('partial_refunded')]);
    renderPage();
    openTab('Resumo financeiro');
    expect(await screen.findByText('Valor de estorno parcial não informado')).toBeInTheDocument();
    expect(screen.queryByText('Valor bruto confirmado')).not.toBeInTheDocument();
  });

  it('keeps status consultation and confirmed refunds available after removing configuration', async () => {
    mock.payments.mockResolvedValue([payment('paid')]);
    renderPage();
    openTab('Pagamentos');
    fireEvent.click(await screen.findByRole('button', { name: 'Consultar' }));
    await waitFor(() => expect(mock.check).toHaveBeenCalledWith('token-payment-a'));
    fireEvent.click(screen.getByRole('button', { name: 'Estornar' }));
    const confirmation = await screen.findByRole('alertdialog');
    expect(mock.refund).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Solicitar estorno' }));
    await waitFor(() => expect(mock.refund).toHaveBeenCalledWith('company-a', 'token-payment-a', {
      description: 'Estorno solicitado no painel para Cliente payment-a',
    }));
    expect(mock.config).not.toHaveBeenCalled();
  });

  it('shows the financial calculation in order and subtracts completed refunds and chargebacks once', async () => {
    mock.payments.mockResolvedValue([
      { ...payment('paid', 'paid'), charged_amount: 120 },
      { ...payment('refunded', 'refunded'), charged_amount: 40 },
      { ...payment('chargeback', 'chargeback'), charged_amount: 30 },
      { ...payment('partial_refunded', 'partial'), metadata: { provider_status_check: { refunded_value: 25 } } },
      { ...payment('refund_pending', 'pending-refund'), charged_amount: 50 },
    ]);
    renderPage();
    openTab('Resumo financeiro');
    const calculation = await screen.findByRole('group', { name: 'Composição do valor confirmado' });
    const cards = Array.from(calculation.children) as HTMLElement[];
    expect(cards.map((card) => card.querySelector('p')?.textContent)).toEqual([
      'Confirmados (bruto)', 'Estornos realizados', 'Chargebacks', 'Após devoluções',
    ]);
    expect(within(cards[0]).getByText(/340,00/)).toBeInTheDocument();
    expect(within(cards[0]).getByText(/5 pagamentos confirmados/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/−.*65,00/)).toBeInTheDocument();
    expect(within(cards[2]).getByText(/−.*30,00/)).toBeInTheDocument();
    expect(within(cards[3]).getByText(/=.*245,00/)).toBeInTheDocument();
    const totals = screen.getByText('Totais do período').closest('.shadow-card')! as HTMLElement;
    const text = totals.textContent!;
    expect(text.indexOf('Valor bruto confirmado')).toBeLessThan(text.indexOf('Menos estornos'));
    expect(text.indexOf('Menos estornos')).toBeLessThan(text.indexOf('Menos chargebacks'));
    expect(text.indexOf('Menos chargebacks')).toBeLessThan(text.indexOf('Após devoluções'));
    expect(text).toContain('Estornos pendentes só são descontados quando concluídos');
  });
});
