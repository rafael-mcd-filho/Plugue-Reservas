import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReservationPayment, getReservationPaymentRequirement, parseReservationPaymentRequirement } from '@/lib/asaas-prepayment-api';
import type { CreateReservationPaymentRequest, ReservationPaymentRequirement } from '@/lib/asaas-prepayment-contracts';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), errorMessage: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock('@/lib/functionErrors', () => ({ getFunctionErrorMessage: mocks.errorMessage }));
const scope = { companyId: 'company-one', date: '2026-12-01' };
const requirement: ReservationPaymentRequirement = {
  schema: 'reservation-payment-requirement', version: 1, company_id: scope.companyId, date: scope.date, requires_payment: true,
};
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue({ data: requirement, error: null });
  mocks.errorMessage.mockReset().mockResolvedValue('Falha na consulta.');
});

describe('public payment requirement hint', () => {
  it('queries only company and date, forwarding cancellation without sending guest data', async () => {
    const controller = new AbortController();
    expect(await getReservationPaymentRequirement(scope.companyId, scope.date, controller.signal)).toEqual(requirement);
    expect(mocks.invoke).toHaveBeenCalledWith('create-reservation-payment', {
      body: { action: 'preview', company_id: scope.companyId, date: scope.date }, signal: controller.signal,
    });
  });

  it.each(['feature_disabled', 'no_rule'])('accepts an explicit false requirement: %s', reason => {
    const free = { ...requirement, requires_payment: false, reason };
    expect(parseReservationPaymentRequirement(free, scope)).toEqual(free);
  });

  it.each([
    { schema: 'legacy' }, { version: 2 }, { company_id: 'other-company' }, { date: '2026-12-02' },
    { requires_payment: undefined }, { requires_payment: 'false' }, { reason: 'unknown' }, { reason: 'no_rule' },
  ])('rejects an incompatible or mismatched requirement: %j', patch => {
    expect(() => parseReservationPaymentRequirement({ ...requirement, ...patch }, scope)).toThrow(/consultar/);
  });

  it('strips non-contract fields instead of forwarding rule prices or credentials', () => {
    expect(parseReservationPaymentRequirement({ ...requirement, amount: 500, rule: { base_amount: 100 }, private: 'secret' }, scope)).toEqual(requirement);
  });

  it('does not interpret an old endpoint or transport error as a false requirement', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: { requires_payment: false, reason: 'no_rule' }, error: null });
    await expect(getReservationPaymentRequirement(scope.companyId, scope.date)).rejects.toThrow(/consultar/);
    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('Endpoint unavailable') });
    await expect(getReservationPaymentRequirement(scope.companyId, scope.date)).rejects.toThrow('Falha na consulta.');
  });

  it('cancels before request and rejects a result received after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getReservationPaymentRequirement(scope.companyId, scope.date, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.invoke).not.toHaveBeenCalled();
    const inFlight = new AbortController();
    mocks.invoke.mockImplementationOnce(async () => { inFlight.abort(); return { data: requirement, error: null }; });
    await expect(getReservationPaymentRequirement(scope.companyId, scope.date, inFlight.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps reservation creation unchanged, with no fingerprint or special review errors', async () => {
    const body = { company_id: scope.companyId, complete_without_payment: true,
      reservation: { date: scope.date, time: '19:00', guest_name: 'Cliente', guest_phone: '+5511999999999', party_size: 3 },
    } as CreateReservationPaymentRequest;
    const created = { requires_payment: false, reservation_created: true, reservation_id: 'reservation-one' };
    mocks.invoke.mockResolvedValue({ data: created, error: null });
    expect(await createReservationPayment(body)).toEqual(created);
    expect(mocks.invoke).toHaveBeenCalledWith('create-reservation-payment', { body });
  });
});
