import { useQuery } from '@tanstack/react-query';
import { eachDayOfInterval, format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

interface AdsAttributionComparisonRpcRow {
  reservation_date: string;
  total_reservations: number | string | null;
  eligible_reservations?: number | string | null;
  evaluated_reservations: number | string | null;
  legacy_ads: number | string | null;
  journey_ads: number | string | null;
  both_ads: number | string | null;
  legacy_only_ads: number | string | null;
  journey_only_ads: number | string | null;
  insufficient_data: number | string | null;
}

export interface AdsAttributionComparisonPoint {
  date: string;
  label: string;
  totalReservations: number;
  eligibleReservations: number;
  evaluatedReservations: number;
  legacyAds: number;
  journeyAds: number;
  bothAds: number;
  legacyOnlyAds: number;
  journeyOnlyAds: number;
  insufficientData: number;
  delta: number;
}

export interface AdsAttributionComparisonTotals {
  totalReservations: number;
  eligibleReservations: number;
  evaluatedReservations: number;
  legacyAds: number;
  journeyAds: number;
  bothAds: number;
  legacyOnlyAds: number;
  journeyOnlyAds: number;
  insufficientData: number;
  delta: number;
  coveragePercentage: number;
}

function toCount(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyPoint(date: Date): AdsAttributionComparisonPoint {
  return {
    date: format(date, 'yyyy-MM-dd'),
    label: format(date, 'dd/MM'),
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
  };
}

export function useAdsAttributionComparison(
  companyId: string | undefined,
  startDate: Date,
  endDate: Date,
  enabled: boolean,
) {
  const startDateString = format(startDate, 'yyyy-MM-dd');
  const endDateString = format(endDate, 'yyyy-MM-dd');

  return useQuery({
    queryKey: [
      'ads-attribution-shadow-comparison',
      companyId ?? 'all',
      startDateString,
      endDateString,
    ],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)(
        'get_ads_attribution_shadow_comparison',
        {
          _company_id: companyId ?? null,
          _start_date: startDateString,
          _end_date: endDateString,
        },
      );

      if (error) throw error;

      const rows = (data ?? []) as AdsAttributionComparisonRpcRow[];
      const rowsByDate = new Map(rows.map((row) => [row.reservation_date, row]));

      return eachDayOfInterval({ start: startDate, end: endDate }).map((date) => {
        const point = emptyPoint(date);
        const row = rowsByDate.get(point.date);
        if (!row) return point;

        const legacyAds = toCount(row.legacy_ads);
        const journeyAds = toCount(row.journey_ads);

        return {
          ...point,
          totalReservations: toCount(row.total_reservations),
          eligibleReservations: toCount(
            row.eligible_reservations ?? row.evaluated_reservations,
          ),
          evaluatedReservations: toCount(row.evaluated_reservations),
          legacyAds,
          journeyAds,
          bothAds: toCount(row.both_ads),
          legacyOnlyAds: toCount(row.legacy_only_ads),
          journeyOnlyAds: toCount(row.journey_only_ads),
          insufficientData: toCount(row.insufficient_data),
          delta: journeyAds - legacyAds,
        };
      });
    },
    enabled,
    refetchInterval: enabled ? 2 * 60 * 1000 : false,
    refetchIntervalInBackground: false,
  });
}

export function getAdsAttributionComparisonTotals(
  points: AdsAttributionComparisonPoint[],
): AdsAttributionComparisonTotals {
  const totals = points.reduce<AdsAttributionComparisonTotals>(
    (result, point) => ({
      totalReservations: result.totalReservations + point.totalReservations,
      eligibleReservations: result.eligibleReservations + point.eligibleReservations,
      evaluatedReservations: result.evaluatedReservations + point.evaluatedReservations,
      legacyAds: result.legacyAds + point.legacyAds,
      journeyAds: result.journeyAds + point.journeyAds,
      bothAds: result.bothAds + point.bothAds,
      legacyOnlyAds: result.legacyOnlyAds + point.legacyOnlyAds,
      journeyOnlyAds: result.journeyOnlyAds + point.journeyOnlyAds,
      insufficientData: result.insufficientData + point.insufficientData,
      delta: result.delta + point.delta,
      coveragePercentage: 0,
    }),
    {
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
      coveragePercentage: 0,
    },
  );

  totals.coveragePercentage = totals.eligibleReservations > 0
    ? (totals.evaluatedReservations / totals.eligibleReservations) * 100
    : 0;

  return totals;
}
