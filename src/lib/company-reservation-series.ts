import { addDays, addMonths, addWeeks, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { isOperationalActiveReservationStatus } from '@/lib/reservation-operational-filter';
import type { ReportGranularity } from '@/lib/report-filters';

export interface CompanyReservationFact {
  company_id: string;
  date: string;
  status: string | null;
  party_size: number | null;
}

export function buildCompanyReservationSeries(
  companies: Array<{ id: string }>,
  reservations: CompanyReservationFact[],
  start: string,
  end: string,
  granularity: ReportGranularity,
  metric: 'reservations' | 'people',
) {
  const bucket = (date: Date) => granularity === 'month' ? startOfMonth(date)
    : granularity === 'week' ? startOfWeek(date, { weekStartsOn: 1 }) : date;
  const points = new Map<string, { period: string; values: Record<string, number> }>();
  const last = bucket(parseISO(end));
  for (let date = bucket(parseISO(start)); date <= last;
    date = granularity === 'month' ? addMonths(date, 1) : granularity === 'week' ? addWeeks(date, 1) : addDays(date, 1)) {
    const period = format(date, 'yyyy-MM-dd');
    points.set(period, { period, values: Object.fromEntries(companies.map((company) => [company.id, 0])) });
  }
  for (const reservation of reservations) {
    if (reservation.date < start || reservation.date > end
      || !isOperationalActiveReservationStatus(normalizeReservationStatus(reservation.status))) continue;
    const point = points.get(format(bucket(parseISO(reservation.date)), 'yyyy-MM-dd'));
    if (!point || !Object.hasOwn(point.values, reservation.company_id)) continue;
    point.values[reservation.company_id] += metric === 'people' ? reservation.party_size ?? 0 : 1;
  }
  return [...points.values()];
}
