export const ATTENDANCE_LOSSES_PAGE_SIZE_MAX = 100;
export const ATTENDANCE_LOSSES_SEARCH_MAX_LENGTH = 200;

export const ATTENDANCE_OUTCOMES = [
  'all',
  'attended',
  'no_show',
  'cancelled',
  'scheduled',
] as const;

export const ATTENDANCE_ENTRY_METHODS = [
  'all',
  'online',
  'affiliate',
  'manual',
  'waitlist',
] as const;

export type AttendanceOutcomeFilter = typeof ATTENDANCE_OUTCOMES[number];
export type AttendanceOutcome = Exclude<AttendanceOutcomeFilter, 'all'>;
export type AttendanceEntryMethodFilter = typeof ATTENDANCE_ENTRY_METHODS[number];
export type AttendanceEntryMethod = Exclude<AttendanceEntryMethodFilter, 'all'>;
export type AttendanceSegmentDimension =
  | 'weekday'
  | 'time_band'
  | 'party_size'
  | 'lead_time'
  | 'entry_method';

export interface AttendanceLossesSummary {
  reservations: number;
  attended: number;
  no_show: number;
  cancelled: number;
  scheduled: number;
  reserved_people: number;
  attended_people: number;
  lost_people: number;
  attendance_rate: number;
  no_show_rate: number;
  loss_rate: number;
}

export interface AttendanceLossesComparison extends AttendanceLossesSummary {
  period_start: string;
  period_end: string;
}

export interface AttendanceLossesSeriesPoint extends AttendanceLossesSummary {
  date: string;
}

export interface AttendanceLossesSegment extends AttendanceLossesSummary {
  key: string;
  label: string;
  sort_order: number;
}

export interface AttendanceLossesAssociation extends AttendanceLossesSummary {
  key: 'with' | 'without';
  label: string;
  evolution_reservations?: number;
  pluguechat_reservations?: number;
}

export interface AttendanceCancellationBucket {
  key: string;
  label: string;
  sort_order: number;
  reservations: number;
  people: number;
  percentage: number;
}

export interface AttendanceCancellationCurve {
  coverage_start: string | null;
  cancelled_total: number;
  cancelled_with_audit: number;
  coverage_percentage: number;
  buckets: AttendanceCancellationBucket[];
}

export interface AttendanceLossesReservationRow {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  source: string | null;
  origin_affiliate_code: string | null;
  origin_affiliate_name: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  occasion: string | null;
  notes: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  created_at: string;
  updated_at: string;
  public_tracking_code: string;
  outcome: AttendanceOutcome;
  entry_method: AttendanceEntryMethod;
  lead_days: number;
  cancelled_at: string | null;
  cancellation_lead_hours: number | null;
  whatsapp_evolution: boolean;
  whatsapp_pluguechat: boolean;
  has_whatsapp: boolean;
  has_prepayment: boolean;
}

export interface AttendanceLossesMeta {
  period_start: string;
  period_end: string;
  comparison_enabled: boolean;
  comparison_start: string | null;
  comparison_end: string | null;
  time_zone: string;
  page: number;
  page_size: number;
  reservations_total: number;
  filtered_reservations_total: number;
  outcome: AttendanceOutcomeFilter;
  entry_method: AttendanceEntryMethodFilter;
  search: string | null;
  generated_at: string;
}

export interface AttendanceLossesReport {
  summary: AttendanceLossesSummary;
  comparison: AttendanceLossesComparison | null;
  daily_series: AttendanceLossesSeriesPoint[];
  segments: Record<AttendanceSegmentDimension, AttendanceLossesSegment[]>;
  associations: {
    whatsapp: AttendanceLossesAssociation[];
    prepayment: AttendanceLossesAssociation[];
  };
  cancellation_curve: AttendanceCancellationCurve;
  reservations: AttendanceLossesReservationRow[];
  meta: AttendanceLossesMeta;
}

export interface AttendanceLossesReportParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  outcome?: AttendanceOutcomeFilter;
  entryMethod?: AttendanceEntryMethodFilter;
  page?: number;
  pageSize?: number;
  search?: string;
  comparisonEnabled?: boolean;
  enabled?: boolean;
}

