import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ReportGranularity } from '@/lib/report-filters';

export interface DemandEntryModeTrendPoint {
  period: string;
  online_reservations: number;
  online_people: number;
  affiliate_reservations: number;
  affiliate_people: number;
  manual_reservations: number;
  manual_people: number;
  waitlist_reservations: number;
  waitlist_people: number;
}

export interface DemandLeadTimeTrendPoint {
  period: string;
  scheduled_reservations: number;
  average_lead_days: number;
  same_day_reservations: number;
  same_day_rate: number;
}

export interface DemandTemporalAnalysis {
  entry_mode_created_trend: DemandEntryModeTrendPoint[];
  entry_mode_visit_trend: DemandEntryModeTrendPoint[];
  lead_time_trend: DemandLeadTimeTrendPoint[];
  meta: {
    period_start: string;
    period_end: string;
    time_zone: string;
    granularity: ReportGranularity;
    generated_at: string;
  };
}

export interface DemandTemporalAnalysisParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  granularity: ReportGranularity;
  enabled?: boolean;
}

const ENTRY_COUNT_KEYS = [
  'online_reservations', 'online_people',
  'affiliate_reservations', 'affiliate_people',
  'manual_reservations', 'manual_people',
  'waitlist_reservations', 'waitlist_people',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

function normalizeEntryPoint(value: unknown): DemandEntryModeTrendPoint {
  if (!isRecord(value) || !isIsoDate(value.period)) throw new Error('entry point');
  const counts = Object.fromEntries(
    ENTRY_COUNT_KEYS.map((key) => [key, toCount(value[key])]),
  ) as Record<(typeof ENTRY_COUNT_KEYS)[number], number>;
  return { period: value.period, ...counts };
}

function normalizeLeadPoint(value: unknown): DemandLeadTimeTrendPoint {
  if (!isRecord(value) || !isIsoDate(value.period)) throw new Error('lead point');
  const point = {
    period: value.period,
    scheduled_reservations: toCount(value.scheduled_reservations),
    average_lead_days: toNumber(value.average_lead_days),
    same_day_reservations: toCount(value.same_day_reservations),
    same_day_rate: toNumber(value.same_day_rate),
  };
  const expectedRate = point.scheduled_reservations === 0
    ? 0
    : Math.round((1000 * point.same_day_reservations) / point.scheduled_reservations) / 10;
  if (
    point.same_day_reservations > point.scheduled_reservations
    || point.same_day_rate > 100
    || point.same_day_rate !== expectedRate
  ) throw new Error('lead formula');
  return point;
}

function assertOrderedPeriods(points: Array<{ period: string }>) {
  if (points.some((point, index) => index > 0 && point.period <= points[index - 1].period)) {
    throw new Error('period order');
  }
}

export function buildDemandTemporalAnalysisRpcParams(params: DemandTemporalAnalysisParams) {
  return {
    _company_id: params.companyId,
    _start_date: params.periodStart,
    _end_date: params.periodEnd,
    _granularity: params.granularity,
  };
}

export function normalizeDemandTemporalAnalysis(
  payload: unknown,
  expected: ReturnType<typeof buildDemandTemporalAnalysisRpcParams>,
): DemandTemporalAnalysis {
  try {
    if (!isRecord(payload) || !isRecord(payload.meta)
      || !Array.isArray(payload.entry_mode_created_trend)
      || !Array.isArray(payload.entry_mode_visit_trend)
      || !Array.isArray(payload.lead_time_trend)) throw new Error('payload');

    const created = payload.entry_mode_created_trend.map(normalizeEntryPoint);
    const visit = payload.entry_mode_visit_trend.map(normalizeEntryPoint);
    const lead = payload.lead_time_trend.map(normalizeLeadPoint);
    assertOrderedPeriods(created);
    assertOrderedPeriods(visit);
    assertOrderedPeriods(lead);

    const createdPeriods = created.map((point) => point.period).join('|');
    if (createdPeriods !== visit.map((point) => point.period).join('|')
      || createdPeriods !== lead.map((point) => point.period).join('|')) throw new Error('bucket mismatch');

    const meta = payload.meta;
    if (meta.period_start !== expected._start_date
      || meta.period_end !== expected._end_date
      || meta.granularity !== expected._granularity
      || typeof meta.time_zone !== 'string' || !meta.time_zone
      || typeof meta.generated_at !== 'string' || Number.isNaN(Date.parse(meta.generated_at))) {
      throw new Error('meta');
    }

    return {
      entry_mode_created_trend: created,
      entry_mode_visit_trend: visit,
      lead_time_trend: lead,
      meta: {
        period_start: meta.period_start as string,
        period_end: meta.period_end as string,
        time_zone: meta.time_zone,
        granularity: meta.granularity as ReportGranularity,
        generated_at: meta.generated_at,
      },
    };
  } catch (error) {
    throw new Error('A evolucao temporal de demanda retornou dados incompletos ou invalidos.', { cause: error });
  }
}

export function useDemandTemporalAnalysis(params: DemandTemporalAnalysisParams) {
  const rpcParams = buildDemandTemporalAnalysisRpcParams(params);
  return useQuery({
    queryKey: [
      'demand-temporal-analysis',
      rpcParams._company_id,
      rpcParams._start_date,
      rpcParams._end_date,
      rpcParams._granularity,
    ],
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_demand_temporal_analysis', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeDemandTemporalAnalysis(data, rpcParams);
    },
    enabled: (params.enabled ?? true) && !!params.companyId && !!params.periodStart && !!params.periodEnd,
    retry: 1,
    retryDelay: 750,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
