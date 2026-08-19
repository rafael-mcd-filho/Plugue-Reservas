/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvoicePixDialog from '@/components/billing/InvoicePixDialog';
import { CompanyBillingPixRequestError } from '@/lib/company-billing-pix-client';
import type {
  CompanyBillingInvoice,
  CompanyBillingInvoicePixQrCode,
} from '@/lib/platform-billing-contracts';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

const invoice: CompanyBillingInvoice = {
  id: 'invoice-1',
  companyId: 'company-1',
  asaasPaymentId: 'payment-1',
  asaasCustomerId: 'customer-1',
  asaasSubscriptionId: null,
  description: 'Mensalidade',
  status: 'PENDING',
  value: 149.9,
  dueDate: '2026-08-20',
  paymentDate: null,
  billingType: 'PIX',
  invoiceUrl: null,
  bankSlipUrl: null,
  externalReference: null,
  asaasCreatedAt: null,
  lastSyncedAt: '2026-08-17T12:00:00.000Z',
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:00:00.000Z',
};

function pixData(expirationDate: string): CompanyBillingInvoicePixQrCode {
  return {
    invoiceId: invoice.id,
    asaasPaymentId: invoice.asaasPaymentId,
    value: invoice.value,
    dueDate: invoice.dueDate!,
    encodedImage: 'A'.repeat(64),
    payload: '00020101021226850014br.gov.bcb.pix',
    expirationDate,
  };
}

describe('InvoicePixDialog announcements', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('uses one persistent live region and does not announce the countdown every second', async () => {
    const error = new CompanyBillingPixRequestError(
      'Muitas tentativas de Pix.',
      NOW + 3_000,
    );
    render(
      <InvoicePixDialog
        invoice={invoice}
        pixData={null}
        error={error}
        isLoading={false}
        open
        onOpenChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    await act(async () => Promise.resolve());

    const liveRegions = screen.getAllByRole('status');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute('aria-live', 'polite');
    expect(liveRegions[0]).toHaveAttribute('aria-atomic', 'true');
    expect(liveRegions[0].textContent).toContain('Não foi possível gerar o Pix');
    expect(screen.getByText('Nova tentativa disponível em 3s.')).not.toHaveAttribute('aria-live');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_001);
    });
    expect(liveRegions[0].textContent).toBe('Nova tentativa disponível.');
  });

  it('removes an expired QR from the DOM and announces the expiration', async () => {
    render(
      <InvoicePixDialog
        invoice={invoice}
        pixData={pixData(new Date(NOW + 2_000).toISOString())}
        error={null}
        isLoading={false}
        open
        onOpenChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    await act(async () => Promise.resolve());

    expect(screen.getByRole('img', { name: /QR Code Pix/ })).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_001);
    });
    expect(screen.queryByRole('img', { name: /QR Code Pix/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Este código Pix expirou');
  });
});