export type AttendanceSeriesGranularity = 'day' | 'week' | 'month';

function getSeriesBucket(date: string, granularity: AttendanceSeriesGranularity): string {
  if (granularity === 'day') return date;
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;

  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
  return parsed.toISOString().slice(0, 10);
}

export function aggregateAttendanceLossesSeries(
  points: AttendanceLossesSeriesPoint[],
  granularity: AttendanceSeriesGranularity,
): AttendanceLossesSeriesPoint[] {
  if (granularity === 'day') return points;

  const buckets = new Map<string, Omit<AttendanceLossesSeriesPoint, 'attendance_rate' | 'no_show_rate' | 'loss_rate'>>();
  for (const point of points) {
    const date = getSeriesBucket(point.date, granularity);
    const current = buckets.get(date) ?? {
      date,
      reservations: 0,
      attended: 0,
      no_show: 0,
      cancelled: 0,
      scheduled: 0,
      reserved_people: 0,
      attended_people: 0,
      lost_people: 0,
    };
    for (const key of COUNT_KEYS) current[key] += point[key];
    buckets.set(date, current);
  }

  return [...buckets.values()].map((bucket) => {
    const attendanceBase = bucket.attended + bucket.no_show;
    const lossBase = attendanceBase + bucket.cancelled;
    return {
      ...bucket,
      attendance_rate: attendanceBase ? Math.round((1000 * bucket.attended) / attendanceBase) / 10 : 0,
      no_show_rate: attendanceBase ? Math.round((1000 * bucket.no_show) / attendanceBase) / 10 : 0,
      loss_rate: lossBase ? Math.round((1000 * (bucket.no_show + bucket.cancelled)) / lossBase) / 10 : 0,
    };
  });
}

const SUMMARY_KEYS = [
  'reservations',
  'attended',
  'no_show',
  'cancelled',
  'scheduled',
  'reserved_people',
  'attended_people',
  'lost_people',
  'attendance_rate',
  'no_show_rate',
  'loss_rate',
] as const;

const COUNT_KEYS = [
  'reservations',
  'attended',
  'no_show',
  'cancelled',
  'scheduled',
  'reserved_people',
  'attended_people',
  'lost_people',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AttendanceLossesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttendanceLossesValidationError';
  }
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('numeric');
  return parsed;
}

function asInteger(value: unknown): number {
  const parsed = asNumber(value);
  if (!Number.isInteger(parsed)) throw new Error('integer');
  return parsed;
}

function asString(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || (!nullable && value.length === 0)) throw new Error('string');
  return value;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('boolean');
  return value;
}

function normalizeSummary(value: unknown): AttendanceLossesSummary {
  if (!isRecord(value) || SUMMARY_KEYS.some((key) => !(key in value))) throw new Error('summary');

  const summary = Object.fromEntries(SUMMARY_KEYS.map((key) => [key, asNumber(value[key])])) as unknown as AttendanceLossesSummary;
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(summary[key])) throw new Error('count');
  }
  for (const key of ['attendance_rate', 'no_show_rate', 'loss_rate'] as const) {
    if (summary[key] > 100) throw new Error('rate');
  }
  return summary;
}

function normalizeSegment(value: unknown): AttendanceLossesSegment {
  if (!isRecord(value)) throw new Error('segment');
  return {
    key: asString(value.key)!,
    label: asString(value.label)!,
    sort_order: asInteger(value.sort_order),
    ...normalizeSummary(value),
  };
}

function normalizeAssociation(value: unknown): AttendanceLossesAssociation {
  if (!isRecord(value) || (value.key !== 'with' && value.key !== 'without')) throw new Error('association');
  return {
    key: value.key,
    label: asString(value.label)!,
    ...normalizeSummary(value),
    ...(value.evolution_reservations === undefined ? {} : { evolution_reservations: asInteger(value.evolution_reservations) }),
    ...(value.pluguechat_reservations === undefined ? {} : { pluguechat_reservations: asInteger(value.pluguechat_reservations) }),
  };
}

function isOutcome(value: unknown): value is AttendanceOutcome {
  return value === 'attended' || value === 'no_show' || value === 'cancelled' || value === 'scheduled';
}

