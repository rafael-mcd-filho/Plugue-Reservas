import { describe, expect, it } from 'vitest';
import {
  getAdsAttributionComparisonTotals,
  type AdsAttributionComparisonPoint,
} from '@/hooks/useAdsAttributionComparison';

function point(
  values: Partial<AdsAttributionComparisonPoint>,
): AdsAttributionComparisonPoint {
  return {
    date: '2026-07-01',
    label: '01/07',
    totalReservations: 0,
    eligibleReservations: 0,
    evaluatedReservations: 0,
    legacyAds: 0,
    journeyAds: 0,
    bothAds: 0,
    legacyOnlyAds: 0,
    journeyOnlyAds: 0,
    insufficientData: 0,
    delta: 0,
    ...values,
  };
}

describe('getAdsAttributionComparisonTotals', () => {
  it('soma os dois métodos e calcula a cobertura apenas sobre elegíveis', () => {
    const totals = getAdsAttributionComparisonTotals([
      point({
        totalReservations: 20,
        eligibleReservations: 10,
        evaluatedReservations: 8,
        legacyAds: 6,
        journeyAds: 4,
        bothAds: 3,
        legacyOnlyAds: 3,
        journeyOnlyAds: 1,
        insufficientData: 2,
        delta: -2,
      }),
      point({
        date: '2026-07-02',
        label: '02/07',
        totalReservations: 10,
        eligibleReservations: 5,
        evaluatedReservations: 4,
        legacyAds: 2,
        journeyAds: 3,
        bothAds: 2,
        journeyOnlyAds: 1,
        insufficientData: 1,
        delta: 1,
      }),
    ]);

    expect(totals).toMatchObject({
      totalReservations: 30,
      eligibleReservations: 15,
      evaluatedReservations: 12,
      legacyAds: 8,
      journeyAds: 7,
      bothAds: 5,
      legacyOnlyAds: 3,
      journeyOnlyAds: 2,
      insufficientData: 3,
      delta: -1,
      coveragePercentage: 80,
    });
  });

  it('mantém cobertura em zero quando ainda não existem elegíveis', () => {
    expect(getAdsAttributionComparisonTotals([]).coveragePercentage).toBe(0);
  });
});
