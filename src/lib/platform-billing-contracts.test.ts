import { describe, expect, it } from 'vitest';
import {
  PLATFORM_BILLING_DESCRIPTION_MARKER,
  PLATFORM_BILLING_OVERDUE_POPUP_DAYS,
  PLATFORM_BILLING_SYNC_INTERVAL_HOURS,
  isPlatformBillingOpenStatus,
  isPlatformBillingPaidStatus,
  normalizeCompanyBillingOverdueWarning,
  normalizeCompanyBillingInvoice,
  normalizeCompanyBillingLink,
  normalizeCompanyBillingSummary,
  normalizePlatformAsaasConfig,
  toPlatformBillingNumber,
} from '@/lib/platform-billing-contracts';

describe('platform-billing-contracts', () => {
  it('keeps the rollout constants fixed', () => {
    expect(PLATFORM_BILLING_DESCRIPTION_MARKER).toBe('[PLUGUEGUEST]');
    expect(PLATFORM_BILLING_SYNC_INTERVAL_HOURS).toBe(4);
    expect(PLATFORM_BILLING_OVERDUE_POPUP_DAYS).toBe(6);
  });

  it('exposes only masked token metadata to the frontend', () => {
    expect(normalizePlatformAsaasConfig({
      module_enabled: true,
      configured: true,
      environment: 'production',
      token_last_four: '1234',
      token_validated_at: '2026-08-04T12:00:00.000Z',
      token_last_error: null,
      updated_at: '2026-08-04T12:00:00.000Z',
    })).toMatchObject({
      available: true,
      configured: true,
      enabled: true,
      environment: 'production',
      maskedToken: '•••• 1234',
    });
  });

  it('keeps the per-company rollout disabled by default and exposes its revision', () => {
    expect(normalizeCompanyBillingLink({
      company_id: 'company-1',
      asaas_customer_id: 'cus_1',
      billing_enabled: false,
      billing_revision: '11111111-1111-4111-8111-111111111111',
      customer_name: 'Cliente teste',
      customer_cpf_cnpj: null,
      description_marker: '[PLUGUEGUEST]',
      status: 'active',
      last_validated_at: null,
      last_synced_at: null,
      last_sync_error: null,
      created_at: '2026-08-04T12:00:00.000Z',
      updated_at: '2026-08-04T12:00:00.000Z',
    })).toMatchObject({
      companyId: 'company-1',
      billingEnabled: false,
      billingRevision: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('normalizes database numeric values without propagating NaN', () => {
    expect(toPlatformBillingNumber('129.90')).toBe(129.9);
    expect(toPlatformBillingNumber(null)).toBe(0);
    expect(toPlatformBillingNumber('invalid')).toBe(0);
  });

  it('normalizes the summary used by overdue badges and popup', () => {
    const summary = normalizeCompanyBillingSummary({
      module_enabled: true,
      company_billing_enabled: true,
      link_status: 'active',
      has_link: true,
      last_synced_at: '2026-08-04T12:00:00.000Z',
      last_sync_error: null,
      open_count: '3',
      open_amount: '450.50',
      overdue_count: '2',
      overdue_amount: '300.00',
      oldest_overdue_due_date: '2026-07-28',
      oldest_overdue_days: '7',
      show_overdue_popup: true,
      next_due_date: '2026-08-10',
      next_due_amount: '150.50',
    }, 'company-1');

    expect(summary).toMatchObject({
      companyId: 'company-1',
      configured: true,
      companyBillingEnabled: true,
      openCount: 3,
      openTotal: 450.5,
      overdueCount: 2,
      overdueTotal: 300,
      oldestOverdueDays: 7,
      showOverduePopup: true,
      nextDueAmount: 150.5,
    });
  });

  it('normalizes the restricted overdue warning and fails closed', () => {
    expect(normalizeCompanyBillingOverdueWarning({
      billing_enabled: true,
      show_overdue_warning: true,
    }, 'company-1')).toEqual({
      companyId: 'company-1',
      billingEnabled: true,
      showOverdueWarning: true,
    });

    expect(normalizeCompanyBillingOverdueWarning({
      billing_enabled: false,
      show_overdue_warning: true,
    }, 'company-1')).toMatchObject({
      billingEnabled: false,
      showOverdueWarning: false,
    });

    expect(normalizeCompanyBillingOverdueWarning(null, 'company-1')).toMatchObject({
      billingEnabled: false,
      showOverdueWarning: false,
    });
  });

  it('keeps paid and open Asaas statuses in separate groups', () => {
    expect(isPlatformBillingOpenStatus('PENDING')).toBe(true);
    expect(isPlatformBillingOpenStatus('OVERDUE')).toBe(true);
    expect(isPlatformBillingOpenStatus('RECEIVED')).toBe(false);
    expect(isPlatformBillingPaidStatus('RECEIVED')).toBe(true);
    expect(isPlatformBillingPaidStatus('CONFIRMED')).toBe(true);
    expect(isPlatformBillingPaidStatus('PENDING')).toBe(false);
  });

  it('normalizes invoice status and numeric value from the cache row', () => {
    const invoice = normalizeCompanyBillingInvoice({
      id: 'invoice-1',
      company_id: 'company-1',
      asaas_payment_id: 'pay_1',
      asaas_customer_id: 'cus_1',
      asaas_subscription_id: null,
      description: '[PLUGUEGUEST] Mensalidade',
      status: 'received',
      value: '99.90',
      due_date: '2026-08-05',
      payment_date: '2026-08-04',
      billing_type: 'PIX',
      invoice_url: 'https://example.test/invoice',
      bank_slip_url: null,
      external_reference: null,
      asaas_created_at: '2026-08-01',
      last_synced_at: '2026-08-04T12:00:00.000Z',
      created_at: '2026-08-04T12:00:00.000Z',
      updated_at: '2026-08-04T12:00:00.000Z',
    });

    expect(invoice.status).toBe('RECEIVED');
    expect(invoice.value).toBe(99.9);
  });
});
