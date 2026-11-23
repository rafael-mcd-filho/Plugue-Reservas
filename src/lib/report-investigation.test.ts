import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAttendanceReadings, getDemandReadings, loadAttendanceInvestigation, loadDemandInvestigation,
  matchesAttendanceInvestigation, matchesDemandInvestigation,
} from '@/lib/report-investigation';
import type { AttendanceLossesReport, AttendanceLossesReservationRow } from '@/lib/attendance-losses-report';
import type { DemandConversionReport, DemandReservationRow } from '@/hooks/useDemandConversionReport';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

const params = { companyId: 'company-1', periodStart: '2026-08-01', periodEnd: '2026-08-31' };
function attendanceRow(patch: Partial<AttendanceLossesReservationRow> = {}): AttendanceLossesReservationRow {
  return {
    id: 'reservation-1', company_id: 'company-1', guest_name: 'Cliente', guest_phone: '+5511999999999',
    guest_email: null, source: 'public', origin_affiliate_code: null, origin_affiliate_name: null,
    date: '2026-08-10', time: '19:00:00', party_size: 3, status: 'cancelled', occasion: null, notes: null,
    checked_in_at: null, checked_in_party_size: null, created_at: '2026-08-01T12:00:00Z',
    updated_at: '2026-08-10T23:00:00Z', public_tracking_code: 'track', outcome: 'cancelled',
    entry_method: 'online', lead_days: 9, cancelled_at: '2026-08-10T23:00:00Z', cancellation_lead_hours: -1,
    whatsapp_evolution: false, whatsapp_pluguechat: false, has_whatsapp: false, has_prepayment: false,
    ...patch,
  };
}
const summary = { reservations: 12, attended: 6, no_show: 2, cancelled: 3, scheduled: 1, reserved_people: 36, attended_people: 18, lost_people: 15, attendance_rate: 75, no_show_rate: 25, loss_rate: 45.5 };
function attendancePayload(rows: AttendanceLossesReservationRow[], page = 1, total = rows.length): AttendanceLossesReport {
  return {
    summary, comparison: null, daily_series: [],
    segments: { weekday: [], time_band: [], lead_time: [], party_size: [], entry_method: [] },
    associations: { whatsapp: [], prepayment: [] },
    cancellation_curve: { coverage_start: null, cancelled_total: 3, cancelled_with_audit: 2, coverage_percentage: 66.7, buckets: [] },
    reservations: rows,
    meta: { period_start: params.periodStart, period_end: params.periodEnd, comparison_enabled: false, comparison_start: null, comparison_end: null, time_zone: 'America/Sao_Paulo', page, page_size: 100, reservations_total: total, filtered_reservations_total: total, outcome: 'all', entry_method: 'all', search: null, generated_at: '2026-09-01T12:00:00Z' },
  };
}
function demandRow(patch: Partial<DemandReservationRow> = {}): DemandReservationRow {
  const row = attendanceRow();
  return { ...row, reservation_date: row.date, reservation_time: row.time, entry_mode: 'online', table_id: null, created_in_mode: null, ...patch };
}
function demandPayload(rows: DemandReservationRow[], entryMode = 'all'): DemandConversionReport {
  const count = rows.length;
  return {
    summary: { sessions: 0, completed: 0, overall_conversion_rate: 0, created_reservations: count, created_people: count * 3, average_lead_days: 9 },
    comparison: null,
    funnel: ['page_view', 'date_select', 'time_select', 'form_fill', 'completed'].map(step => ({ step, label: step, count: 0, conversion_from_previous: 0, conversion_from_start: 0, dropoff: 0, dropoff_rate: 0 })) as DemandConversionReport['funnel'],
    trend: [{ period: '2026-08-01', page_views: 0, date_selections: 0, time_selections: 0, forms: 0, completed: 0, created_reservations: count, created_people: count * 3 }],
    transition_times: ['page_to_date', 'date_to_time', 'time_to_form', 'form_to_completed'].map(key => ({ key, from_label: key, to_label: key, median_seconds: 0, sample_size: 0 })) as DemandConversionReport['transition_times'],
    lead_time_bands: ['same_day', 'one_day', 'two_to_seven', 'eight_to_fourteen', 'fifteen_to_thirty', 'thirty_one_plus'].map(key => ({ key, label: key, reservations: key === 'eight_to_fourteen' ? count : 0, people: key === 'eight_to_fourteen' ? count * 3 : 0, percentage: key === 'eight_to_fourteen' ? 100 : 0 })) as DemandConversionReport['lead_time_bands'],
    entry_modes: ['online', 'affiliate', 'manual', 'waitlist'].map(key => ({ key, label: key, reservations: key === 'online' ? count : 0, people: key === 'online' ? count * 3 : 0, percentage: key === 'online' ? 100 : 0 })) as DemandConversionReport['entry_modes'],
    party_size_bands: ['one_two', 'three_four', 'five_six', 'seven_plus'].map(key => ({ key, label: key, reservations: key === 'three_four' ? count : 0, people: key === 'three_four' ? count * 3 : 0, percentage: key === 'three_four' ? 100 : 0 })) as DemandConversionReport['party_size_bands'],
    details: rows,
    meta: { period_start: params.periodStart, period_end: params.periodEnd, time_zone: 'America/Sao_Paulo', unique_only: false, comparison_enabled: false, comparison_start: null, comparison_end: null, granularity: 'day', page: 1, page_size: 100, details_total: count, entry_mode: entryMode as 'all', search: null, generated_at: '2026-09-01T12:00:00Z', funnel_source: 'tracking_funnel_sessions' },
  };
}

