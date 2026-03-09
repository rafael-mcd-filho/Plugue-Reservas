export type ReservationStatus = 'confirmed' | 'pending' | 'cancelled' | 'completed' | 'no-show';

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
  section: 'salão' | 'varanda' | 'privativo';
  x: number;
  y: number;
}
