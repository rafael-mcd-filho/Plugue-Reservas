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
import AdminRepasses from './AdminRepasses';

const mock = vi.hoisted(() => ({
  overview: vi.fn(),
  terms: vi.fn(),
  transition: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));
vi.mock('@/lib/reservation-settlements-api', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/reservation-settlements-api')
  >()),
  getAdminSettlementOverview: mock.overview,
  saveSettlementTerms: mock.terms,
  transitionWithdrawal: mock.transition,
  uploadWithdrawalReceipt: mock.upload,
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
const company = {
  id: 'company-a',
  name: 'Casa Exemplo',
  company_id: 'company-a',
  terms: {
    id: 'term-a',
    fee_bps: 1000,
    release_policy: 'after_reservation',
    hold_days: 0,
    enabled: true,
  },
  available_cents: 130000,
  pending_cents: 0,
  blocked_cents: 0,
  reserved_cents: 50000,
  paid_cents: 0,
  fee_cents: 20000,
  provider_cost_cents: 6000,
  gross_cents: 200000,
  refunded_cents: 0,
  merchant_net_cents: 180000,
};
const withdrawal = {
  id: 'withdrawal-a',
  company_id: 'company-a',
  company_name: 'Casa Exemplo',
  amount_cents: 50000,
  status: 'processing',
  destination_snapshot: destination,
  created_at: '2026-11-01T14:00:00Z',
  receipt_path: null,
};
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminRepasses />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mock.overview.mockResolvedValue({
    companies: [company],
    withdrawals: [withdrawal],
    total: 1,
    company_count: 1,
    company_offset: 0,
    company_limit: 25,
  });
  mock.upload.mockResolvedValue({
    receipt_path: 'company-a/withdrawal-a/proof.pdf',
  });
  mock.transition.mockResolvedValue({ ...withdrawal, status: 'paid' });
  mock.terms.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminRepasses', () => {
  it('opens on pending requests and lists each request only once', async () => {
    mock.overview.mockResolvedValue({
      companies: [company],
      withdrawals: [{ ...withdrawal, status: 'requested' }],
      total: 1,
      company_count: 1,
    });
    renderPage();
    expect(await screen.findAllByRole('button', { name: 'Analisar' })).toHaveLength(1);
    const statuses = mock.overview.mock.calls.map((call) => call[0]);
    expect(statuses).toEqual(expect.arrayContaining(['requested', 'under_review']));
    expect(screen.getByRole('button', { name: 'Pendentes' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('shows a query failure instead of an empty queue', async () => {
    mock.overview.mockRejectedValue(new Error('Serviço indisponível'));
    renderPage();
    expect(await screen.findByText('Não foi possível consultar os pedidos de saque')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum pedido aguardando análise')).not.toBeInTheDocument();
  });
  it('requires proof, transfer reference and date before recording a payment', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar pagamento' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Registrar pagamento realizado' }),
    );
    expect(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Referência da transferência'), {
      target: { value: 'E123456789' },
    });
    expect(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Comprovante do pagamento'), {
      target: {
        files: [
          new File(['%PDF-1.7 proof'], 'proof.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    );
    await waitFor(() =>
      expect(mock.upload).toHaveBeenCalledWith(
        'withdrawal-a',
        expect.any(File),
      ),
    );
    await waitFor(() =>
      expect(mock.transition).toHaveBeenCalledWith(
        'withdrawal-a',
        'paid',
        expect.objectContaining({
          receipt_path: 'company-a/withdrawal-a/proof.pdf',
          bank_reference: 'E123456789',
          paid_at: expect.any(String),
        }),
      ),
    );
    expect(mock.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mock.transition.mock.invocationCallOrder[0],
    );
  });
  it('preserves processing status if the proof upload fails', async () => {
    mock.upload.mockRejectedValue(new Error('Falha no anexo'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar pagamento' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Registrar pagamento realizado' }),
    );
    fireEvent.change(screen.getByLabelText('Referência da transferência'), {
      target: { value: 'E123' },
    });
    fireEvent.change(screen.getByLabelText('Comprovante do pagamento'), {
      target: {
        files: [new File(['%PDF'], 'proof.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    );
    expect(await screen.findByText('Falha no anexo')).toBeInTheDocument();
    expect(mock.transition).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Recusar pedido' }),
    ).not.toBeInTheDocument();
  });
  it('does not accept unsupported proof files or a payment before request creation', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar pagamento' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Registrar pagamento realizado' }),
    );
    fireEvent.change(screen.getByLabelText('Referência da transferência'), {
      target: { value: 'E123' },
    });
    fireEvent.change(screen.getByLabelText('Comprovante do pagamento'), {
      target: {
        files: [new File(['bad'], 'proof.html', { type: 'text/html' })],
      },
    });
    expect(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Comprovante do pagamento'), {
      target: {
        files: [new File(['%PDF'], 'proof.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.change(screen.getByLabelText('Data e hora do pagamento'), {
      target: { value: '2026-10-01T14:00:00' },
    });
    expect(
      screen.getByRole('button', { name: 'Confirmar pagamento' }),
    ).toBeDisabled();
    expect(mock.transition).not.toHaveBeenCalled();
  });
  it('loads the legacy rate for both methods and saves distinct rates with immediate effectiveness', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(
      dialog.getByText(/tarifas do Asaas saem da parte da plataforma/),
    ).toBeInTheDocument();
    expect(dialog.getByLabelText('Taxa Pix (%)')).toHaveValue('10');
    expect(dialog.getByLabelText('Taxa cartão de crédito (%)')).toHaveValue('10');
    fireEvent.change(dialog.getByLabelText('Taxa Pix (%)'), {
      target: { value: '2,50' },
    });
    fireEvent.change(dialog.getByLabelText('Taxa cartão de crédito (%)'), {
      target: { value: '12,50' },
    });
    expect(dialog.getByText(/1\.950,00/)).toBeInTheDocument();
    expect(dialog.getByText(/1\.750,00/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Salvar condições' }));
    await waitFor(() =>
      expect(mock.terms).toHaveBeenCalledWith(
        expect.objectContaining({
          company_id: 'company-a',
          pix_fee_bps: 250,
          credit_card_fee_bps: 1250,
          effective_at: null,
          release_policy: 'after_reservation',
          enabled: true,
        }),
      ),
    );
    expect(mock.terms.mock.calls[0][0]).not.toHaveProperty('fee_bps');
  });
  it('preserves separate saved rates including zero and requires valid percentages for both methods', async () => {
    mock.overview.mockResolvedValue({
      companies: [{ ...company, terms: { ...company.terms, pix_fee_bps: 0, credit_card_fee_bps: 10000 } }],
      withdrawals: [], total: 0, company_count: 1,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar' }));
    const dialog = within(screen.getByRole('dialog'));
    const pixInput = dialog.getByLabelText('Taxa Pix (%)');
    const cardInput = dialog.getByLabelText('Taxa cartão de crédito (%)');
    const save = dialog.getByRole('button', { name: 'Salvar condições' });
    expect(pixInput).toHaveValue('0');
    expect(cardInput).toHaveValue('100');
    for (const value of ['', '-1', '100,01', '1e2', '1,001']) {
      fireEvent.change(pixInput, { target: { value } });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(mock.terms).not.toHaveBeenCalled();
    }
    fireEvent.change(pixInput, { target: { value: '0,00' } });
    fireEvent.change(cardInput, { target: { value: '101' } });
    expect(save).toBeDisabled();
    fireEvent.change(cardInput, { target: { value: '100' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mock.terms).toHaveBeenCalledWith(expect.objectContaining({ pix_fee_bps: 0, credit_card_fee_bps: 10000 })));
  });
  it('requires a rejection reason and never offers paid directly for a requested withdrawal', async () => {
    mock.overview.mockResolvedValue({
      companies: [company],
      withdrawals: [{ ...withdrawal, status: 'requested' }],
      total: 1,
      company_count: 1,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Analisar' }));
    expect(
      screen.queryByRole('button', { name: 'Registrar pagamento realizado' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recusar pedido' }));
    expect(
      screen.getByRole('button', { name: 'Confirmar recusa' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Motivo da recusa'), {
      target: { value: 'Titular divergente' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar recusa' }));
    await waitFor(() =>
      expect(mock.transition).toHaveBeenCalledWith('withdrawal-a', 'rejected', {
        reason: 'Titular divergente',
      }),
    );
  });
});
