import { addDays, format, startOfDay, subDays } from 'date-fns';

export type ReservationsView = 'overview' | 'list';
export type ReservationsOverviewRangeMode = 'future' | 'past';

export interface ReservationsOverviewDateRange {
  start: Date;
  end: Date;
  startKey: string;
  endKey: string;
}

export function getReservationsOverviewDateRange(
  mode: ReservationsOverviewRangeMode,
  referenceDate = new Date(),
): ReservationsOverviewDateRange {
  const today = startOfDay(referenceDate);
  const start = mode === 'future' ? today : subDays(today, 14);
  const end = mode === 'future' ? addDays(today, 14) : today;

  return {
    start,
    end,
    startKey: format(start, 'yyyy-MM-dd'),
    endKey: format(end, 'yyyy-MM-dd'),
  };
}
