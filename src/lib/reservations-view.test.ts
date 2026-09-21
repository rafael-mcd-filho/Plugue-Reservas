import { describe, expect, it } from 'vitest';
import { getReservationsOverviewDateRange } from '@/lib/reservations-view';

describe('getReservationsOverviewDateRange', () => {
  const referenceDate = new Date('2026-09-21T12:00:00');

  it('limita a visao futura ao dia atual e aos 14 dias seguintes', () => {
    const range = getReservationsOverviewDateRange('future', referenceDate);

    expect(range.startKey).toBe('2026-09-21');
    expect(range.endKey).toBe('2026-10-05');
  });

  it('limita a visao passada aos 14 dias anteriores e ao dia atual', () => {
    const range = getReservationsOverviewDateRange('past', referenceDate);

    expect(range.startKey).toBe('2026-09-07');
    expect(range.endKey).toBe('2026-09-21');
  });
});
