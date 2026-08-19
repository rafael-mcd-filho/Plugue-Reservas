import { describe, expect, it } from 'vitest';
import type { CompanyBillingInvoice } from '@/lib/platform-billing-contracts';
import {
  canGenerateBillingInvoicePix,
  sortBillingInvoicesByNewestDueDate,
} from '@/lib/company-billing-invoices';

function invoice(
  id: string,
  dueDate: string | null,
  asaasCreatedAt = '2026-08-01T12:00:00.000Z',
): CompanyBillingInvoice {
  return {
    id,
    companyId: 'company-1',
    asaasPaymentId: `payment-${id}`,
    asaasCustomerId: 'customer-1',
    asaasSubscriptionId: null,
    description: `Fatura ${id}`,
    status: 'PENDING',
    value: 100,
    dueDate,
    paymentDate: null,
    billingType: 'PIX',
    invoiceUrl: null,
    bankSlipUrl: null,
    externalReference: null,
    asaasCreatedAt,
    lastSyncedAt: '2026-08-17T12:00:00.000Z',
    createdAt: asaasCreatedAt,
    updatedAt: asaasCreatedAt,
  };
}

describe('sortBillingInvoicesByNewestDueDate', () => {
  it('places the most recent due date first and leaves missing dates last', () => {
    const source = [
      invoice('oldest', '2026-06-10'),
      invoice('missing', null),
      invoice('newest', '2026-08-10'),
      invoice('middle', '2026-07-10'),
    ];

    expect(sortBillingInvoicesByNewestDueDate(source).map(({ id }) => id)).toEqual([
      'newest',
      'middle',
      'oldest',
      'missing',
    ]);
    expect(source.map(({ id }) => id)).toEqual(['oldest', 'missing', 'newest', 'middle']);
  });

  it('uses the most recent creation date as a stable tie-breaker', () => {
    const source = [
      invoice('created-first', '2026-08-10', '2026-08-01T12:00:00.000Z'),
      invoice('created-last', '2026-08-10', '2026-08-15T12:00:00.000Z'),
    ];

    expect(sortBillingInvoicesByNewestDueDate(source).map(({ id }) => id)).toEqual([
      'created-last',
      'created-first',
    ]);
  });
});

describe('canGenerateBillingInvoicePix', () => {
  const payableStatuses = ['PENDING', 'OVERDUE'];
  const compatibleBillingTypes = ['PIX', 'BOLETO', 'UNDEFINED'];
  const unavailableStatuses = [
    'RECEIVED',
    'CONFIRMED',
    'RECEIVED_IN_CASH',
    'REFUNDED',
    'REFUND_REQUESTED',
    'REFUND_IN_PROGRESS',
    'CHARGEBACK_REQUESTED',
    'CHARGEBACK_DISPUTE',
    'AWAITING_CHARGEBACK_REVERSAL',
    'DUNNING_REQUESTED',
    'DUNNING_RECEIVED',
    'AWAITING_RISK_ANALYSIS',
    'DELETED',
    '',
  ];

  it.each(
    payableStatuses.flatMap((status) => (
      compatibleBillingTypes.map((billingType) => [status, billingType])
    )),
  )('allows %s invoices with billing type %s', (status, billingType) => {
    expect(canGenerateBillingInvoicePix({ status, billingType })).toBe(true);
  });

  it.each(
    unavailableStatuses.flatMap((status) => (
      compatibleBillingTypes.map((billingType) => [status, billingType])
    )),
  )('rejects status %s even with billing type %s', (status, billingType) => {
    expect(canGenerateBillingInvoicePix({ status, billingType })).toBe(false);
  });

  it.each([
    ['CREDIT_CARD'],
    ['DEBIT_CARD'],
    ['TRANSFER'],
    [''],
    [null],
  ])('rejects incompatible billing type %s for an open invoice', (billingType) => {
    expect(canGenerateBillingInvoicePix({ status: 'PENDING', billingType })).toBe(false);
  });

  it('normalizes provider casing and surrounding spaces', () => {
    expect(canGenerateBillingInvoicePix({ status: ' overdue ', billingType: ' pix ' })).toBe(true);
  });
});
