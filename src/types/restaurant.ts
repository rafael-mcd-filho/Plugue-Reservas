export type ReservationStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'checked_in'
  | 'cancelled'
  | 'no-show'
  | 'payment_expired'
  | 'payment_cancelled'
  | 'paid_after_expiration';

export type TableStatus = 'available' | 'occupied' | 'reserved' | 'maintenance';

export interface Reservation {
  id: string;
  guestName: string;
  guestPhone: string;
  guestEmail?: string;
  date: string;
  time: string;
  partySize: number;
  tableId: string;
  status: ReservationStatus;
  notes?: string;
  createdAt: string;
}

export interface RestaurantTable {
  id: string;
  number: number;
  capacity: number;
  status: TableStatus;
  section: string;
  x: number;
  y: number;
}
