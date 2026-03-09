import { Reservation, RestaurantTable } from '@/types/restaurant';

export const mockTables: RestaurantTable[] = [
  { id: 't1', number: 1, capacity: 2, status: 'available', section: 'salão', x: 1, y: 1 },
  { id: 't2', number: 2, capacity: 2, status: 'occupied', section: 'salão', x: 2, y: 1 },
  { id: 't3', number: 3, capacity: 4, status: 'reserved', section: 'salão', x: 3, y: 1 },
  { id: 't4', number: 4, capacity: 4, status: 'available', section: 'salão', x: 1, y: 2 },
  { id: 't5', number: 5, capacity: 6, status: 'occupied', section: 'salão', x: 2, y: 2 },
  { id: 't6', number: 6, capacity: 6, status: 'available', section: 'salão', x: 3, y: 2 },
  { id: 't7', number: 7, capacity: 4, status: 'available', section: 'varanda', x: 1, y: 3 },
  { id: 't8', number: 8, capacity: 4, status: 'reserved', section: 'varanda', x: 2, y: 3 },
  { id: 't9', number: 9, capacity: 2, status: 'available', section: 'varanda', x: 3, y: 3 },
  { id: 't10', number: 10, capacity: 8, status: 'available', section: 'privativo', x: 1, y: 4 },
  { id: 't11', number: 11, capacity: 10, status: 'maintenance', section: 'privativo', x: 2, y: 4 },
  { id: 't12', number: 12, capacity: 12, status: 'available', section: 'privativo', x: 3, y: 4 },
];

const today = new Date().toISOString().split('T')[0];
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

export const mockReservations: Reservation[] = [
  { id: 'r1', guestName: 'Maria Silva', guestPhone: '(11) 99999-1234', date: today, time: '19:00', partySize: 2, tableId: 't2', status: 'confirmed', createdAt: today, notes: 'Aniversário' },
  { id: 'r2', guestName: 'João Santos', guestPhone: '(11) 98888-5678', date: today, time: '20:00', partySize: 4, tableId: 't3', status: 'confirmed', createdAt: today },
  { id: 'r3', guestName: 'Ana Oliveira', guestPhone: '(11) 97777-9012', date: today, time: '20:30', partySize: 6, tableId: 't5', status: 'confirmed', createdAt: today },
  { id: 'r4', guestName: 'Carlos Ferreira', guestPhone: '(11) 96666-3456', date: today, time: '21:00', partySize: 4, tableId: 't8', status: 'confirmed', createdAt: today },
  { id: 'r5', guestName: 'Lucia Mendes', guestPhone: '(11) 95555-7890', date: tomorrow, time: '19:30', partySize: 2, tableId: 't1', status: 'confirmed', createdAt: today },
  { id: 'r6', guestName: 'Pedro Costa', guestPhone: '(11) 94444-2345', date: tomorrow, time: '20:00', partySize: 8, tableId: 't10', status: 'confirmed', createdAt: today, notes: 'Reunião de negócios' },
  { id: 'r7', guestName: 'Fernanda Lima', guestPhone: '(11) 93333-6789', date: today, time: '18:30', partySize: 2, tableId: 't1', status: 'completed', createdAt: today },
  { id: 'r8', guestName: 'Roberto Alves', guestPhone: '(11) 92222-0123', date: today, time: '19:00', partySize: 4, tableId: 't4', status: 'no-show', createdAt: today },
];
