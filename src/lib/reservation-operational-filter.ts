import type { ReservationStatus } from '@/types/restaurant';

export type ReservationOperationalFilter = 'active' | 'lost' | 'all';

export const RESERVATION_OPERATIONAL_FILTER_OPTIONS: Array<{
  value: ReservationOperationalFilter;
  label: string;
}> = [
  { value: 'active', label: 'Ativas' },
  { value: 'lost', label: 'Perdidas' },
  { value: 'all', label: 'Todas' },
];

export function isOperationalActiveReservationStatus(status: ReservationStatus) {
  return status === 'confirmed' || status === 'checked_in';
}

export function isOperationalLostReservationStatus(status: ReservationStatus) {
  return (
    status === 'cancelled'
    || status === 'no-show'
    || status === 'payment_expired'
    || status === 'payment_cancelled'
    || status === 'paid_after_expiration'
  );
}

export function matchesReservationOperationalFilter(
  status: ReservationStatus,
  filter: ReservationOperationalFilter,
) {
  if (filter === 'all') return true;
  if (filter === 'active') return isOperationalActiveReservationStatus(status);
  return isOperationalLostReservationStatus(status);
}
