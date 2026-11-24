import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReservationSectionOptions, parseReservationSectionOptions } from '@/lib/asaas-prepayment-api';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/functionErrors', () => ({ getFunctionErrorMessage: vi.fn() }));
const option = {
  id: 'section-one', section_id: 'section-one', payment_rule_section_id: 'option-premium', section_name: 'Sacada', public_name: 'Sacada Premium',
  description: 'Vista externa', amount_type: 'per_person', base_amount: 50, pix_amount: 48,
  credit_card_amount: 52, available: true,
};
const offered = { enabled: true, rule_id: 'rule-one', options: [option] };

beforeEach(() => {
  mocks.rpc.mockReset().mockResolvedValue({ data: offered, error: null });
  mocks.abortSignal.mockReset().mockResolvedValue({ data: offered, error: null });
});

describe('public environment offers', () => {
  it('queries the selected date, time and group without guest data and keeps unit prices', async () => {
    expect(await getReservationSectionOptions('company-one', '2026-12-01', '19:00', 3)).toEqual(offered);
    expect(mocks.rpc).toHaveBeenCalledWith('get_public_reservation_section_options', {
      _company_id: 'company-one', _date: '2026-12-01', _time: '19:00', _party_size: 3,
    });
  });

  it('accepts an explicitly disabled selection but rejects malformed offers and duplicates', () => {
    expect(parseReservationSectionOptions({ enabled: false, options: [] })).toEqual({ enabled: false, options: [] });
    for (const malformed of [null, { options: [] }, { ...offered, rule_id: 123 },
      { ...offered, options: [{ ...option, available: 'true' }] },
      { ...offered, options: [{ ...option, pix_amount: -10 }] },
      { ...offered, options: [{ ...option, base_amount: Number.NaN }] },
      { ...offered, options: [{ ...option, id: 'commercial-option-id' }] },
      { ...offered, options: [option, option] }, { ...offered, enabled: false }]) {
      expect(() => parseReservationSectionOptions(malformed)).toThrow(/ambientes/);
    }
  });

  it('accepts environment selection without an active payment rule', () => {
    const free = { enabled: true, rule_id: null, options: [{ ...option,
      payment_rule_section_id: null, amount_type: null, base_amount: null, pix_amount: null, credit_card_amount: null,
    }] };
    expect(parseReservationSectionOptions(free)).toEqual(free);
  });

  it.each([true, false])('preserves automatic single-price allocation availability: %s', automatic_allocation_available => {
    const automatic = { enabled: false, rule_id: 'rule-single', options: [], automatic_allocation_available };
    expect(parseReservationSectionOptions(automatic)).toEqual(automatic);
  });

  it.each(['false', null, 0])('rejects invalid automatic allocation availability: %s', automatic_allocation_available => {
    expect(() => parseReservationSectionOptions({ enabled: false, options: [], automatic_allocation_available })).toThrow(/ambientes/);
  });

  it('keeps single-rule offers and unavailable section prices without inventing amounts', () => {
    const singlePrice = { ...offered, options: [{ ...option, payment_rule_section_id: null }] };
    expect(parseReservationSectionOptions(singlePrice)).toEqual(singlePrice);
    const noConfiguredPrice = { ...offered, options: [{ ...option, payment_rule_section_id: null,
      base_amount: null, pix_amount: null, credit_card_amount: null, available: false }] };
    expect(parseReservationSectionOptions(noConfiguredPrice)).toEqual(noConfiguredPrice);
  });

  it('preserves sold-out environments so the customer can see that they are unavailable', () => {
    const soldOut = { ...offered, options: [{ ...option, available: false }] };
    expect(parseReservationSectionOptions(soldOut)).toEqual(soldOut);
  });

  it.each(['PGRST202', '42883', '404'])('keeps legacy databases working when the environment RPC is explicitly absent: %s', async code => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: {
      code, message: 'Could not find the function public.get_public_reservation_section_options in the schema cache',
    } });
    await expect(getReservationSectionOptions('company-one', '2026-12-01', '19:00', 2)).resolves.toEqual({ enabled: false, options: [] });
  });

  it.each([
    { code: 'PGRST202', message: 'Could not find a different function' },
    { code: '42501', message: 'Permission denied for function get_public_reservation_section_options' },
    { message: 'Network error while loading get_public_reservation_section_options' },
  ])('does not hide network, permission or unrelated schema errors: %j', async error => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error });
    await expect(getReservationSectionOptions('company-one', '2026-12-01', '19:00', 2)).rejects.toThrow(error.message);
  });

  it('keeps failed queries as errors and cancels pending reads', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Consulta indisponível' } });
    await expect(getReservationSectionOptions('company-one', '2026-12-01', '19:00', 2)).rejects.toThrow('Consulta indisponível');
    const controller = new AbortController();
    mocks.rpc.mockReturnValueOnce({ abortSignal: mocks.abortSignal });
    expect(await getReservationSectionOptions('company-one', '2026-12-01', '19:00', 2, controller.signal)).toEqual(offered);
    expect(mocks.abortSignal).toHaveBeenCalledWith(controller.signal);
    controller.abort();
    await expect(getReservationSectionOptions('company-one', '2026-12-01', '19:00', 2, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
