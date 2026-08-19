import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CompanyBillingPixRequestCoordinator,
  CompanyBillingPixRequestError,
  getCompanyBillingPixRemainingSeconds,
  isCompanyBillingPixQrCodeValid,
} from '@/lib/company-billing-pix-client';
import type { CompanyBillingInvoicePixQrCode } from '@/lib/platform-billing-contracts';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function pixData(
  invoiceId: string,
  expirationDate = new Date(NOW + 60_000).toISOString(),
): CompanyBillingInvoicePixQrCode {
  return {
    invoiceId,
    asaasPaymentId: `payment-${invoiceId}`,
    value: 149.9,
    dueDate: '2026-08-20',
    encodedImage: 'A'.repeat(64),
    payload: '00020101021226850014br.gov.bcb.pix',
    expirationDate,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('CompanyBillingPixRequestCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deduplicates double click and close/reopen while the same invoice is in flight', async () => {
    const pending = deferred<CompanyBillingInvoicePixQrCode>();
    const fetcher = vi.fn(() => pending.promise);
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const input = { companyId: 'company-1', invoiceId: 'invoice-1' };

    const first = coordinator.request(input);
    const reopened = coordinator.request(input);

    expect(reopened).toBe(first);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    pending.resolve(pixData(input.invoiceId));
    await expect(first).resolves.toMatchObject({ invoiceId: input.invoiceId });
    await expect(reopened).resolves.toMatchObject({ invoiceId: input.invoiceId });
    coordinator.dispose();
  });

  it('reconnects A after an intervening B attempt without duplicating the A request', async () => {
    const pendingA = deferred<CompanyBillingInvoicePixQrCode>();
    const fetcher = vi.fn(() => pendingA.promise);
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const invoiceA = { companyId: 'company-1', invoiceId: 'invoice-a' };
    const invoiceB = { companyId: 'company-1', invoiceId: 'invoice-b' };

    const firstA = coordinator.request(invoiceA);
    await Promise.resolve();
    const blockedB = coordinator.request(invoiceB);
    const reconnectedA = coordinator.request(invoiceA);

    expect(reconnectedA).toBe(firstA);
    await expect(blockedB).rejects.toBeInstanceOf(CompanyBillingPixRequestError);
    expect(fetcher).toHaveBeenCalledTimes(1);

    pendingA.resolve(pixData(invoiceA.invoiceId));
    await expect(reconnectedA).resolves.toMatchObject({ invoiceId: invoiceA.invoiceId });
    coordinator.dispose();
  });

  it('reuses a valid result and fetches again only after its expiration', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(pixData('invoice-1'))
      .mockResolvedValueOnce(pixData('invoice-1', new Date(NOW + 180_000).toISOString()));
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const input = { companyId: 'company-1', invoiceId: 'invoice-1' };

    const first = await coordinator.request(input);
    const reopened = await coordinator.request(input);
    expect(reopened).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    const refreshed = await coordinator.request(input);
    expect(refreshed.expirationDate).not.toBe(first.expirationDate);
    expect(fetcher).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('propagates server retry-after and blocks every new invoice during cooldown', async () => {
    const rateLimitError = Object.assign(new Error('Muitas tentativas de Pix.'), {
      status: 429,
      retryAfterSeconds: 25,
    });
    const fetcher = vi.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(pixData('invoice-2', new Date(NOW + 120_000).toISOString()));
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });

    let receivedError: unknown;
    try {
      await coordinator.request({ companyId: 'company-1', invoiceId: 'invoice-1' });
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBeInstanceOf(CompanyBillingPixRequestError);
    expect(getCompanyBillingPixRemainingSeconds(receivedError, NOW)).toBe(25);
    await expect(coordinator.request({ companyId: 'company-1', invoiceId: 'invoice-2' }))
      .rejects.toMatchObject({ retryAt: NOW + 25_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24_000);
    expect(getCompanyBillingPixRemainingSeconds(receivedError, Date.now())).toBe(1);
    await expect(coordinator.request({ companyId: 'company-1', invoiceId: 'invoice-2' }))
      .rejects.toBeInstanceOf(CompanyBillingPixRequestError);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(coordinator.request({ companyId: 'company-1', invoiceId: 'invoice-2' }))
      .resolves.toMatchObject({ invoiceId: 'invoice-2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('never caches or returns an expired QR code', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(pixData('invoice-1', new Date(NOW - 1).toISOString()))
      .mockResolvedValueOnce(pixData('invoice-1', new Date(NOW + 120_000).toISOString()));
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const input = { companyId: 'company-1', invoiceId: 'invoice-1' };

    await expect(coordinator.request(input)).rejects.toThrow('já expirou');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(coordinator.request(input)).resolves.toMatchObject({ invoiceId: 'invoice-1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('prevents a late response from repopulating cache after clear', async () => {
    const pending = deferred<CompanyBillingInvoicePixQrCode>();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(pixData('invoice-1', new Date(NOW + 120_000).toISOString()));
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const input = { companyId: 'company-1', invoiceId: 'invoice-1' };

    const request = coordinator.request(input);
    await Promise.resolve();
    coordinator.clear();
    pending.resolve(pixData(input.invoiceId));
    await expect(request).rejects.toThrow('encerrada');

    await expect(coordinator.request(input)).resolves.toMatchObject({ invoiceId: input.invoiceId });
    expect(fetcher).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('disposes per-view state without accepting a late payload', async () => {
    const pending = deferred<CompanyBillingInvoicePixQrCode>();
    const fetcher = vi.fn(() => pending.promise);
    const coordinator = new CompanyBillingPixRequestCoordinator({ fetcher });
    const input = { companyId: 'company-1', invoiceId: 'invoice-1' };

    const request = coordinator.request(input);
    await Promise.resolve();
    coordinator.dispose();
    pending.resolve(pixData(input.invoiceId));

    await expect(request).rejects.toThrow('encerrada');
    await expect(coordinator.request(input)).rejects.toThrow('encerrada');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('isCompanyBillingPixQrCodeValid', () => {
  it('accepts only well-formed future expirations', () => {
    expect(isCompanyBillingPixQrCodeValid(pixData('invoice-1'), NOW)).toBe(true);
    expect(isCompanyBillingPixQrCodeValid(
      pixData('invoice-1', new Date(NOW).toISOString()),
      NOW,
    )).toBe(false);
    expect(isCompanyBillingPixQrCodeValid(pixData('invoice-1', '2026-02-30 10:00:00'), NOW)).toBe(false);
    expect(isCompanyBillingPixQrCodeValid(pixData('invoice-1', 'amanhã'), NOW)).toBe(false);
  });
});
