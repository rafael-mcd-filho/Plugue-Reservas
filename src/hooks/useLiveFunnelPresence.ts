import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type LiveFunnelStage = 'page_view' | 'date_select' | 'time_select' | 'form_fill' | 'completed';

interface TrackingEventPresenceRow {
  anonymous_id: string;
  event_name: string;
  occurred_at: string;
  session_id: string | null;
}

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

function mapEventToStage(eventName: string): LiveFunnelStage | null {
  if (eventName === 'reservation_created') return 'completed';
  if (eventName === 'form_fill' || eventName === 'lead_captured') return 'form_fill';
  if (eventName === 'time_select') return 'time_select';
  if (eventName === 'date_select' || eventName === 'booking_started') return 'date_select';
  if (eventName === 'page_view') return 'page_view';
  return null;
}

function buildPresenceKey(row: TrackingEventPresenceRow) {
  return row.session_id
    ? `session:${row.session_id}`
    : `anonymous:${row.anonymous_id}`;
}

export function useLiveFunnelPresence(companyId?: string) {
  return useQuery<LiveFunnelPresenceData>({
    queryKey: ['live-funnel-presence', companyId],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - LIVE_WINDOW_MINUTES * 60 * 1000).toISOString();

      let query = supabase
        .from('tracking_events' as any)
        .select('event_name, session_id, anonymous_id, occurred_at')
        .eq('tracking_source', 'public')
        .gte('occurred_at', cutoff);

      if (companyId && companyId !== 'all') {
        query = query.eq('company_id', companyId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[LiveFunnelPresence] Query error:', error.message ?? error);
        throw error;
      }

      const latestByKey = new Map<string, { occurredAt: string; stage: LiveFunnelStage }>();

      for (const row of (data ?? []) as TrackingEventPresenceRow[]) {
        const stage = mapEventToStage(row.event_name);
        if (!stage) continue;

        const key = buildPresenceKey(row);
        const existing = latestByKey.get(key);

        if (!existing || row.occurred_at > existing.occurredAt) {
          latestByKey.set(key, {
            occurredAt: row.occurred_at,
            stage,
          });
        }
      }

      const counts = new Map<LiveFunnelStage, number>(
        LIVE_STAGES.map((stage) => [stage, 0]),
      );

      for (const entry of latestByKey.values()) {
        counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
      }

      return {
        totalActive: latestByKey.size,
        windowMinutes: LIVE_WINDOW_MINUTES,
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
