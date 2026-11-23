import { describe, expect, it } from 'vitest';
import {
  normalizeSettlementAmounts,
  formatSettlementTermsRates,
  getSettlementMethodFees,
  parseSettlementMoney,
  parseSettlementRate,
  settlementEntryLabel,
} from './reservation-settlements-api';

describe('financial amounts', () => {
  it('preserves distinct method rates and legacy fallback without replacing a zero rate', () => {
    expect(getSettlementMethodFees({ fee_bps: 1000 })).toEqual({ pix: 1000, creditCard: 1000 });
    expect(getSettlementMethodFees({ fee_bps: 1000, pix_fee_bps: null, credit_card_fee_bps: 1250 })).toEqual({ pix: 1000, creditCard: 1250 });
    expect(formatSettlementTermsRates({ fee_bps: 1000, pix_fee_bps: 0, credit_card_fee_bps: 1250 })).toBe('Pix 0% · Cartão 12,5%');
    expect(parseSettlementRate('0')).toBe(0);
    expect(parseSettlementRate('2,50')).toBe(250);
    expect(parseSettlementRate('100.00')).toBe(10000);
    for (const value of ['', '-1', '+1', '1e2', '100,01', '2,555', 'Infinity']) expect(parseSettlementRate(value)).toBeNull();
  });
  it('preserves cents and rejects signs, exponents, fractional cents and thousands separators', () => {
    expect(parseSettlementMoney('500,01')).toBe(50001);
    expect(parseSettlementMoney('500.1')).toBe(50010);
    for (const value of [
      '0',
      '-1',
      '+1',
      '1e3',
      '1,001',
      '1.000,00',
      'Infinity',
      'NaN',
      '9007199254740993',
    ])
      expect(parseSettlementMoney(value)).toBeNull();
  });
  it('normalizes bigint strings recursively and refuses unsafe totals', () => {
    expect(
      normalizeSettlementAmounts({
        available_cents: '180000',
        withdrawals: [{ amount_cents: '50000' }],
      }),
    ).toEqual({
      available_cents: 180000,
      withdrawals: [{ amount_cents: 50000 }],
    });
    expect(() =>
      normalizeSettlementAmounts({ available_cents: '9007199254740993' }),
    ).toThrow('Valor financeiro inválido');
    expect(() => normalizeSettlementAmounts({ available_cents: null })).toThrow(
      'Valor financeiro inválido',
    );
  });
  it('uses customer-facing Portuguese descriptions instead of internal event codes', () => {
    expect(
      settlementEntryLabel({ entry_type: 'withdrawal_paid' } as never),
    ).toBe('Repasse realizado');
    expect(
      settlementEntryLabel({ entry_type: 'unknown_internal_code' } as never),
    ).toBe('Movimentação financeira');
  });
});
