import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getFunctionErrorMessage: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
  },
}));

vi.mock('@/lib/functionErrors', () => ({
  getFunctionErrorMessage: mocks.getFunctionErrorMessage,
}));

import {
  getCompanyBillingInvoicePixQrCode,
  PlatformBillingFunctionError,
} from '@/lib/platform-billing-api';

const INPUT = {
  companyId: '11111111-1111-4111-8111-111111111111',
  invoiceId: '22222222-2222-4222-8222-222222222222',
};

describe('platform billing Pix API errors', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('preserves retry_after_seconds returned by a failed Edge invocation', async () => {
    const response = new Response(JSON.stringify({
      ok: false,
      error: 'Aguarde antes de gerar outro Pix.',
      retry_after_seconds: 17,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: response },
    });
    mocks.getFunctionErrorMessage.mockResolvedValue('Aguarde antes de gerar outro Pix.');

    let receivedError: unknown;
    try {
      await getCompanyBillingInvoicePixQrCode(INPUT);
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBeInstanceOf(PlatformBillingFunctionError);
    expect(receivedError).toMatchObject({
      status: 429,
      retryAfterSeconds: 17,
      message: 'Aguarde antes de gerar outro Pix.',
    });
  });

  it('uses the Retry-After header when the payload omits the cooldown', async () => {
    const response = new Response(JSON.stringify({
      ok: false,
      error: 'Limite temporário.',
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '9',
      },
    });
    mocks.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: response },
    });
    mocks.getFunctionErrorMessage.mockResolvedValue('Limite temporário.');

    await expect(getCompanyBillingInvoicePixQrCode(INPUT)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 9,
    });
  });
});
