export const OCCUPANCY_CAPACITY_PAGE_SIZE_MAX = 100;

export const OCCUPANCY_CAPACITY_MODES = ['all', 'capacity', 'tables'] as const;
export const OCCUPANCY_CAPACITY_OUTCOMES = [
  'all',
  'scheduled',
  'checked_in',
  'no_show',
  'cancelled',
] as const;

export type OccupancyCapacityModeFilter = typeof OCCUPANCY_CAPACITY_MODES[number];
export type OccupancyCapacityMode = Exclude<OccupancyCapacityModeFilter, 'all'>;
export type OccupancyCapacityOutcomeFilter = typeof OCCUPANCY_CAPACITY_OUTCOMES[number];
export type OccupancyCapacityOutcome = Exclude<OccupancyCapacityOutcomeFilter, 'all'>;
export type OccupancyCapacityDataQuality = 'snapshot' | 'estimated_current_configuration' | 'mixed';
export type OccupancyCapacityHistory = OccupancyCapacityDataQuality | 'unavailable';
export type OccupancyCapacityGranularity = 'day' | 'week' | 'month';

export interface OccupancyCapacitySummary {
  published_capacity: number;
  slot_count: number;
  capacity_slots: number;
  table_slots: number;
  snapshot_slots: number;
  estimated_slots: number;
  reservations: number;
  reserved_people: number;
  checked_in_reservations: number;
  checked_in_people: number;
  no_show_reservations: number;
  no_show_people: number;
  unmatched_reservations: number;
  unmatched_people: number;
  capacity_pressure_rate: number;
  check_in_capacity_rate: number;
  waitlist_entries: number;
  waitlist_people: number;
  waitlist_seated: number;
  waitlist_dropped: number;
  average_wait_minutes: number;
}

export interface OccupancyCapacitySeriesPoint {
  period: string;
  published_capacity: number;
  slot_count: number;
  reservations: number;
  reserved_people: number;
  checked_in_reservations: number;
  checked_in_people: number;
  no_show_reservations: number;
  no_show_people: number;
  capacity_pressure_rate: number;
  check_in_capacity_rate: number;
}

export interface OccupancyCapacityHeatmapCell {
  weekday: number;
  weekday_label: string;
  time_slot: string;
  slot_count: number;
  published_capacity: number;
  reserved_people: number;
  checked_in_people: number;
  no_show_reservations: number;
  capacity_pressure_rate: number;
  check_in_capacity_rate: number;
  data_quality: OccupancyCapacityDataQuality;
}

export interface OccupancyCapacityWaitlistHour {
  hour: string;
  entries: number;
  people: number;
  seated: number;
  dropped: number;
  average_wait_minutes: number;
}

export interface OccupancyCapacityNoShowHour {
  hour: string;
  reservations: number;
  people: number;
  eligible_reservations: number;
  rate: number;
}

export interface OccupancyCapacityTableBreakdown {
  section_code: string | null;
  section_name: string;
  table_id: string;
  table_number: number;
  reservations: number;
  reserved_people: number;
  checked_in_reservations: number;
  checked_in_people: number;
}

export interface OccupancyCapacityTableAssignment {
  eligible_reservations: number;
  assigned_reservations: number;
  unassigned_reservations: number;
  coverage_rate: number;
}

export interface OccupancyCapacityReservationRow {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  outcome: OccupancyCapacityOutcome;
  availability_mode: OccupancyCapacityMode;
  published_capacity: number | null;
  data_quality: Exclude<OccupancyCapacityDataQuality, 'mixed'> | null;
  capacity_basis_available: boolean;
  counts_toward_capacity: boolean;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  table_id: string | null;
  table_number: number | null;
  section_code: string | null;
  section_name: string | null;
  created_at: string;
  public_tracking_code: string | null;
}

