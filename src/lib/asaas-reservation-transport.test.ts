// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asaasRequest, createAsaasPaymentLink, getAsaasRefundedValue } from '../../supabase/functions/_shared/asaas';
import { buildPaymentLinkDescription } from '../../supabase/functions/_shared/reservation-payments';

// These imports exercise Edge code under Node; only its environment reader is
// required by the frontend test typecheck. Runtime values are stubbed below.
declare global {
  const Deno: { env: { get(name: string): string | undefined } };
}

afterEach(() => vi.unstubAllGlobals());

describe('Asaas reservation account transport', () => {
  it('counts only completed refunds when calculating money returned', () => {
    expect(getAsaasRefundedValue({ id: 'pay', refunds: [
      { status: 'DONE', value: 20 }, { status: 'DONE', value: 5.25 },
      { status: 'PENDING', value: 30 }, { status: 'CANCELLED', value: 40 },
    ] })).toBe(25.25);
    expect(getAsaasRefundedValue({ id: 'pay', refunds: [{ status: 'PENDING', value: 30 }] })).toBeNull();
  });
  it('keeps simultaneous sandbox and production requests on their own accounts', async () => {
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: 'pay_example' })));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      asaasRequest({ apiToken: 'sandbox-secret', environment: 'sandbox' }, '/payments/pay_sandbox'),
      asaasRequest({ apiToken: 'production-secret', environment: 'production' }, '/payments/pay_production'),
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api-sandbox.asaas.com/v3/payments/pay_sandbox');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.asaas.com/v3/payments/pay_production');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('access_token')).toBe('sandbox-secret');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('access_token')).toBe('production-secret');
  });

  it('rejects absolute URLs before sending credentials', async () => {
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const path of ['https://other.example/payments', '//other.example/payments']) {
      await expect(asaasRequest('secret', path)).rejects.toThrow('Caminho Asaas invalido');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a one-use card link with a stable reconciliation reference', async () => {
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: 'link_example' })));
    vi.stubGlobal('fetch', fetchMock);
    await createAsaasPaymentLink({ apiToken: 'secret', environment: 'production' }, {
      name: 'Reserva', value: 100, billingType: 'CREDIT_CARD', chargeType: 'DETACHED',
      limit: 1, externalReference: 'PR-reservation-token-CREDIT_CARD',
    });
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.limit).toBe(1);
    expect(payload.externalReference).toBe('PR-reservation-token-CREDIT_CARD');
  });

  it('keeps tenant and reservation IDs within the provider description limit', () => {
    const description = buildPaymentLinkDescription({
      payment_token: 'token', company_id: 'company-123', reservation_id: 'reservation-456',
      rule_snapshot: { name: 'Regra '.repeat(150) },
    }, {
      date: '2026-11-07', time: '19:30:00', party_size: 4,
      guest_name: 'Cliente '.repeat(150), public_tracking_code: 'REF123',
    }, { name: 'Restaurante '.repeat(150) });
    expect(description.length).toBeLessThanOrEqual(500);
    expect(description).toContain('Empresa company-123');
    expect(description).toContain('Reserva reservation-456');
    expect(description).toContain('Ref REF123');
    expect(description).toContain('2026-11-07 19:30');
  });
});