describe('report investigation predicates', () => {
  it('keeps SQL weekday, time, group and lead-time boundaries', () => {
    const row = attendanceRow();
    expect(matchesAttendanceInvestigation(row, { title: '', dimension: 'weekday', segmentKey: '1' })).toBe(true);
    expect(matchesAttendanceInvestigation(row, { title: '', dimension: 'time_band', segmentKey: '18_20' })).toBe(true);
    expect(matchesAttendanceInvestigation({ ...row, time: '20:00:00' }, { title: '', dimension: 'time_band', segmentKey: '18_20' })).toBe(false);
    expect(matchesAttendanceInvestigation({ ...row, time: '22:00:00' }, { title: '', dimension: 'time_band', segmentKey: 'after_22' })).toBe(true);
    expect(matchesAttendanceInvestigation({ ...row, party_size: 4 }, { title: '', dimension: 'party_size', segmentKey: '3_4' })).toBe(true);
    expect(matchesAttendanceInvestigation({ ...row, lead_days: 2 }, { title: '', dimension: 'lead_time', segmentKey: '1_2' })).toBe(true);
    expect(matchesAttendanceInvestigation({ ...row, lead_days: 3 }, { title: '', dimension: 'lead_time', segmentKey: '1_2' })).toBe(false);
  });

  it.each([[-1, 'after_start'], [0, 'under_2h'], [2, '2_6h'], [6, '6_24h'], [24, '1_3d'], [72, '3d_plus']] as const)('keeps cancellation bucket boundary %s', (hours, bucket) => {
    expect(matchesAttendanceInvestigation(attendanceRow({ cancellation_lead_hours: hours }), { title: '', cancellationBucket: bucket })).toBe(true);
    expect(matchesAttendanceInvestigation(attendanceRow({ outcome: 'attended', cancellation_lead_hours: hours }), { title: '', cancellationBucket: bucket })).toBe(false);
  });

  it('preserves missing audit and loss outcomes without counting scheduled rows', () => {
    expect(matchesAttendanceInvestigation(attendanceRow({ cancelled_at: null }), { title: '', cancellationBucket: 'without_audit' })).toBe(true);
    expect(matchesAttendanceInvestigation(attendanceRow({ outcome: 'scheduled' }), { title: '', outcome: 'losses' })).toBe(false);
    expect(matchesAttendanceInvestigation(attendanceRow({ outcome: 'no_show' }), { title: '', outcome: 'losses' })).toBe(true);
  });

  it('uses demand band definitions rather than attendance band names', () => {
    expect(matchesDemandInvestigation(demandRow({ lead_days: 1 }), { title: '', leadTimeBand: 'one_day' })).toBe(true);
    expect(matchesDemandInvestigation(demandRow({ lead_days: 2 }), { title: '', leadTimeBand: 'two_to_seven' })).toBe(true);
    expect(matchesDemandInvestigation(demandRow({ lead_days: 7 }), { title: '', leadTimeBand: 'two_to_seven' })).toBe(true);
    expect(matchesDemandInvestigation(demandRow({ lead_days: 8 }), { title: '', leadTimeBand: 'two_to_seven' })).toBe(false);
    expect(matchesDemandInvestigation(demandRow({ party_size: 7 }), { title: '', partySizeBand: 'seven_plus' })).toBe(true);
  });
});