export interface OccupancyCapacityReportMeta {
  period_start: string;
  period_end: string;
  time_zone: string;
  granularity: OccupancyCapacityGranularity;
  page: number;
  page_size: number;
  details_total: number;
  unmatched_reservations: number;
  unmatched_people: number;
  availability_mode: OccupancyCapacityModeFilter;
  outcome: OccupancyCapacityOutcomeFilter;
  generated_at: string;
  capacity_history: OccupancyCapacityHistory;
  estimation_notice: string | null;
  unmatched_notice: string | null;
}

export interface OccupancyCapacityReport {
  summary: OccupancyCapacitySummary;
  series: OccupancyCapacitySeriesPoint[];
  heatmap: OccupancyCapacityHeatmapCell[];
  waitlist_by_hour: OccupancyCapacityWaitlistHour[];
  no_show_by_hour: OccupancyCapacityNoShowHour[];
  table_breakdown: OccupancyCapacityTableBreakdown[];
  table_assignment: OccupancyCapacityTableAssignment;
  details: OccupancyCapacityReservationRow[];
  meta: OccupancyCapacityReportMeta;
}

export interface OccupancyCapacityReportParams {
  companyId: string | undefined;
  periodStart: string;
  periodEnd: string;
  granularity?: OccupancyCapacityGranularity;
  page?: number;
  pageSize?: number;
  availabilityMode?: OccupancyCapacityModeFilter;
  outcome?: OccupancyCapacityOutcomeFilter;
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OccupancyCapacityValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OccupancyCapacityValidationError';
  }
}

function asNumber(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('numeric');
  return parsed;
}

