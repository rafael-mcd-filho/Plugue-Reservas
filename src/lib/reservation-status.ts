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
  pending_payment: 'Aguardando pagamento',
  confirmed: 'Confirmada',
  checked_in: 'Check-in realizado',
  cancelled: 'Cancelada',
  'no-show': 'No Show',
  payment_expired: 'Pagamento expirado',
  payment_cancelled: 'Pagamento cancelado',
  paid_after_expiration: 'Pago após expirar',
};

export const RESERVATION_PAYMENT_STATUSES: ReservationStatus[] = [
  'pending_payment',
  'payment_expired',
  'payment_cancelled',
  'paid_after_expiration',
];

export function normalizeReservationStatus(status: ReservationStatusInput): ReservationStatus {
  const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : '';

  if (normalizedStatus === 'checked_in' || normalizedStatus === 'completed') {
    return 'checked_in';
  }

  if (normalizedStatus === 'pending_payment') {
    return 'pending_payment';
  }

  if (normalizedStatus === 'cancelled') {
    return 'cancelled';
  }

  if (normalizedStatus === 'no-show' || normalizedStatus === 'no_show') {
    return 'no-show';
  }

  if (normalizedStatus === 'payment_expired') {
    return 'payment_expired';
  }

  if (normalizedStatus === 'payment_cancelled') {
    return 'payment_cancelled';
  }

  if (normalizedStatus === 'paid_after_expiration') {
    return 'paid_after_expiration';
  }

  return 'confirmed';
}

export function getReservationStatusLabel(status: ReservationStatusInput) {
  return RESERVATION_STATUS_LABELS[normalizeReservationStatus(status)];
}

export function isReservationPaymentStatus(status: ReservationStatusInput) {
  return RESERVATION_PAYMENT_STATUSES.includes(normalizeReservationStatus(status));
}

export function isReservationOperationalStatus(status: ReservationStatusInput) {
  return !isReservationPaymentStatus(status);
}
