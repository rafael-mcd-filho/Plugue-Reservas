import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ReportGranularity } from '@/lib/report-filters';

export interface OccupancyWaitlistSeriesPoint {
  period: string;
  entries: number;
  entry_people: number;
  seated: number;
  seated_people: number;
  dropped: number;
  dropped_people: number;
  average_wait_minutes: number;
}

export interface OccupancyWaitlistSeries {
  series: OccupancyWaitlistSeriesPoint[];
  meta: {
    period_start: string;
    period_end: string;
    time_zone: string;
    granularity: ReportGranularity;
    event_semantics: 'event_timestamp';
    generated_at: string;
  };
}

export interface OccupancyWaitlistSeriesParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  granularity: ReportGranularity;
  enabled?: boolean;
}

const COUNT_KEYS = ['entries', 'entry_people', 'seated', 'seated_people', 'dropped', 'dropped_people'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('count');
  return parsed;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('number');
  return parsed;
}

export function buildOccupancyWaitlistSeriesRpcParams(params: OccupancyWaitlistSeriesParams) {
  return {
    _company_id: params.companyId,
    _start_date: params.periodStart,
    _end_date: params.periodEnd,
    _granularity: params.granularity,
  };
}

export function normalizeOccupancyWaitlistSeries(
  payload: unknown,
  expected: ReturnType<typeof buildOccupancyWaitlistSeriesRpcParams>,
): OccupancyWaitlistSeries {
  try {
    if (!isRecord(payload) || !isRecord(payload.meta) || !Array.isArray(payload.series)) throw new Error('payload');
    const series = payload.series.map((value): OccupancyWaitlistSeriesPoint => {
      if (!isRecord(value) || !isIsoDate(value.period)) throw new Error('point');
      const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, toCount(value[key])])) as Record<(typeof COUNT_KEYS)[number], number>;
      return { period: value.period, ...counts, average_wait_minutes: toNumber(value.average_wait_minutes) };
    });
    if (series.some((point, index) => index > 0 && point.period <= series[index - 1].period)) throw new Error('order');

    const meta = payload.meta;
    if (meta.period_start !== expected._start_date || meta.period_end !== expected._end_date
      || meta.granularity !== expected._granularity || meta.event_semantics !== 'event_timestamp'
      || typeof meta.time_zone !== 'string' || !meta.time_zone
      || typeof meta.generated_at !== 'string' || Number.isNaN(Date.parse(meta.generated_at))) throw new Error('meta');

    return {
      series,
      meta: {
        period_start: meta.period_start as string,
        period_end: meta.period_end as string,
        time_zone: meta.time_zone,
        granularity: meta.granularity as ReportGranularity,
        event_semantics: 'event_timestamp',
        generated_at: meta.generated_at,
      },
    };
  } catch (error) {
    throw new Error('A serie temporal da fila retornou dados incompletos ou invalidos.', { cause: error });
  }
}

export function useOccupancyWaitlistSeries(params: OccupancyWaitlistSeriesParams) {
  const rpcParams = buildOccupancyWaitlistSeriesRpcParams(params);
  return useQuery({
    queryKey: ['occupancy-waitlist-series', rpcParams._company_id, rpcParams._start_date, rpcParams._end_date, rpcParams._granularity],
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_occupancy_waitlist_series', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeOccupancyWaitlistSeries(data, rpcParams);
    },
    enabled: (params.enabled ?? true) && !!params.companyId && !!params.periodStart && !!params.periodEnd,
    retry: 1,
    retryDelay: 750,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
