import { describe, expect, it } from 'vitest';
import {
  buildOccupancyCapacityRpcParams,
  normalizeOccupancyCapacityReport,
} from '@/lib/occupancy-capacity-report';

const expected = buildOccupancyCapacityRpcParams({
  companyId: 'company-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  granularity: 'day',
  page: 1,
  pageSize: 20,
});

const summary = {
  published_capacity: 100,
  slot_count: 2,
  capacity_slots: 1,
  table_slots: 1,
  snapshot_slots: 1,
  estimated_slots: 1,
  reservations: 4,
  reserved_people: 12,
  checked_in_reservations: 2,
  checked_in_people: 6,
  no_show_reservations: 1,
  no_show_people: 2,
  unmatched_reservations: 0,
  unmatched_people: 0,
  capacity_pressure_rate: 12,
  check_in_capacity_rate: 6,
  waitlist_entries: 3,
  waitlist_people: 6,
  waitlist_seated: 2,
  waitlist_dropped: 1,
  average_wait_minutes: 18.5,
};

function reservation(id = 'reservation-1') {
  return {
    id,
    guest_name: 'Cliente',
    guest_phone: '5583999999999',
    guest_email: null,
    date: '2026-08-10',
    time: '19:00:00',
    party_size: 2,
    status: 'confirmed',
    outcome: 'scheduled',
    availability_mode: 'capacity',
    published_capacity: 50,
    data_quality: 'snapshot',
    capacity_basis_available: true,
    counts_toward_capacity: true,
    checked_in_at: null,
    checked_in_party_size: null,
    table_id: null,
    table_number: null,
    section_code: null,
    section_name: null,
    created_at: '2026-08-01T12:00:00Z',
    public_tracking_code: null,
  };
}

function payload() {
  return {
    summary,
    series: [{
      period: '2026-08-01',
      published_capacity: 100,
      slot_count: 2,
      reservations: 4,
      reserved_people: 12,
      checked_in_reservations: 2,
      checked_in_people: 6,
      no_show_reservations: 1,
      no_show_people: 2,
      capacity_pressure_rate: 12,
      check_in_capacity_rate: 6,
    }],
    heatmap: [{
      weekday: 1,
      weekday_label: 'Seg',
      time_slot: '19:00:00',
      slot_count: 1,
      published_capacity: 50,
      reserved_people: 12,
      checked_in_people: 6,
      no_show_reservations: 1,
      capacity_pressure_rate: 24,
      check_in_capacity_rate: 12,
      data_quality: 'snapshot',
    }],
    waitlist_by_hour: [{ hour: '19:00:00', entries: 2, people: 4, seated: 1, dropped: 1, average_wait_minutes: 20 }],
    no_show_by_hour: [{ hour: '19:00:00', reservations: 1, people: 2, eligible_reservations: 4, rate: 25 }],
    table_breakdown: [{
      section_code: 'salao',
      section_name: 'Sal\u00e3o',
      table_id: 'table-1',
      table_number: 1,
      reservations: 2,
      reserved_people: 6,
      checked_in_reservations: 1,
      checked_in_people: 3,
    }],
    table_assignment: { eligible_reservations: 2, assigned_reservations: 1, unassigned_reservations: 1, coverage_rate: 50 },
    details: [reservation()],
    meta: {
      period_start: '2026-08-01',
      period_end: '2026-08-31',
      time_zone: 'America/Fortaleza',
      granularity: 'day',
      page: 1,
      page_size: 20,
      details_total: 1,
      unmatched_reservations: 0,
      unmatched_people: 0,
      availability_mode: 'all',
      outcome: 'all',
      generated_at: '2026-08-20T12:00:00Z',
      capacity_history: 'mixed',
      estimation_notice: 'Estimado.',
      unmatched_notice: null,
    },
  };
}

describe('occupancy capacity report contract', () => {
  it('normalizes a complete mixed-mode payload', () => {
    const report = normalizeOccupancyCapacityReport(payload(), expected);
    expect(report.summary.check_in_capacity_rate).toBe(6);
    expect(report.heatmap[0].data_quality).toBe('snapshot');
    expect(report.table_assignment.unassigned_reservations).toBe(1);
  });

  it('fails closed when a paged payload is truncated', () => {
    const truncated = payload();
    truncated.meta.details_total = 2;
    expect(() => normalizeOccupancyCapacityReport(truncated, expected)).toThrow(/dados incompletos/i);
  });

  it('caps paginated report rows', () => {
    expect(buildOccupancyCapacityRpcParams({
      companyId: 'company-1', periodStart: '2026-08-01', periodEnd: '2026-08-31', pageSize: 999,
    })._page_size).toBe(100);
  });
});