function isEntryMethod(value: unknown): value is AttendanceEntryMethod {
  return value === 'online' || value === 'affiliate' || value === 'manual' || value === 'waitlist';
}

export function normalizeAttendanceLossesSearch(value: string | null | undefined): string {
  return (value ?? '').trim().slice(0, ATTENDANCE_LOSSES_SEARCH_MAX_LENGTH);
}

export function normalizeAttendanceLossesReservation(value: unknown): AttendanceLossesReservationRow {
  if (!isRecord(value) || !isOutcome(value.outcome) || !isEntryMethod(value.entry_method)) {
    throw new Error('reservation');
  }

  const nullableString = (key: string) => asString(value[key], true);
  const nullableNumber = (key: string) => value[key] === null ? null : asNumber(value[key]);
  const checkedInPartySize = value.checked_in_party_size === null
    ? null
    : asInteger(value.checked_in_party_size);

  return {
    id: asString(value.id)!,
    company_id: asString(value.company_id)!,
    guest_name: asString(value.guest_name)!,
    guest_phone: asString(value.guest_phone)!,
    guest_email: nullableString('guest_email'),
    source: nullableString('source'),
    origin_affiliate_code: nullableString('origin_affiliate_code'),
    origin_affiliate_name: nullableString('origin_affiliate_name'),
    date: asString(value.date)!,
    time: asString(value.time)!,
    party_size: asInteger(value.party_size),
    status: asString(value.status)!,
    occasion: nullableString('occasion'),
    notes: nullableString('notes'),
    checked_in_at: nullableString('checked_in_at'),
    checked_in_party_size: checkedInPartySize,
    created_at: asString(value.created_at)!,
    updated_at: asString(value.updated_at)!,
    public_tracking_code: asString(value.public_tracking_code)!,
    outcome: value.outcome,
    entry_method: value.entry_method,
    lead_days: asInteger(value.lead_days),
    cancelled_at: nullableString('cancelled_at'),
    cancellation_lead_hours: nullableNumber('cancellation_lead_hours'),
    whatsapp_evolution: asBoolean(value.whatsapp_evolution),
    whatsapp_pluguechat: asBoolean(value.whatsapp_pluguechat),
    has_whatsapp: asBoolean(value.has_whatsapp),
    has_prepayment: asBoolean(value.has_prepayment),
  };
}

export function buildAttendanceLossesRpcParams(params: AttendanceLossesReportParams) {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(
    ATTENDANCE_LOSSES_PAGE_SIZE_MAX,
    Math.max(1, Math.floor(params.pageSize ?? 20)),
  );
  const search = normalizeAttendanceLossesSearch(params.search);

  return {
    _company_id: params.companyId,
    _period_start: params.periodStart,
    _period_end: params.periodEnd,
    _outcome: params.outcome ?? 'all',
    _entry_method: params.entryMethod ?? 'all',
    _page: page,
    _page_size: pageSize,
    _search: search || null,
    _include_comparison: params.comparisonEnabled ?? true,
  };
}

export function buildAttendanceLossesQueryKey(params: AttendanceLossesReportParams) {
  const rpc = buildAttendanceLossesRpcParams(params);
  return [
    'attendance-losses-report',
    rpc._company_id,
    rpc._period_start,
    rpc._period_end,
    rpc._outcome,
    rpc._entry_method,
    rpc._page,
    rpc._page_size,
    rpc._search ?? '',
    rpc._include_comparison,
  ] as const;
}