function asInteger(value: unknown, nullable = false): number | null {
  const parsed = asNumber(value, nullable);
  if (parsed === null) return null;
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

function asRate(value: unknown): number {
  const parsed = asNumber(value) as number;
  return parsed;
}

function isMode(value: unknown): value is OccupancyCapacityMode {
  return value === 'capacity' || value === 'tables';
}

function isModeFilter(value: unknown): value is OccupancyCapacityModeFilter {
  return value === 'all' || isMode(value);
}

function isOutcome(value: unknown): value is OccupancyCapacityOutcome {
  return value === 'scheduled'
    || value === 'checked_in'
    || value === 'no_show'
    || value === 'cancelled';
}

function isOutcomeFilter(value: unknown): value is OccupancyCapacityOutcomeFilter {
  return value === 'all' || isOutcome(value);
}

function isQuality(value: unknown): value is OccupancyCapacityDataQuality {
  return value === 'snapshot'
    || value === 'estimated_current_configuration'
    || value === 'mixed';
}

function isHistory(value: unknown): value is OccupancyCapacityHistory {
  return isQuality(value) || value === 'unavailable';
}

function asCountRecord<T extends readonly string[]>(value: unknown, keys: T): Record<T[number], number> {
  if (!isRecord(value)) throw new Error('record');
  return Object.fromEntries(keys.map((key) => [key, asInteger(value[key])])) as Record<T[number], number>;
}

const SUMMARY_COUNT_KEYS = [
  'published_capacity',
  'slot_count',
  'capacity_slots',
  'table_slots',
  'snapshot_slots',
  'estimated_slots',
  'reservations',
  'reserved_people',
  'checked_in_reservations',
  'checked_in_people',
  'no_show_reservations',
  'no_show_people',
  'unmatched_reservations',
  'unmatched_people',
  'waitlist_entries',
  'waitlist_people',
  'waitlist_seated',
  'waitlist_dropped',
] as const;

function normalizeSummary(value: unknown): OccupancyCapacitySummary {
  if (!isRecord(value)) throw new Error('summary');
  const counts = asCountRecord(value, SUMMARY_COUNT_KEYS);
  return {
    ...counts,
    capacity_pressure_rate: asRate(value.capacity_pressure_rate),
    check_in_capacity_rate: asRate(value.check_in_capacity_rate),
    average_wait_minutes: asNumber(value.average_wait_minutes) as number,
  };
}

export function normalizeOccupancyCapacityReservation(value: unknown): OccupancyCapacityReservationRow {
  if (!isRecord(value) || !isMode(value.availability_mode) || !isOutcome(value.outcome)) {
    throw new Error('reservation');
  }
  const quality = value.data_quality;
  if (quality !== null && quality !== 'snapshot' && quality !== 'estimated_current_configuration') {
    throw new Error('reservation quality');
  }
  return {
    id: asString(value.id)!,
    guest_name: asString(value.guest_name)!,
    guest_phone: asString(value.guest_phone)!,
    guest_email: asString(value.guest_email, true),
    date: asString(value.date)!,
    time: asString(value.time)!,
    party_size: asInteger(value.party_size)!,
    status: asString(value.status)!,
    outcome: value.outcome,
    availability_mode: value.availability_mode,
    published_capacity: asInteger(value.published_capacity, true),
    data_quality: quality,
    capacity_basis_available: asBoolean(value.capacity_basis_available),
    counts_toward_capacity: asBoolean(value.counts_toward_capacity),
    checked_in_at: asString(value.checked_in_at, true),
    checked_in_party_size: asInteger(value.checked_in_party_size, true),
    table_id: asString(value.table_id, true),
    table_number: asInteger(value.table_number, true),
    section_code: asString(value.section_code, true),
    section_name: asString(value.section_name, true),
    created_at: asString(value.created_at)!,
    public_tracking_code: asString(value.public_tracking_code, true),
  };
}

export function buildOccupancyCapacityRpcParams(params: OccupancyCapacityReportParams) {
  return {
    _company_id: params.companyId,
    _start_date: params.periodStart,
    _end_date: params.periodEnd,
    _granularity: params.granularity ?? 'day',
    _page: Math.max(1, Math.floor(params.page ?? 1)),
    _page_size: Math.min(
      OCCUPANCY_CAPACITY_PAGE_SIZE_MAX,
      Math.max(1, Math.floor(params.pageSize ?? 20)),
    ),
    _availability_mode: params.availabilityMode ?? 'all',
    _outcome: params.outcome ?? 'all',
  };
}

export function buildOccupancyCapacityQueryKey(params: OccupancyCapacityReportParams) {
  const rpc = buildOccupancyCapacityRpcParams(params);
  return [
    'occupancy-capacity-report',
    rpc._company_id,
    rpc._start_date,
    rpc._end_date,
    rpc._granularity,
    rpc._page,
    rpc._page_size,
    rpc._availability_mode,
    rpc._outcome,
  ] as const;
}

export function normalizeOccupancyCapacityReport(
  payload: unknown,
  expected: ReturnType<typeof buildOccupancyCapacityRpcParams>,
): OccupancyCapacityReport {
  try {
    if (!isRecord(payload) || !isRecord(payload.meta) || !isRecord(payload.table_assignment)) {
      throw new Error('payload');
    }
    const meta = payload.meta;
    if (
      meta.period_start !== expected._start_date
      || meta.period_end !== expected._end_date
      || meta.granularity !== expected._granularity
      || meta.availability_mode !== expected._availability_mode
      || meta.outcome !== expected._outcome
      || !isModeFilter(meta.availability_mode)
      || !isOutcomeFilter(meta.outcome)
      || !isHistory(meta.capacity_history)
    ) throw new Error('request mismatch');

    const details = Array.isArray(payload.details)
      ? payload.details.map(normalizeOccupancyCapacityReservation)
      : (() => { throw new Error('details'); })();
    const detailsTotal = asInteger(meta.details_total)!;
    const page = asInteger(meta.page)!;
    const pageSize = asInteger(meta.page_size)!;
    const expectedRows = Math.max(0, Math.min(pageSize, detailsTotal - ((page - 1) * pageSize)));
    if (details.length !== expectedRows || new Set(details.map((row) => row.id)).size !== details.length) {
      throw new Error('truncated details');
    }

    if (
      !Array.isArray(payload.series)
      || !Array.isArray(payload.heatmap)
      || !Array.isArray(payload.waitlist_by_hour)
      || !Array.isArray(payload.no_show_by_hour)
      || !Array.isArray(payload.table_breakdown)
    ) throw new Error('arrays');

    const series = payload.series.map((row) => {
      if (!isRecord(row)) throw new Error('series');
      const counts = asCountRecord(row, [
        'published_capacity', 'slot_count', 'reservations', 'reserved_people',
        'checked_in_reservations', 'checked_in_people', 'no_show_reservations', 'no_show_people',
      ] as const);
      return {
        period: asString(row.period)!,
        ...counts,
        capacity_pressure_rate: asRate(row.capacity_pressure_rate),
        check_in_capacity_rate: asRate(row.check_in_capacity_rate),
      };
    });

    const heatmap = payload.heatmap.map((row) => {
      if (!isRecord(row) || !isQuality(row.data_quality)) throw new Error('heatmap');
      return {
        weekday: asInteger(row.weekday)!,
        weekday_label: asString(row.weekday_label)!,
        time_slot: asString(row.time_slot)!,
        ...asCountRecord(row, [
          'slot_count', 'published_capacity', 'reserved_people', 'checked_in_people', 'no_show_reservations',
        ] as const),
        capacity_pressure_rate: asRate(row.capacity_pressure_rate),
        check_in_capacity_rate: asRate(row.check_in_capacity_rate),
        data_quality: row.data_quality,
      };
    });

    const waitlist = payload.waitlist_by_hour.map((row) => {
      if (!isRecord(row)) throw new Error('waitlist');
      return {
        hour: asString(row.hour)!,
        ...asCountRecord(row, ['entries', 'people', 'seated', 'dropped'] as const),
        average_wait_minutes: asNumber(row.average_wait_minutes) as number,
      };
    });

    const noShow = payload.no_show_by_hour.map((row) => {
      if (!isRecord(row)) throw new Error('no-show');
      return {
        hour: asString(row.hour)!,
        ...asCountRecord(row, ['reservations', 'people', 'eligible_reservations'] as const),
        rate: asRate(row.rate),
      };
    });

    const tableBreakdown = payload.table_breakdown.map((row) => {
      if (!isRecord(row)) throw new Error('table breakdown');
      return {
        section_code: asString(row.section_code, true),
        section_name: asString(row.section_name)!,
        table_id: asString(row.table_id)!,
        table_number: asInteger(row.table_number)!,
        ...asCountRecord(row, [
          'reservations', 'reserved_people', 'checked_in_reservations', 'checked_in_people',
        ] as const),
      };
    });

    const assignment = payload.table_assignment;
    const assignmentCounts = asCountRecord(
      assignment,
      ['eligible_reservations', 'assigned_reservations', 'unassigned_reservations'] as const,
    );

    return {
      summary: normalizeSummary(payload.summary),
      series,
      heatmap,
      waitlist_by_hour: waitlist,
      no_show_by_hour: noShow,
      table_breakdown: tableBreakdown,
      table_assignment: {
        ...assignmentCounts,
        coverage_rate: asRate(assignment.coverage_rate),
      },
      details,
      meta: {
        period_start: asString(meta.period_start)!,
        period_end: asString(meta.period_end)!,
        time_zone: asString(meta.time_zone)!,
        granularity: meta.granularity as OccupancyCapacityGranularity,
        page,
        page_size: pageSize,
        details_total: detailsTotal,
        unmatched_reservations: asInteger(meta.unmatched_reservations)!,
        unmatched_people: asInteger(meta.unmatched_people)!,
        availability_mode: meta.availability_mode,
        outcome: meta.outcome,
        generated_at: asString(meta.generated_at)!,
        capacity_history: meta.capacity_history,
        estimation_notice: asString(meta.estimation_notice, true),
        unmatched_notice: asString(meta.unmatched_notice, true),
      },
    };
  } catch (error) {
    throw new OccupancyCapacityValidationError(
      'O relat\u00f3rio de ocupa\u00e7\u00e3o retornou dados incompletos ou inv\u00e1lidos.',
      { cause: error },
    );
  }
}
