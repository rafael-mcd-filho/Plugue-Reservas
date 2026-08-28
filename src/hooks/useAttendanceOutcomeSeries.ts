import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ReportGranularity } from '@/lib/report-filters';
import {
  type AttendanceEntryMethodFilter,
  type AttendanceOutcomeFilter,
} from '@/lib/attendance-losses-report';

export interface AttendanceOutcomeSeriesPoint {
  period: string;
  reservations: number;
  attended: number;
  no_show: number;
  cancelled: number;
  scheduled: number;
  reserved_people: number;
  attended_people: number;
  no_show_people: number;
  cancelled_people: number;
  scheduled_people: number;
  lost_people: number;
  expected_reservations: number;
  realized_reservations: number;
  expected_people: number;
  realized_people: number;
  attendance_rate: number;
  no_show_rate: number;
  loss_rate: number;
  realized_reservation_rate: number;
  realized_people_rate: number;
}

export interface AttendanceOutcomeSeriesParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  granularity: ReportGranularity;
  outcome: AttendanceOutcomeFilter;
  entryMethod: AttendanceEntryMethodFilter;
  enabled?: boolean;
}

export interface AttendanceOutcomeSeries {
  series: AttendanceOutcomeSeriesPoint[];
  meta: {
    period_start: string;
    period_end: string;
    time_zone: string;
    granularity: ReportGranularity;
    outcome: AttendanceOutcomeFilter;
    entry_method: AttendanceEntryMethodFilter;
    attendance_rate_formula: 'attended / (attended + no_show)';
    realized_rate_formula: 'attended / all_reservations';
    generated_at: string;
  };
}

const COUNT_KEYS = [
  'reservations', 'attended', 'no_show', 'cancelled', 'scheduled',
  'reserved_people', 'attended_people', 'no_show_people', 'cancelled_people',
  'scheduled_people', 'lost_people', 'expected_reservations', 'realized_reservations',
  'expected_people', 'realized_people',
] as const;
const RATE_KEYS = ['attendance_rate', 'no_show_rate', 'loss_rate', 'realized_reservation_rate', 'realized_people_rate'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('number');
  return parsed;
}

function toCount(value: unknown): number {
  const parsed = toNumber(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('count');
  return parsed;
}

function roundRate(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : Math.round((1000 * numerator) / denominator) / 10;
}

export function buildAttendanceOutcomeSeriesRpcParams(params: AttendanceOutcomeSeriesParams) {
  return {
    _company_id: params.companyId,
    _period_start: params.periodStart,
    _period_end: params.periodEnd,
    _granularity: params.granularity,
    _outcome: params.outcome,
    _entry_method: params.entryMethod,
  };
}

export function normalizeAttendanceOutcomeSeries(
  payload: unknown,
  expected: ReturnType<typeof buildAttendanceOutcomeSeriesRpcParams>,
): AttendanceOutcomeSeries {
  try {
    if (!isRecord(payload) || !isRecord(payload.meta) || !Array.isArray(payload.series)) throw new Error('payload');
    const series = payload.series.map((value): AttendanceOutcomeSeriesPoint => {
      if (!isRecord(value) || !isIsoDate(value.period)) throw new Error('point');
      const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, toCount(value[key])])) as Record<(typeof COUNT_KEYS)[number], number>;
      const rates = Object.fromEntries(RATE_KEYS.map((key) => [key, toNumber(value[key])])) as Record<(typeof RATE_KEYS)[number], number>;
      if (rates.attendance_rate > 100
        || rates.no_show_rate > 100
        || rates.loss_rate > 100
        || rates.realized_reservation_rate > 100
        || counts.reservations !== counts.expected_reservations
        || counts.attended !== counts.realized_reservations
        || counts.reserved_people !== counts.expected_people
        || counts.attended_people !== counts.realized_people
        || counts.reservations !== counts.attended + counts.no_show + counts.cancelled + counts.scheduled
        || counts.lost_people !== counts.no_show_people + counts.cancelled_people
        || rates.attendance_rate !== roundRate(counts.attended, counts.attended + counts.no_show)
        || rates.no_show_rate !== roundRate(counts.no_show, counts.attended + counts.no_show)
        || rates.loss_rate !== roundRate(
          counts.no_show + counts.cancelled,
          counts.attended + counts.no_show + counts.cancelled,
        )
        || rates.realized_reservation_rate !== roundRate(counts.attended, counts.reservations)
        || rates.realized_people_rate !== roundRate(counts.attended_people, counts.reserved_people)) throw new Error('formula');
      return { period: value.period, ...counts, ...rates };
    });
    if (series.some((point, index) => index > 0 && point.period <= series[index - 1].period)) throw new Error('order');

    const meta = payload.meta;
    if (meta.period_start !== expected._period_start || meta.period_end !== expected._period_end
      || meta.granularity !== expected._granularity || meta.outcome !== expected._outcome
      || meta.entry_method !== expected._entry_method
      || meta.attendance_rate_formula !== 'attended / (attended + no_show)'
      || meta.realized_rate_formula !== 'attended / all_reservations'
      || typeof meta.time_zone !== 'string' || !meta.time_zone
      || typeof meta.generated_at !== 'string' || Number.isNaN(Date.parse(meta.generated_at))) throw new Error('meta');

    return {
      series,
      meta: meta as AttendanceOutcomeSeries['meta'],
    };
  } catch (error) {
    throw new Error('A evolucao de comparecimento retornou dados incompletos ou invalidos.', { cause: error });
  }
}

export function useAttendanceOutcomeSeries(params: AttendanceOutcomeSeriesParams) {
  const rpcParams = buildAttendanceOutcomeSeriesRpcParams(params);
  return useQuery({
    queryKey: [
      'attendance-outcome-series', rpcParams._company_id, rpcParams._period_start,
      rpcParams._period_end, rpcParams._granularity, rpcParams._outcome, rpcParams._entry_method,
    ],
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_attendance_outcome_series', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeAttendanceOutcomeSeries(data, rpcParams);
    },
    enabled: (params.enabled ?? true) && !!params.companyId && !!params.periodStart && !!params.periodEnd,
    retry: 1,
    retryDelay: 750,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