export function normalizeAttendanceLossesReport(
  payload: unknown,
  expected: ReturnType<typeof buildAttendanceLossesRpcParams>,
): AttendanceLossesReport {
  try {
    if (!isRecord(payload)) throw new Error('payload');
    if (!isRecord(payload.segments) || !isRecord(payload.associations)) {
      throw new Error('sections');
    }
    if (expected._include_comparison ? !isRecord(payload.comparison) : payload.comparison !== null) {
      throw new Error('comparison');
    }
    if (!isRecord(payload.cancellation_curve) || !isRecord(payload.meta)) throw new Error('meta');

    const meta = payload.meta;
    if (
      meta.period_start !== expected._period_start
      || meta.period_end !== expected._period_end
      || meta.outcome !== expected._outcome
      || meta.entry_method !== expected._entry_method
      || meta.page !== expected._page
      || meta.page_size !== expected._page_size
      || (meta.search ?? null) !== expected._search
      || meta.comparison_enabled !== expected._include_comparison
    ) throw new Error('request mismatch');

    const reservations = Array.isArray(payload.reservations)
      ? payload.reservations.map(normalizeAttendanceLossesReservation)
      : (() => { throw new Error('reservations'); })();
    const filteredTotal = asInteger(meta.filtered_reservations_total);
    const expectedPageRows = Math.max(
      0,
      Math.min(expected._page_size, filteredTotal - ((expected._page - 1) * expected._page_size)),
    );
    if (reservations.length !== expectedPageRows || new Set(reservations.map((row) => row.id)).size !== reservations.length) {
      throw new Error('truncated page');
    }

    const normalizeSegments = (key: AttendanceSegmentDimension) => {
      const rows = payload.segments[key];
      if (!Array.isArray(rows)) throw new Error(`segment ${key}`);
      return rows.map(normalizeSegment);
    };
    const associations = payload.associations;
    const whatsapp = associations.whatsapp;
    const prepayment = associations.prepayment;
    if (!Array.isArray(whatsapp) || !Array.isArray(prepayment)) throw new Error('associations');

    const curve = payload.cancellation_curve;
    if (!Array.isArray(curve.buckets)) throw new Error('curve');
    const daily = Array.isArray(payload.daily_series) ? payload.daily_series : (() => { throw new Error('daily'); })();

    return {
      summary: normalizeSummary(payload.summary),
      comparison: expected._include_comparison && isRecord(payload.comparison) ? {
        ...normalizeSummary(payload.comparison),
        period_start: asString(payload.comparison.period_start)!,
        period_end: asString(payload.comparison.period_end)!,
      } : null,
      daily_series: daily.map((row) => {
        if (!isRecord(row)) throw new Error('daily row');
        return { date: asString(row.date)!, ...normalizeSummary(row) };
      }),
      segments: {
        weekday: normalizeSegments('weekday'),
        time_band: normalizeSegments('time_band'),
        party_size: normalizeSegments('party_size'),
        lead_time: normalizeSegments('lead_time'),
        entry_method: normalizeSegments('entry_method'),
      },
      associations: {
        whatsapp: whatsapp.map(normalizeAssociation),
        prepayment: prepayment.map(normalizeAssociation),
      },
      cancellation_curve: {
        coverage_start: asString(curve.coverage_start, true),
        cancelled_total: asInteger(curve.cancelled_total),
        cancelled_with_audit: asInteger(curve.cancelled_with_audit),
        coverage_percentage: asNumber(curve.coverage_percentage),
        buckets: curve.buckets.map((row) => {
          if (!isRecord(row)) throw new Error('curve bucket');
          return {
            key: asString(row.key)!,
            label: asString(row.label)!,
            sort_order: asInteger(row.sort_order),
            reservations: asInteger(row.reservations),
            people: asInteger(row.people),
            percentage: asNumber(row.percentage),
          };
        }),
      },
      reservations,
      meta: {
        period_start: asString(meta.period_start)!,
        period_end: asString(meta.period_end)!,
        comparison_enabled: asBoolean(meta.comparison_enabled),
        comparison_start: asString(meta.comparison_start, true),
        comparison_end: asString(meta.comparison_end, true),
        time_zone: asString(meta.time_zone)!,
        page: asInteger(meta.page),
        page_size: asInteger(meta.page_size),
        reservations_total: asInteger(meta.reservations_total),
        filtered_reservations_total: filteredTotal,
        outcome: meta.outcome as AttendanceOutcomeFilter,
        entry_method: meta.entry_method as AttendanceEntryMethodFilter,
        search: asString(meta.search, true),
        generated_at: asString(meta.generated_at)!,
      },
    };
  } catch {
    throw new AttendanceLossesValidationError(
      'O relatório de comparecimento retornou dados incompletos ou inválidos.',
    );
  }
}
