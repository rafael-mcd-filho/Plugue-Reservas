import { useQuery } from '@tanstack/react-query';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import { getAttributionString, hasPaidAttribution, isPaidTrafficMarker } from '@/lib/trackingAttribution';

export interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

interface TrackingEventRow {
  anonymous_id: string;
  event_name: string;
  journey_id: string | null;
  occurred_at: string | null;
  reservation_id: string | null;
  session_id: string | null;
}

interface TrackingSessionAttributionRow {
  id: string;
  utm_medium: string | null;
}

interface ReservationAttributionRow {
  attribution_snapshot: Record<string, unknown> | null;
  id: string;
}

export interface FunnelAdsDebugEntry {
  anonymous_id: string;
  event_name: string;
  journey_id: string | null;
  matched_via: 'tracking_session' | 'reservation_snapshot';
  occurred_at: string | null;
  reservation_id: string | null;
  reservation_utm_medium: string | null;
  session_id: string | null;
  session_utm_medium: string | null;
}

export interface FunnelAdsDebugData {
  adsReservations: Array<{ id: string; utm_medium: string | null }>;
  adsSessions: Array<{ id: string; utm_medium: string | null }>;
  completedRows: FunnelAdsDebugEntry[];
  matchedRowCount: number;
}

export interface FunnelQueryResult {
  adsDebug: FunnelAdsDebugData | null;
  points: FunnelDataPoint[];
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
      let query = supabase
        .from('tracking_events' as any)
        .select('event_name, session_id, journey_id, reservation_id, anonymous_id, occurred_at')
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
      let filteredRows = rows;
      let adsDebug: FunnelAdsDebugData | null = null;

      if (adsOnly) {
        const sessionIds = Array.from(new Set(
          rows
            .map((row) => row.session_id)
            .filter((value): value is string => !!value),
        ));
        const reservationIds = Array.from(new Set(
          rows
            .filter((row) => !row.session_id)
            .map((row) => row.reservation_id)
            .filter((value): value is string => !!value),
        ));

        const [sessionResult, reservationResult] = await Promise.all([
          sessionIds.length > 0
            ? supabase
              .from('tracking_sessions' as any)
              .select('id, utm_medium')
              .in('id', sessionIds)
            : Promise.resolve({ data: [] as TrackingSessionAttributionRow[], error: null }),
          reservationIds.length > 0
            ? supabase
              .from('reservations' as any)
              .select('id, attribution_snapshot')
              .in('id', reservationIds)
            : Promise.resolve({ data: [] as ReservationAttributionRow[], error: null }),
        ]);

        if (sessionResult.error) {
          console.error('[FunnelData] Session attribution query error:', sessionResult.error.message ?? sessionResult.error);
          throw sessionResult.error;
        }

        if (reservationResult.error) {
          console.error('[FunnelData] Reservation attribution query error:', reservationResult.error.message ?? reservationResult.error);
          throw reservationResult.error;
        }

        const adsSessionIds = new Set(
          ((sessionResult.data ?? []) as TrackingSessionAttributionRow[])
            .filter((session) => isPaidTrafficMarker(session.utm_medium))
            .map((session) => session.id),
        );
        const sessionUtmMediumById = new Map(
          ((sessionResult.data ?? []) as TrackingSessionAttributionRow[]).map((session) => [
            session.id,
            session.utm_medium,
          ]),
        );

        const adsReservationIds = new Set(
          ((reservationResult.data ?? []) as ReservationAttributionRow[])
            .filter((reservation) => hasPaidAttribution(reservation.attribution_snapshot))
            .map((reservation) => reservation.id),
        );
        const reservationUtmMediumById = new Map(
          ((reservationResult.data ?? []) as ReservationAttributionRow[]).map((reservation) => [
            reservation.id,
            getAttributionString(reservation.attribution_snapshot, 'utm_medium'),
          ]),
        );

        filteredRows = rows.filter((row) => {
          if (row.session_id) {
            return adsSessionIds.has(row.session_id);
          }

          if (row.reservation_id) {
            return adsReservationIds.has(row.reservation_id);
          }

          return false;
        });

        const completedRowsMap = new Map<string, FunnelAdsDebugEntry>();

        for (const row of filteredRows.filter((item) => matchesStep('completed', item))) {
          const matchedVia = row.session_id
            ? 'tracking_session'
            : 'reservation_snapshot';
          const entry: FunnelAdsDebugEntry = {
            anonymous_id: row.anonymous_id,
            event_name: row.event_name,
            journey_id: row.journey_id,
            matched_via: matchedVia,
            occurred_at: row.occurred_at,
            reservation_id: row.reservation_id,
            reservation_utm_medium: row.reservation_id
              ? reservationUtmMediumById.get(row.reservation_id) ?? null
              : null,
            session_id: row.session_id,
            session_utm_medium: row.session_id
              ? sessionUtmMediumById.get(row.session_id) ?? null
              : null,
          };
          const entryKey = `${entry.reservation_id ?? 'no-reservation'}|${entry.session_id ?? 'no-session'}|${entry.anonymous_id}`;
          if (!completedRowsMap.has(entryKey)) {
            completedRowsMap.set(entryKey, entry);
          }
        }

        adsDebug = {
          adsReservations: Array.from(adsReservationIds).sort().map((id) => ({
            id,
            utm_medium: reservationUtmMediumById.get(id) ?? null,
          })),
          adsSessions: Array.from(adsSessionIds).sort().map((id) => ({
            id,
            utm_medium: sessionUtmMediumById.get(id) ?? null,
          })),
          completedRows: Array.from(completedRowsMap.values()).sort((left, right) =>
            (right.occurred_at ?? '').localeCompare(left.occurred_at ?? ''),
          ),
          matchedRowCount: filteredRows.length,
        };
      }

      const points = FUNNEL_STEPS.map((step) => {
        const identities = new Set(
          filteredRows
            .filter((row) => matchesStep(step, row))
            .map((row) => (uniqueOnly ? row.anonymous_id : buildDefaultIdentityKey(step, row))),
        );

        return {
          step,
          count: identities.size,
        };
      });

      return {
        points,
        adsDebug,
      };
    },
    enabled: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
