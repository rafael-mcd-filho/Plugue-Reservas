import { describe, expect, it } from 'vitest';
import {
  normalizePlatformBillingPixQrCode,
  PlatformBillingPixValidationError,
  validatePlatformBillingPaymentForPix,
} from '../../supabase/functions/_shared/platform-billing-pix.ts';
import { normalizeCompanyBillingInvoicePixQrCode } from '@/lib/platform-billing-contracts';

const PAYMENT_ID = 'pay_000000000001';
const INVOICE_ID = '50000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = 'cus_000000000001';
const MARKER = '[PLUGUEGUEST]';
const ENCODED_IMAGE = 'QUFB'.repeat(16);
const PIX_PAYLOAD = '00020101021226800014BR.GOV.BCB.PIX5204000053039865802BR6304ABCD';

describe('platform billing Pix safety contract', () => {
  it.each([
    ['PENDING', 'PIX'],
    ['PENDING', 'BOLETO'],
    ['PENDING', 'UNDEFINED'],
    ['OVERDUE', 'PIX'],
    ['OVERDUE', 'BOLETO'],
    ['OVERDUE', 'UNDEFINED'],
  ])('accepts an eligible live payment with status %s and type %s', (status, billingType) => {
    expect(validatePlatformBillingPaymentForPix({
      id: PAYMENT_ID,
      customer: CUSTOMER_ID,
      description: `Mensalidade ${MARKER}`,
      status,
      billingType,
      value: '149.90',
      dueDate: '2026-08-20',
    }, {
      paymentId: PAYMENT_ID,
      customerId: CUSTOMER_ID,
      descriptionMarker: MARKER,
    })).toMatchObject({ status, billingType, value: 149.9, dueDate: '2026-08-20' });
  });

  it.each([
    ['RECEIVED', 'PIX'],
    ['CONFIRMED', 'PIX'],
    ['AWAITING_RISK_ANALYSIS', 'PIX'],
    ['DUNNING_REQUESTED', 'PIX'],
    ['PENDING', 'CREDIT_CARD'],
  ])('rejects an ineligible live payment with status %s and type %s', (status, billingType) => {
    expect(() => validatePlatformBillingPaymentForPix({
      id: PAYMENT_ID,
      customer: CUSTOMER_ID,
      description: `Mensalidade ${MARKER}`,
      status,
      billingType,
      value: 149.9,
      dueDate: '2026-08-20',
    }, {
      paymentId: PAYMENT_ID,
      customerId: CUSTOMER_ID,
      descriptionMarker: MARKER,
    })).toThrow(PlatformBillingPixValidationError);
  });

  it('rejects a payment from another customer or without the current marker', () => {
    const expected = {
      paymentId: PAYMENT_ID,
      customerId: CUSTOMER_ID,
      descriptionMarker: MARKER,
    };
    const payment = {
      id: PAYMENT_ID,
      customer: 'cus_another_customer',
      description: `Mensalidade ${MARKER}`,
      status: 'PENDING',
      billingType: 'PIX',
      value: 149.9,
      dueDate: '2026-08-20',
    };

    expect(() => validatePlatformBillingPaymentForPix(payment, expected)).toThrow(
      'não pertence mais ao cliente Asaas',
    );
    expect(() => validatePlatformBillingPaymentForPix({
      ...payment,
      customer: CUSTOMER_ID,
      description: 'Mensalidade sem marcador',
    }, expected)).toThrow('não pertence mais ao Financeiro');
    expect(() => validatePlatformBillingPaymentForPix({
      ...payment,
      customer: CUSTOMER_ID,
    }, { ...expected, descriptionMarker: ' ' })).toThrow('Marcador financeiro inválido');
  });

  it('rejects invalid live amount and due date values', () => {
    const payment = {
      id: PAYMENT_ID,
      customer: CUSTOMER_ID,
      description: `Mensalidade ${MARKER}`,
      status: 'PENDING',
      billingType: 'PIX',
      value: 149.9,
      dueDate: '2026-08-20',
    };
    const expected = {
      paymentId: PAYMENT_ID,
      customerId: CUSTOMER_ID,
      descriptionMarker: MARKER,
    };

    expect(() => validatePlatformBillingPaymentForPix({
      ...payment,
      value: 0,
    }, expected)).toThrow('Valor da cobrança inválido');
    expect(() => validatePlatformBillingPaymentForPix({
      ...payment,
      dueDate: '2026-02-30',
    }, expected)).toThrow('Vencimento da cobrança inválido');
  });

  it('normalizes a strict provider QR response', () => {
    expect(normalizePlatformBillingPixQrCode({
      encodedImage: ENCODED_IMAGE,
      payload: PIX_PAYLOAD,
      expirationDate: '2026-08-18T23:59:59-03:00',
    })).toEqual({
      encodedImage: ENCODED_IMAGE,
      payload: PIX_PAYLOAD,
      expirationDate: '2026-08-18T23:59:59-03:00',
    });
  });

  it('rejects malformed image, payload and expiration data', () => {
    const valid = {
      encodedImage: ENCODED_IMAGE,
      payload: PIX_PAYLOAD,
      expirationDate: '2026-08-18T23:59:59-03:00',
    };

    expect(() => normalizePlatformBillingPixQrCode({
      ...valid,
      encodedImage: `data:image/png;base64,${ENCODED_IMAGE}`,
    })).toThrow('Imagem do QR Code Pix inválida');
    expect(() => normalizePlatformBillingPixQrCode({
      ...valid,
      payload: `${PIX_PAYLOAD}\nsegredo`,
    })).toThrow('Código Pix copia e cola inválido');
    expect(() => normalizePlatformBillingPixQrCode({
      ...valid,
      expirationDate: 'amanha',
    })).toThrow('Validade do Pix inválida');
    expect(() => normalizePlatformBillingPixQrCode({
      ...valid,
      success: false,
    })).toThrow('não confirmou a geração');
  });

  it('maps the backend response without changing the payment data', () => {
    expect(normalizeCompanyBillingInvoicePixQrCode({
      ok: true,
      invoice_id: INVOICE_ID,
      asaas_payment_id: PAYMENT_ID,
      payment: {
        value: '149.90',
        due_date: '2026-08-20',
      },
      pix: {
        encoded_image: ENCODED_IMAGE,
        payload: PIX_PAYLOAD,
        expiration_date: '2026-08-18T23:59:59-03:00',
      },
    }, INVOICE_ID)).toEqual({
      invoiceId: INVOICE_ID,
      asaasPaymentId: PAYMENT_ID,
      value: 149.9,
      dueDate: '2026-08-20',
      encodedImage: ENCODED_IMAGE,
      payload: PIX_PAYLOAD,
      expirationDate: '2026-08-18T23:59:59-03:00',
    });
  });

  it('rejects an invalid or unexpected invoice identifier from the backend', () => {
    const response = {
      ok: true as const,
      invoice_id: INVOICE_ID,
      asaas_payment_id: PAYMENT_ID,
      payment: { value: 149.9, due_date: '2026-08-20' },
      pix: {
        encoded_image: ENCODED_IMAGE,
        payload: PIX_PAYLOAD,
        expiration_date: '2026-08-18T23:59:59-03:00',
      },
    };

    expect(() => normalizeCompanyBillingInvoicePixQrCode({
      ...response,
      invoice_id: 'invoice-1',
    }, INVOICE_ID)).toThrow('dados incompletos');
    expect(() => normalizeCompanyBillingInvoicePixQrCode(
      response,
      '50000000-0000-4000-8000-000000000002',
    )).toThrow('dados incompletos');
    expect(() => normalizeCompanyBillingInvoicePixQrCode({
      ...response,
      ok: false,
    } as unknown as Parameters<typeof normalizeCompanyBillingInvoicePixQrCode>[0], INVOICE_ID))
      .toThrow('dados incompletos');
    expect(() => normalizeCompanyBillingInvoicePixQrCode({
      ...response,
      asaas_payment_id: 'pay!',
    }, INVOICE_ID)).toThrow('dados incompletos');
    expect(() => normalizeCompanyBillingInvoicePixQrCode({
      ...response,
      payment: { value: 149.9, due_date: '2026-02-30' },
    }, INVOICE_ID)).toThrow('dados incompletos');
  });
});
