import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ReportGranularity } from '@/lib/report-filters';

export interface CustomerRecurrenceVisitSeriesPoint {
  period: string;
  total_visits: number;
  first_visits: number;
  return_visits: number;
  return_visit_rate: number;
}

export interface CustomerRecurrenceVisitSeriesParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  granularity: ReportGranularity;
  includeCompanions: boolean;
  enabled?: boolean;
}

export interface CustomerRecurrenceVisitSeries {
  series: CustomerRecurrenceVisitSeriesPoint[];
  meta: {
    period_start: string;
    period_end: string;
    time_zone: string;
    granularity: ReportGranularity;
    include_companions: boolean;
    visit_definition: 'canonical_attended_visit';
    generated_at: string;
  };
}

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

function toRate(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error('rate');
  return parsed;
}

export function buildCustomerRecurrenceVisitSeriesRpcParams(params: CustomerRecurrenceVisitSeriesParams) {
  return {
    _company_id: params.companyId,
    _period_start: params.periodStart,
    _period_end: params.periodEnd,
    _granularity: params.granularity,
    _include_companions: params.includeCompanions,
  };
}

export function normalizeCustomerRecurrenceVisitSeries(
  payload: unknown,
  expected: ReturnType<typeof buildCustomerRecurrenceVisitSeriesRpcParams>,
): CustomerRecurrenceVisitSeries {
  try {
    if (!isRecord(payload) || !isRecord(payload.meta) || !Array.isArray(payload.series)) throw new Error('payload');
    const series = payload.series.map((value): CustomerRecurrenceVisitSeriesPoint => {
      if (!isRecord(value) || !isIsoDate(value.period)) throw new Error('point');
      const point = {
        period: value.period,
        total_visits: toCount(value.total_visits),
        first_visits: toCount(value.first_visits),
        return_visits: toCount(value.return_visits),
        return_visit_rate: toRate(value.return_visit_rate),
      };
      const expectedRate = point.total_visits === 0
        ? 0
        : Math.round((1000 * point.return_visits) / point.total_visits) / 10;
      if (point.total_visits !== point.first_visits + point.return_visits
        || point.return_visit_rate !== expectedRate) throw new Error('formula');
      return point;
    });
    if (series.some((point, index) => index > 0 && point.period <= series[index - 1].period)) throw new Error('order');

    const meta = payload.meta;
    if (meta.period_start !== expected._period_start || meta.period_end !== expected._period_end
      || meta.granularity !== expected._granularity || meta.include_companions !== expected._include_companions
      || meta.visit_definition !== 'canonical_attended_visit'
      || typeof meta.time_zone !== 'string' || !meta.time_zone
      || typeof meta.generated_at !== 'string' || Number.isNaN(Date.parse(meta.generated_at))) throw new Error('meta');

    return { series, meta: meta as CustomerRecurrenceVisitSeries['meta'] };
  } catch (error) {
    throw new Error('A evolucao de recorrencia retornou dados incompletos ou invalidos.', { cause: error });
  }
}

export function useCustomerRecurrenceVisitSeries(params: CustomerRecurrenceVisitSeriesParams) {
  const rpcParams = buildCustomerRecurrenceVisitSeriesRpcParams(params);
  return useQuery({
    queryKey: [
      'customer-recurrence-visit-series', rpcParams._company_id, rpcParams._period_start,
      rpcParams._period_end, rpcParams._granularity, rpcParams._include_companions,
    ],
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_customer_recurrence_visit_series', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeCustomerRecurrenceVisitSeries(data, rpcParams);
    },
    enabled: (params.enabled ?? true) && !!params.companyId && !!params.periodStart && !!params.periodEnd,
    retry: 1,
    retryDelay: 750,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
