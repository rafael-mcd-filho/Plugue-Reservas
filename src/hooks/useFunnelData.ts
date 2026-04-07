import { useQuery } from '@tanstack/react-query';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';

interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

interface TrackingEventRow {
  anonymous_id: string;
  event_name: string;
  journey_id: string | null;
  reservation_id: string | null;
  session_id: string | null;
}

function matchesStep(step: FunnelStep, row: TrackingEventRow) {
  if (step === 'page_view') return row.event_name === 'page_view';
  if (step === 'date_select') return row.event_name === 'date_select';
  if (step === 'time_select') return row.event_name === 'time_select';
  if (step === 'form_fill') return row.event_name === 'form_fill' || row.event_name === 'lead_captured';
  return row.event_name === 'reservation_created';
}

function buildDefaultIdentityKey(step: FunnelStep, row: TrackingEventRow) {
  if (step === 'page_view') {
    return row.session_id ?? row.anonymous_id;
  }

  if (step === 'completed') {
    return row.reservation_id ?? row.journey_id ?? row.session_id ?? row.anonymous_id;
  }

  return row.journey_id ?? row.session_id ?? row.anonymous_id;
}

export function useFunnelData(companyId?: string, startDate?: Date, endDate?: Date, uniqueOnly = false) {
  return useQuery<FunnelDataPoint[]>({
    queryKey: ['funnel-data', companyId, startDate?.toISOString(), endDate?.toISOString(), uniqueOnly],
    queryFn: async () => {
      let query = supabase
        .from('tracking_events' as any)
        .select('event_name, session_id, journey_id, reservation_id, anonymous_id')
        .eq('tracking_source', 'public');

      if (companyId && companyId !== 'all') {
        query = query.eq('company_id', companyId);
      }

      if (startDate instanceof Date && !Number.isNaN(startDate.getTime())) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        query = query.gte('occurred_at', start.toISOString());
      }

      if (endDate instanceof Date && !Number.isNaN(endDate.getTime())) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query = query.lte('occurred_at', end.toISOString());
      }

      const { data, error } = await query;

      if (error) {
        console.error('[FunnelData] Query error:', error.message ?? error);
        throw error;
      }

      const rows = (data ?? []) as TrackingEventRow[];

      return FUNNEL_STEPS.map((step) => {
        const identities = new Set(
          rows
            .filter((row) => matchesStep(step, row))
            .map((row) => (uniqueOnly ? row.anonymous_id : buildDefaultIdentityKey(step, row))),
        );

        return {
          step,
          count: identities.size,
        };
      });
    },
    enabled: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
