import { describe, expect, it, vi } from 'vitest';
import { buildCapacityInsights, buildCapacityMatrix, capacityMatrixValue, filterOccupancyRecords, getCapacityPeriodWindow, retainCapacityMatrixContributors } from './occupancy-capacity-analysis';
import type { OccupancyCapacityHeatmapCell, OccupancyCapacityReport, OccupancyCapacityReservationRow } from './occupancy-capacity-report';

const cell: OccupancyCapacityHeatmapCell = {
  weekday: 1, weekday_label: 'Seg', time_slot: '19:00:00', slot_count: 2,
  published_capacity: 100, reserved_people: 80, checked_in_people: 60, no_show_reservations: 1,
  capacity_pressure_rate: 80, check_in_capacity_rate: 60, data_quality: 'snapshot',
};

const reservation: OccupancyCapacityReservationRow = {
  id: 'one', guest_name: 'Cliente', guest_phone: '5583999999999', guest_email: null,
  date: '2026-08-10', time: '19:00:00', party_size: 4, status: 'confirmed', outcome: 'scheduled',
  availability_mode: 'capacity', published_capacity: 50, data_quality: 'snapshot',
  capacity_basis_available: true, counts_toward_capacity: true, checked_in_at: null,
  checked_in_party_size: null, table_id: null, table_number: null, section_code: null,
  section_name: null, created_at: '2026-08-01T12:00:00Z', public_tracking_code: null,
};

