/** @vitest-environment jsdom */

import { useEffect, type PropsWithChildren } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvoicePixDialog from '@/components/billing/InvoicePixDialog';
import type {
  CompanyBillingInvoice,
  CompanyBillingInvoicePixQrCode,
} from '@/lib/platform-billing-contracts';

const mocks = vi.hoisted(() => ({
  getInvoicePix: vi.fn(),
}));

vi.mock('@/lib/platform-billing-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform-billing-api')>();
  return {
    ...actual,
    getCompanyBillingInvoicePixQrCode: mocks.getInvoicePix,
  };
});

import { useCompanyBillingInvoicePixQrCode } from '@/hooks/usePlatformBilling';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

const invoice: CompanyBillingInvoice = {
  id: 'invoice-a',
  companyId: 'company-a',
  asaasPaymentId: 'payment-invoice-a',
  asaasCustomerId: 'customer-a',
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

function pixData(
  companyId: string,
  invoiceId: string,
  expirationDate = new Date(NOW + 60_000).toISOString(),
): CompanyBillingInvoicePixQrCode {
  return {
    invoiceId,
    asaasPaymentId: `payment-${invoiceId}`,
    value: 149.9,
    dueDate: '2026-08-20',
    encodedImage: 'A'.repeat(64),
    payload: `payload-${companyId}-${invoiceId}`,
    expirationDate,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

async function flushReactQuery() {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useCompanyBillingInvoicePixQrCode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.getInvoicePix.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects the observer in A -> B -> A while issuing one request for A', async () => {
    const pendingA = deferred<CompanyBillingInvoicePixQrCode>();
    mocks.getInvoicePix.mockImplementation(() => pendingA.promise);
    const { wrapper } = testContext();
    const { result, unmount } = renderHook(
      () => useCompanyBillingInvoicePixQrCode(),
      { wrapper },
    );
    const invoiceA = { companyId: 'company-a', invoiceId: 'invoice-a' };
    const invoiceB = { companyId: 'company-a', invoiceId: 'invoice-b' };

    let firstA!: Promise<CompanyBillingInvoicePixQrCode>;
    let blockedB!: Promise<unknown>;
    let reconnectedA!: Promise<CompanyBillingInvoicePixQrCode>;
    act(() => {
      firstA = result.current.mutateAsync(invoiceA);
      blockedB = result.current.mutateAsync(invoiceB).catch((error) => error);
      reconnectedA = result.current.mutateAsync(invoiceA);
    });
    await flushReactQuery();

    expect(mocks.getInvoicePix).toHaveBeenCalledTimes(1);
    pendingA.resolve(pixData(invoiceA.companyId, invoiceA.invoiceId));
    await act(async () => {
      await Promise.all([firstA, blockedB, reconnectedA]);
    });
    await flushReactQuery();

    expect(result.current.data?.invoiceId).toBe(invoiceA.invoiceId);
    unmount();
  });

  it('purges QR data from the mutation cache on unmount', async () => {
    mocks.getInvoicePix.mockResolvedValue(pixData('company-a', 'invoice-a'));
    const { queryClient, wrapper } = testContext();
    const { result, unmount } = renderHook(
      () => useCompanyBillingInvoicePixQrCode(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ companyId: 'company-a', invoiceId: 'invoice-a' });
    });
    await flushReactQuery();
    expect(result.current.data?.payload).toContain('company-a');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('resets observer and cache as soon as the QR expires', async () => {
    mocks.getInvoicePix.mockResolvedValue(
      pixData('company-a', 'invoice-a', new Date(NOW + 5_000).toISOString()),
    );
    const { queryClient, wrapper } = testContext();
    const { result, unmount } = renderHook(
      () => useCompanyBillingInvoicePixQrCode(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ companyId: 'company-a', invoiceId: 'invoice-a' });
    });
    await flushReactQuery();
    expect(result.current.data?.payload).toContain('company-a');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_002);
    });
    await flushReactQuery();
    expect(result.current.data).toBeUndefined();
    expect(result.current.expiredInvoiceId).toBe('invoice-a');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    unmount();
  });

  it('keeps a QR valid beyond the maximum browser timeout and purges it on the real date', async () => {
    const maxTimeoutMs = 2_147_483_647;
    const fortyDaysMs = 40 * 24 * 60 * 60 * 1_000;
    mocks.getInvoicePix.mockResolvedValue(
      pixData('company-a', 'invoice-a', new Date(NOW + fortyDaysMs).toISOString()),
    );
    const { queryClient, wrapper } = testContext();
    const { result, unmount } = renderHook(
      () => useCompanyBillingInvoicePixQrCode(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ companyId: 'company-a', invoiceId: 'invoice-a' });
    });
    await flushReactQuery();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(maxTimeoutMs);
    });
    await flushReactQuery();
    expect(result.current.data?.invoiceId).toBe('invoice-a');
    expect(result.current.expiredInvoiceId).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(fortyDaysMs - maxTimeoutMs + 2);
    });
    await flushReactQuery();
    expect(result.current.data).toBeUndefined();
    expect(result.current.expiredInvoiceId).toBe('invoice-a');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    unmount();
  });

  it('purges an expired payload while keeping the open dialog in an explicit retry state', async () => {
    const expiringPix = pixData(
      invoice.companyId,
      invoice.id,
      new Date(NOW + 2_000).toISOString(),
    );
    mocks.getInvoicePix.mockResolvedValue(expiringPix);
    const { queryClient, wrapper: QueryWrapper } = testContext();

    function OpenPixDialog() {
      const mutation = useCompanyBillingInvoicePixQrCode();
      const { mutateAsync } = mutation;
      const requestMatches = mutation.variables?.invoiceId === invoice.id;
      useEffect(() => {
        void mutateAsync({ companyId: invoice.companyId, invoiceId: invoice.id });
      }, [mutateAsync]);
      return (
        <InvoicePixDialog
          invoice={invoice}
          pixData={mutation.data?.invoiceId === invoice.id ? mutation.data : null}
          error={requestMatches ? mutation.error : null}
          isExpired={mutation.expiredInvoiceId === invoice.id}
          isLoading={requestMatches && mutation.isPending}
          open
          onOpenChange={vi.fn()}
          onRetry={vi.fn()}
        />
      );
    }

    const view = render(<QueryWrapper><OpenPixDialog /></QueryWrapper>);
    await flushReactQuery();
    expect(screen.getByRole('img', { name: /QR Code Pix/ })).toBeTruthy();
    expect(screen.getByDisplayValue(expiringPix.payload)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_002);
    });
    await flushReactQuery();

    expect(screen.queryByRole('img', { name: /QR Code Pix/ })).toBeNull();
    expect(screen.queryByDisplayValue(expiringPix.payload)).toBeNull();
    expect(screen.getByText('Este código Pix expirou')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled();
    expect(queryClient.getMutationCache().getAll().some(
      (cachedMutation) => (
        cachedMutation.state.data as CompanyBillingInvoicePixQrCode | undefined
      )?.payload === expiringPix.payload,
    )).toBe(false);
    view.unmount();
  });

  it('drops company A immediately when a keyed billing scope changes to company B', async () => {
    mocks.getInvoicePix.mockImplementation(({ companyId, invoiceId }) => (
      Promise.resolve(pixData(companyId, invoiceId))
    ));
    const { queryClient, wrapper: QueryWrapper } = testContext();

    function PixScope({ companyId }: { companyId: string }) {
      const mutation = useCompanyBillingInvoicePixQrCode();
      const { data, mutateAsync } = mutation;
      useEffect(() => {
        void mutateAsync({ companyId, invoiceId: 'invoice-1' });
      }, [companyId, mutateAsync]);
      return <output data-testid="pix-payload">{data?.payload ?? 'Carregando'}</output>;
    }

    function KeyedBillingScope({ companyId }: { companyId: string }) {
      return <PixScope key={companyId} companyId={companyId} />;
    }

    const view = render(
      <QueryWrapper><KeyedBillingScope companyId="company-a" /></QueryWrapper>,
    );
    await flushReactQuery();
    expect(screen.getByTestId('pix-payload').textContent).toContain('company-a');

    view.rerender(
      <QueryWrapper><KeyedBillingScope companyId="company-b" /></QueryWrapper>,
    );
    expect(screen.getByTestId('pix-payload').textContent).toBe('Carregando');
    await flushReactQuery();
    expect(screen.getByTestId('pix-payload').textContent).toContain('company-b');
    expect(queryClient.getMutationCache().getAll().some(
      (mutation) => String((
        mutation.state.data as CompanyBillingInvoicePixQrCode | undefined
      )?.payload ?? '').includes('company-a'),
    )).toBe(false);
    view.unmount();
  });
});
