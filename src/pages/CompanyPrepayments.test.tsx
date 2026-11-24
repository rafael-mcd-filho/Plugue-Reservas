import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyPrepayments from '@/pages/CompanyPrepayments';

const mock = vi.hoisted(() => ({ payments: vi.fn(), usage: vi.fn(), config: vi.fn(), check: vi.fn(), refund: vi.fn(), download: vi.fn(), from: vi.fn(), rpc: vi.fn(), toastError: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mock.from, rpc: mock.rpc } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: mock.toastError } }));
vi.mock('@/contexts/CompanySlugContext', () => ({ useCompanySlug: () => ({ companyId: 'company-a', slug: 'casa' }) }));
vi.mock('@/hooks/useCompanyFeatures', () => ({ useCompanyFeatureFlags: () => ({ data: { features: { reservation_prepayment: true } }, isLoading: false }) }));
vi.mock('@/lib/asaas-prepayment-api', () => ({
  getAsaasConfig: mock.config, checkReservationPayment: mock.check, refundReservationPayment: mock.refund,
}));
vi.mock('@/lib/asaas-prepayment-queries', () => ({ fetchCompanyReservationPayments: mock.payments, fetchCompanyReservationPaymentUsage: mock.usage }));
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
  mock.usage.mockResolvedValue([]);
  mock.rpc.mockResolvedValue({ data: [], error: null });
  mock.download.mockResolvedValue(undefined);
  mock.check.mockResolvedValue({ status: 'paid' });
  mock.refund.mockResolvedValue({ status: 'refund_pending' });
});
afterEach(() => cleanup());

