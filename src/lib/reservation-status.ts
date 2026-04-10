import type { ReservationStatus } from '@/types/restaurant';

export type ReservationStatusInput =
  | ReservationStatus
  | 'completed'
  | 'pending'
  | 'no_show'
  | string
  | null
  | undefined;

const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  confirmed: 'Confirmada',
  checked_in: 'Check-in realizado',
  cancelled: 'Cancelada',
  'no-show': 'No Show',
};

export function normalizeReservationStatus(status: ReservationStatusInput): ReservationStatus {
  const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalizedStatus === 'checked_in' || normalizedStatus === 'completed') {
    return 'checked_in';
  }

  if (normalizedStatus === 'cancelled') {
    return 'cancelled';
  }

  if (normalizedStatus === 'no-show' || normalizedStatus === 'no_show') {
    return 'no-show';
  }

  return 'confirmed';
}

export function getReservationStatusLabel(status: ReservationStatusInput) {
  return RESERVATION_STATUS_LABELS[normalizeReservationStatus(status)];
}