describe('capacity matrix and record scopes', () => {
  it('aligns the same time columns and distinguishes missing slots from zero-demand slots', () => {
    const matrix = buildCapacityMatrix([
      { ...cell, weekday: 0, weekday_label: 'Dom', time_slot: '20:00:00', reserved_people: 0 },
      { ...cell, time_slot: '20:00:00' },
      { ...cell, weekday: 5, weekday_label: 'Sex' },
    ]);
    expect(matrix.times).toEqual(['19:00:00', '20:00:00']);
    expect(matrix.rows.map(row => row.label)).toEqual(['Seg', 'Sex', 'Dom']);
    expect(matrix.rows[0].cells[0]).toBeNull();
    expect(matrix.rows[2].cells[1]?.reserved_people).toBe(0);
  });

  it('keeps offer, reserved people and actual check-in people separate', () => {
    expect(capacityMatrixValue(cell, 'offer')).toEqual({ people: 100, rate: null });
    expect(capacityMatrixValue(cell, 'reserved')).toEqual({ people: 80, rate: 80 });
    expect(capacityMatrixValue(cell, 'checked_in')).toEqual({ people: 60, rate: 60 });
    expect(capacityMatrixValue({ ...cell, published_capacity: 0 }, 'reserved').rate).toBeNull();
  });

  it('matches the numerator scope and excludes unmatched, non-demand, other days and times', () => {
    const rows = [reservation,
      { ...reservation, id: 'other-day', date: '2026-08-11' },
      { ...reservation, id: 'other-time', time: '20:00:00' },
      { ...reservation, id: 'unmatched', capacity_basis_available: false },
      { ...reservation, id: 'expired', counts_toward_capacity: false },
      { ...reservation, id: 'no-show', status: 'no-show', outcome: 'no_show' as const },
      { ...reservation, id: 'attended', status: 'checked_in', outcome: 'checked_in' as const, checked_in_party_size: 2 },
    ];
    const scope = { metric: 'reserved' as const, weekday: 1, timeSlot: '19:00:00', title: 'Seg 19h' };
    expect(filterOccupancyRecords(rows, scope).map(row => row.id)).toEqual(['one', 'no-show', 'attended']);
    expect(filterOccupancyRecords(rows, { ...scope, metric: 'checked_in' }).map(row => row.id)).toEqual(['attended']);
    expect(filterOccupancyRecords(rows, { ...scope, metric: 'no_show' }).map(row => row.id)).toEqual(['no-show']);
    expect(filterOccupancyRecords(rows, { ...scope, metric: 'offer' }).map(row => row.id)).toEqual(['one', 'no-show', 'attended']);
  });

  it('can open the no-show hour numerator even without capacity basis, as its chart does', () => {
    const rows = [
      { ...reservation, id: 'outside-basis', time: '19:30:00', outcome: 'no_show' as const, capacity_basis_available: false },
      { ...reservation, id: 'next-hour', time: '20:00:00', outcome: 'no_show' as const },
    ];
    expect(filterOccupancyRecords(rows, { title: '19h', metric: 'no_show', hour: '19:00:00', basisOnly: false }).map(row => row.id)).toEqual(['outside-basis']);
  });

  it('uses whole calendar buckets for week and month selections, including leap days', () => {
    expect(getCapacityPeriodWindow('2026-08-10', 'day')).toEqual({ from: '2026-08-10', to: '2026-08-10' });
    expect(getCapacityPeriodWindow('2026-08-10', 'week')).toEqual({ from: '2026-08-10', to: '2026-08-16' });
    expect(getCapacityPeriodWindow('2028-02-01', 'month')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(filterOccupancyRecords([reservation], { title: 'Outro período', metric: 'reserved', from: '2026-08-11', to: '2026-08-12' })).toEqual([]);
  });

  it('labels limited samples and historic coverage rather than claiming a cause or pattern', () => {
    const report = {
      summary: { published_capacity: 100, slot_count: 2, reservations: 4, checked_in_reservations: 2, no_show_reservations: 1 },
      heatmap: [cell], meta: { capacity_history: 'mixed' },
    } as OccupancyCapacityReport;
    const insights = buildCapacityInsights(report);
    expect(insights).toHaveLength(3);
    expect(insights[0].detail).toContain('base com estimativas');
    expect(insights[0].detail).toContain('lotação física simultânea');
    expect(insights[1].title).toContain('poucas reservas');
    expect(insights[1].detail).toContain('pequeno para concluir um padrão');
    expect(insights[2].detail).toContain('3 resultados elegíveis');
  });

  it('does not describe unavailable capacity as a confirmed zero offer', () => {
    const report = {
      summary: { published_capacity: 0, slot_count: 0, reservations: 0, reserved_people: 0, checked_in_reservations: 0, no_show_reservations: 0 },
      heatmap: [], meta: { capacity_history: 'unavailable', unmatched_reservations: 0 },
    } as unknown as OccupancyCapacityReport;
    const insight = buildCapacityInsights(report)[0];
    expect(insight.title).toBe('Oferta sem base disponível');
    expect(insight.detail).toContain('Ausência de base não significa salão vazio ou capacidade zero');
  });

  it('uses the published slot mode rather than only the reservation creation mode for a matrix cell', async () => {
    const rows = [reservation, { ...reservation, id: 'other-basis-mode', date: '2026-08-17' }];
    const fetchDayCells = vi.fn(async date => date === '2026-08-10' ? [cell] : []);
    const selected = await retainCapacityMatrixContributors(rows, {
      title: 'Seg 19h', metric: 'reserved', weekday: 1, timeSlot: '19:00:00',
    }, fetchDayCells);
    expect(selected.map(row => row.id)).toEqual(['one']);
    expect(fetchDayCells.mock.calls.map(([date]) => date)).toEqual(['2026-08-10', '2026-08-17']);
  });

  it('does not return partial matrix contributors if one verification fails', async () => {
    const rows = [reservation, { ...reservation, id: 'second-week', date: '2026-08-17' }];
    const fetchDayCells = vi.fn(async date => {
      if (date === '2026-08-17') throw new Error('Falha na base de oferta');
      return [cell];
    });
    await expect(retainCapacityMatrixContributors(rows, {
      title: 'Seg 19h', metric: 'reserved', weekday: 1, timeSlot: '19:00:00',
    }, fetchDayCells)).rejects.toThrow('Falha na base de oferta');
  });

  it('bounds date verification to four concurrent reads and honors cancellation before another batch', async () => {
    const abort = new AbortController();
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...reservation, id: String(index), date: `2026-08-${String(index + 10).padStart(2, '0')}` }));
    const fetchDayCells = vi.fn(async () => { abort.abort(); return [cell]; });
    await expect(retainCapacityMatrixContributors(rows, {
      title: '19h', metric: 'reserved', weekday: 1, timeSlot: '19:00:00',
    }, fetchDayCells, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchDayCells).toHaveBeenCalledTimes(4);
  });
});