describe('CompanyPrepayments section pricing', () => {
  async function openRuleDialog() {
    openTab('Regras');
    fireEvent.click(screen.getByRole('button', { name: 'Nova regra' }));
    return screen.getByRole('dialog', { name: 'Nova regra de antecipação' });
  }

  function mockSections() {
    mock.rpc.mockImplementation(async (name: string) => ({
      data: name === 'list_reservation_pricing_sections'
        ? [{ id: 'section-hall', name: 'Salão' }, { id: 'section-balcony', name: 'Sacada' }]
        : null,
      error: null,
    }));
  }

  it('creates one inactive rule with independently priced environments in an atomic call', async () => {
    mockSections();
    renderPage();
    const dialog = await openRuleDialog();
    fireEvent.change(within(dialog).getByLabelText('Nome da regra'), { target: { value: 'Réveillon' } });
    fireEvent.change(within(dialog).getByLabelText('Início'), { target: { value: '2027-12-31' } });
    fireEvent.change(within(dialog).getByLabelText('Fim'), { target: { value: '2027-12-31' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Por ambiente' }));
    fireEvent.click(await within(dialog).findByRole('switch', { name: 'Oferecer Salão' }));
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Oferecer Sacada' }));
    fireEvent.change(within(dialog).getByLabelText('Nome exibido para Salão'), { target: { value: 'Reserva normal' } });
    fireEvent.change(within(dialog).getByLabelText('Sinal em Salão'), { target: { value: '50,00' } });
    fireEvent.change(within(dialog).getByLabelText('Pix em Salão'), { target: { value: '50,00' } });
    fireEvent.change(within(dialog).getByLabelText('Cartão em Salão'), { target: { value: '55,00' } });
    fireEvent.change(within(dialog).getByLabelText('Nome exibido para Sacada'), { target: { value: 'Sacada Premium' } });
    fireEvent.change(within(dialog).getByLabelText('Sinal em Sacada'), { target: { value: '100,00' } });
    fireEvent.change(within(dialog).getByLabelText('Pix em Sacada'), { target: { value: '100,00' } });
    fireEvent.change(within(dialog).getByLabelText('Cartão em Sacada'), { target: { value: '110,00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar regra' }));
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledWith('create_reservation_payment_rule', {
      _rule: expect.objectContaining({ name: 'Réveillon', pricing_mode: 'by_section', amount_type: 'per_person', enabled: false, base_amount: 50 }),
      _sections: [
        expect.objectContaining({ section_id: 'section-hall', public_name: 'Reserva normal', base_amount: 50, pix_amount: 50, credit_card_amount: 55, enabled: true }),
        expect.objectContaining({ section_id: 'section-balcony', public_name: 'Sacada Premium', base_amount: 100, pix_amount: 100, credit_card_amount: 110, enabled: true }),
      ],
    }));
    expect(mock.rpc).toHaveBeenCalledWith('list_reservation_pricing_sections', {
      _company_id: 'company-a', _date_start: '2027-12-31', _date_end: '2027-12-31',
    });
  });

  it('requires an enabled environment and positive method prices before saving', async () => {
    mockSections();
    renderPage();
    const dialog = await openRuleDialog();
    fireEvent.change(within(dialog).getByLabelText('Nome da regra'), { target: { value: 'Dia especial' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Por ambiente' }));
    await within(dialog).findByRole('switch', { name: 'Oferecer Sacada' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar regra' }));
    expect(mock.toastError).toHaveBeenCalledWith('Selecione pelo menos um ambiente para oferecer ao cliente.');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Oferecer Sacada' }));
    fireEvent.change(within(dialog).getByLabelText('Pix em Sacada'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar regra' }));
    expect(mock.toastError).toHaveBeenCalledWith('Informe valores maiores que zero em todos os ambientes e formas de pagamento habilitadas.');
    expect(mock.rpc.mock.calls.some(([name]) => name === 'create_reservation_payment_rule')).toBe(false);
  });

  it('explains when the period has no environments enabled in availability', async () => {
    renderPage();
    const dialog = await openRuleDialog();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Por ambiente' }));
    expect(await within(dialog).findByText(/Nenhum ambiente está habilitado para escolha neste período/)).toBeInTheDocument();
  });

  it('keeps legacy rule listing available when only the new sections relation is missing', async () => {
    const select = vi.fn((columns: string) => ({ eq: () => ({ order: async () => columns === '*'
      ? { data: [], error: null }
      : { data: null, error: { code: 'PGRST200', message: "Could not find relationship for reservation_payment_rule_sections" } } }) }));
    mock.from.mockReturnValue({ select });
    renderPage();
    openTab('Regras');
    expect(await screen.findByText('Nenhuma regra ativa')).toBeInTheDocument();
    expect(select).toHaveBeenCalledWith('*');
    expect(screen.queryByText(/Não foi possível carregar as regras/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nova regra' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Por ambiente' }));
    expect(within(dialog).getByText('Valores por ambiente ainda não disponíveis')).toBeInTheDocument();
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('radio', { name: 'Valor único' })).toBeEnabled();
  });

  it('does not hide unrelated relation or permission failures with the legacy fallback', async () => {
    const select = vi.fn(() => ({ eq: () => ({ order: async () => ({ data: null, error: { code: 'PGRST200', message: 'Relationship other_missing_relation not found' } }) }) }));
    mock.from.mockReturnValue({ select });
    renderPage();
    openTab('Regras');
    expect(await screen.findByText(/Não foi possível carregar as regras/)).toBeInTheDocument();
    expect(select).not.toHaveBeenCalledWith('*');
  });

  it('preserves environment names and prices when cloning a rule', async () => {
    mockSections();
    mock.from.mockReturnValue({ select: () => ({ eq: () => ({ order: async () => ({ data: [{
      id: 'rule-special', name: 'Evento', enabled: false, pricing_mode: 'by_section',
      date_start: '2027-12-31', date_end: '2027-12-31', amount_type: 'per_person', base_amount: 100,
      pix_enabled: true, pix_amount: 100, credit_card_enabled: true, credit_card_amount: 110,
      payment_deadline_minutes: 10,
      sections: [{ id: 'option-balcony', section_id: 'section-balcony', public_name: 'Sacada Premium', description: 'Vista para o palco', base_amount: 100, pix_amount: 100, credit_card_amount: 110, enabled: true, sort_order: 0, section: { name: 'Sacada' } }],
    }], error: null }) }) }) });
    renderPage();
    openTab('Regras');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Desativadas 1/ }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Sacada Premium')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clonar' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Nome da regra')).toHaveValue('Evento cópia');
    expect(within(dialog).getByRole('radio', { name: 'Por ambiente' })).toBeChecked();
    expect(await within(dialog).findByLabelText('Nome exibido para Sacada')).toHaveValue('Sacada Premium');
    expect(within(dialog).getByLabelText('Cartão em Sacada')).toHaveValue('110,00');
  });
});

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
    expect(insert.mock.calls[0][0]).not.toHaveProperty('pricing_mode');
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