describe('complete authorized report investigations', () => {
  beforeEach(() => { mocks.rpc.mockReset(); });

  it('loads all pages before applying a segment and retains matching rows beyond the first page', async () => {
    const all = Array.from({ length: 103 }, (_, index) => attendanceRow({ id: `r-${index}`, outcome: index === 102 ? 'no_show' : 'attended' }));
    mocks.rpc.mockImplementation(async (_name, rpc) => ({ data: attendancePayload(all.slice((rpc._page - 1) * 100, rpc._page * 100), rpc._page, all.length), error: null }));
    const rows = await loadAttendanceInvestigation(params, { title: '', outcome: 'no_show' });
    expect(rows.map(row => row.id)).toEqual(['r-102']);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ _company_id: 'company-1', _page_size: 100, _include_comparison: false });
  });

  it('rejects a later failed page instead of returning a partial list', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => attendanceRow({ id: `r-${index}` }));
    mocks.rpc.mockResolvedValueOnce({ data: attendancePayload(rows, 1, 103), error: null }).mockResolvedValueOnce({ data: null, error: new Error('offline') });
    await expect(loadAttendanceInvestigation(params, { title: '' })).rejects.toThrow('offline');
  });

  it('uses the reservation creation RPC for demand and maps visit fields for the shared list', async () => {
    mocks.rpc.mockResolvedValue({ data: demandPayload([demandRow()]), error: null });
    const rows = await loadDemandInvestigation(params, { title: '', leadTimeBand: 'eight_to_fourteen' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-08-10', time: '19:00:00' });
    expect(mocks.rpc).toHaveBeenCalledWith('get_demand_conversion_report', expect.objectContaining({ _start_date: params.periodStart, _entry_mode: 'all' }));
  });

  it('uses the visit dataset for a visit-origin investigation instead of creation dates', async () => {
    const payload = attendancePayload([attendanceRow()]);
    payload.meta.entry_method = 'online';
    mocks.rpc.mockResolvedValue({ data: payload, error: null });
    const rows = await loadDemandInvestigation(params, { title: '', basis: 'visit', entryMode: 'online' });
    expect(rows).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledWith('get_attendance_losses_report', expect.objectContaining({ _period_start: params.periodStart, _entry_method: 'online', _outcome: 'all' }));
  });
});

describe('deterministic report readings', () => {
  it('limits attendance readings to three and identifies small bases and audit coverage', () => {
    const readings = getAttendanceReadings(attendancePayload([]));
    expect(readings).toHaveLength(3);
    expect(readings[1].detail).toContain('Amostra pequena');
    expect(readings[2].detail).toContain('2 de 3 cancelamentos');
    expect(readings[2].detail).toContain('66,7%');
  });

  it('keeps web identities and all-channel reservations separate and avoids causal claims', () => {
    const report = demandPayload([demandRow()]);
    report.summary.sessions = 4;
    report.summary.completed = 1;
    report.summary.overall_conversion_rate = 25;
    report.funnel[0] = { ...report.funnel[0], count: 4, dropoff: 3 };
    const readings = getDemandReadings(report, true);
    expect(readings).toHaveLength(3);
    expect(readings[0].detail).toContain('1 de 4 visitantes únicos');
    expect(readings[0].detail).toContain('Volume pequeno');
    expect(readings[1].detail).toContain('data de criação');
    expect(readings[2].detail).toContain('não demonstram o motivo');
  });
});
