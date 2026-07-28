export interface ReservationCalendarMetricRow {
  reservation_date: string;
  reservation_count: number | string;
  guest_count: number | string;
}

export interface ReservationCalendarDayMetric {
  guests: number;
  reservations: number;
}

function normalizeMetricCount(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function buildReservationCalendarDayMetrics(
  rows: ReservationCalendarMetricRow[],
) {
  return rows.reduce<Record<string, ReservationCalendarDayMetric>>((metrics, row) => {
    if (!row.reservation_date) return metrics;

    metrics[row.reservation_date] = {
      guests: normalizeMetricCount(row.guest_count),
      reservations: normalizeMetricCount(row.reservation_count),
    };

    return metrics;
  }, {});
}
