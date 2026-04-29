import { useQuery } from '@tanstack/react-query';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';

export interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

export interface FunnelQueryResult {
  points: FunnelDataPoint[];
}

interface TrackingFunnelCountRow {
  step: string | null;
  event_count: number | string | null;
}

function normalizeDateRangeBoundary(date: Date | undefined, boundary: 'start' | 'end') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const normalized = new Date(date);
  if (boundary === 'start') {
    normalized.setHours(0, 0, 0, 0);
  } else {
    normalized.setHours(23, 59, 59, 999);
  }

  return normalized.toISOString();
}

function isFunnelStep(value: string | null): value is FunnelStep {
  return FUNNEL_STEPS.includes(value as FunnelStep);
}

export function useFunnelData(
  companyId?: string,
  startDate?: Date,
  endDate?: Date,
  uniqueOnly = false,
  adsOnly = false,
) {
  return useQuery<FunnelQueryResult>({
    queryKey: ['funnel-data', companyId, startDate?.toISOString(), endDate?.toISOString(), uniqueOnly, adsOnly],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_tracking_funnel_counts', {
        _company_id: companyId && companyId !== 'all' ? companyId : null,
        _start_at: normalizeDateRangeBoundary(startDate, 'start'),
        _end_at: normalizeDateRangeBoundary(endDate, 'end'),
        _unique_only: uniqueOnly,
        _ads_only: adsOnly,
      });

      if (error) {
        console.error('[FunnelData] Query error:', error.message ?? error);
        throw error;
      }

      const countsByStep = new Map<FunnelStep, number>();
      for (const row of ((data ?? []) as TrackingFunnelCountRow[])) {
        if (!isFunnelStep(row.step)) continue;
        countsByStep.set(row.step, Number(row.event_count ?? 0));
      }

      const points = FUNNEL_STEPS.map((step) => ({
        step,
        count: countsByStep.get(step) ?? 0,
      }));

      return {
        points,
      };
    },
    enabled: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
