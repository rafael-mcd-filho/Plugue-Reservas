import { describe, expect, it } from 'vitest';
import {
  aggregateAttendanceLossesSeries,
  buildAttendanceLossesQueryKey,
  buildAttendanceLossesRpcParams,
  normalizeAttendanceLossesReport,
  normalizeAttendanceLossesSearch,
  type AttendanceLossesReservationRow,
} from '@/lib/attendance-losses-report';

const params = {
  companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-20',
  outcome: 'all' as const,
  entryMethod: 'all' as const,
  page: 1,
  pageSize: 2,
  search: ' Ana ',
};

const summary = {
  reservations: 2,
  attended: 1,
  no_show: 1,
  cancelled: 0,
  scheduled: 0,
  reserved_people: 6,
  attended_people: 4,
  lost_people: 2,
  attendance_rate: 50,
  no_show_rate: 50,
  loss_rate: 50,
};

function reservation(id: string): AttendanceLossesReservationRow {
  return {
    id,
    company_id: params.companyId,
    guest_name: id.endsWith('1') ? 'Ana' : 'Ana Maria',
    guest_phone: '5585999990000',
    guest_email: null,
    source: 'reservation',
    origin_affiliate_code: null,
    origin_affiliate_name: null,
    date: '2026-08-10',
    time: '19:00:00',
    party_size: id.endsWith('1') ? 4 : 2,
    status: id.endsWith('1') ? 'checked_in' : 'no-show',
    occasion: null,
    notes: null,
    checked_in_at: id.endsWith('1') ? '2026-08-10T22:05:00Z' : null,
    checked_in_party_size: id.endsWith('1') ? 4 : null,
    created_at: '2026-08-01T12:00:00Z',
    updated_at: '2026-08-10T22:05:00Z',
    public_tracking_code: `tracking-${id}`,
    outcome: id.endsWith('1') ? 'attended' : 'no_show',
    entry_method: 'online',
    lead_days: 9,
    cancelled_at: null,
    cancellation_lead_hours: null,
    whatsapp_evolution: id.endsWith('1'),
    whatsapp_pluguechat: false,
    has_whatsapp: id.endsWith('1'),
    has_prepayment: id.endsWith('1'),
  };
}

function validPayload() {
  const segment = { key: 'online', label: 'Online', sort_order: 1, ...summary };
  const association = { key: 'with', label: 'Com envio registrado', ...summary };
  return {
    summary,
    comparison: {
      ...summary,
      period_start: '2026-07-12',
      period_end: '2026-07-31',
    },
    daily_series: [{ date: '2026-08-01', ...summary }],
    segments: {
      weekday: [segment],
      time_band: [segment],
      party_size: [segment],
      lead_time: [segment],
      entry_method: [segment],
    },
    associations: {
      whatsapp: [{ ...association, evolution_reservations: 1, pluguechat_reservations: 0 }],
      prepayment: [association],
    },
    cancellation_curve: {
      coverage_start: '2026-04-19T12:00:00Z',
      cancelled_total: 0,
      cancelled_with_audit: 0,
      coverage_percentage: 0,
      buckets: [{ key: 'without_audit', label: 'Sem horário auditado', sort_order: 1, reservations: 0, people: 0, percentage: 0 }],
    },
    reservations: [
      reservation('10000000-0000-4000-8000-000000000001'),
      reservation('10000000-0000-4000-8000-000000000002'),
    ],
    meta: {
      period_start: params.periodStart,
      period_end: params.periodEnd,
      comparison_start: '2026-07-12',
      comparison_end: '2026-07-31',
      comparison_enabled: true,
      time_zone: 'America/Fortaleza',
      page: 1,
      page_size: 2,
      reservations_total: 2,
      filtered_reservations_total: 2,
      outcome: 'all',
      entry_method: 'all',
      search: 'Ana',
      generated_at: '2026-08-20T12:00:00Z',
    },
  };
}

describe('attendance losses report contract', () => {
  it('builds a server-side page request and separates pages in the cache', () => {
    expect(buildAttendanceLossesRpcParams(params)).toEqual({
      _company_id: params.companyId,
      _period_start: params.periodStart,
      _period_end: params.periodEnd,
      _outcome: 'all',
      _entry_method: 'all',
      _page: 1,
      _page_size: 2,
      _search: 'Ana',
      _include_comparison: true,
    });
    expect(buildAttendanceLossesQueryKey(params)).not.toEqual(
      buildAttendanceLossesQueryKey({ ...params, page: 2 }),
    );
  });

  it('normalizes the complete RPC payload without accepting a truncated page', () => {
    const expected = buildAttendanceLossesRpcParams(params);
    const report = normalizeAttendanceLossesReport(validPayload(), expected);
    expect(report.summary).toMatchObject({ reservations: 2, attendance_rate: 50 });
    expect(report.reservations).toHaveLength(2);
    expect(report.associations.whatsapp[0]).toMatchObject({ evolution_reservations: 1 });

    const truncated = validPayload();
    truncated.reservations = truncated.reservations.slice(0, 1);
    expect(() => normalizeAttendanceLossesReport(truncated, expected)).toThrow('dados incompletos ou inválidos');
  });

  it('rejects a response from different filters instead of showing stale data as current', () => {
    const payload = validPayload();
    payload.meta.entry_method = 'manual';
    expect(() => normalizeAttendanceLossesReport(payload, buildAttendanceLossesRpcParams(params)))
      .toThrow('dados incompletos ou inválidos');
  });

  it('accepts a null comparison only when it was disabled in the request', () => {
    const withoutComparisonParams = { ...params, comparisonEnabled: false };
    const payload = validPayload();
    payload.comparison = null as never;
    payload.meta.comparison_enabled = false;
    payload.meta.comparison_start = null as never;
    payload.meta.comparison_end = null as never;

    expect(normalizeAttendanceLossesReport(
      payload,
      buildAttendanceLossesRpcParams(withoutComparisonParams),
    ).comparison).toBeNull();
  });

  it('normalizes search using the same 200-character contract as SQL', () => {
    expect(normalizeAttendanceLossesSearch('  Ana  ')).toBe('Ana');
    expect(normalizeAttendanceLossesSearch('a'.repeat(250))).toHaveLength(200);
  });

  it('aggregates at most 366 daily points into calendar weeks or months without changing totals', () => {
    const daily = [
      { date: '2026-07-31', ...summary },
      { date: '2026-08-01', ...summary },
      { date: '2026-08-03', ...summary },
    ];
    const weekly = aggregateAttendanceLossesSeries(daily, 'week');
    const monthly = aggregateAttendanceLossesSeries(daily, 'month');

    expect(weekly.map((point) => point.date)).toEqual(['2026-07-27', '2026-08-03']);
    expect(weekly[0]).toMatchObject({ reservations: 4, attended: 2, no_show: 2, attendance_rate: 50 });
    expect(monthly.map((point) => point.date)).toEqual(['2026-07-01', '2026-08-01']);
    expect(monthly[1].reservations).toBe(4);
  });
});
