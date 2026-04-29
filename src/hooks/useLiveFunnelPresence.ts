import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type LiveFunnelStage = 'page_view' | 'date_select' | 'time_select' | 'form_fill' | 'completed';

interface LiveFunnelPresenceData {
  totalActive: number;
  windowMinutes: number;
  stages: Array<{
    count: number;
    stage: LiveFunnelStage;
  }>;
}

const LIVE_WINDOW_MINUTES = 5;
const LIVE_STAGES: LiveFunnelStage[] = ['page_view', 'date_select', 'time_select', 'form_fill', 'completed'];

interface LiveFunnelPresenceRow {
  stage: string | null;
  stage_count: number | string | null;
  total_active: number | string | null;
  window_minutes: number | string | null;
}

function isLiveFunnelStage(value: string | null): value is LiveFunnelStage {
  return LIVE_STAGES.includes(value as LiveFunnelStage);
}

export function useLiveFunnelPresence(companyId?: string) {
  return useQuery<LiveFunnelPresenceData>({
    queryKey: ['live-funnel-presence', companyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_live_funnel_presence', {
        _company_id: companyId && companyId !== 'all' ? companyId : null,
        _window_minutes: LIVE_WINDOW_MINUTES,
      });

      if (error) {
        console.error('[LiveFunnelPresence] Query error:', error.message ?? error);
        throw error;
      }

      const counts = new Map<LiveFunnelStage, number>(
        LIVE_STAGES.map((stage) => [stage, 0]),
      );
      const rows = ((data ?? []) as LiveFunnelPresenceRow[]);
      const firstRow = rows[0];

      for (const row of rows) {
        if (!isLiveFunnelStage(row.stage)) continue;
        counts.set(row.stage, Number(row.stage_count ?? 0));
      }

      return {
        totalActive: Number(firstRow?.total_active ?? 0),
        windowMinutes: Number(firstRow?.window_minutes ?? LIVE_WINDOW_MINUTES),
        stages: LIVE_STAGES.map((stage) => ({
          stage,
          count: counts.get(stage) ?? 0,
        })),
      };
    },
    enabled: true,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
}
