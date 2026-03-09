import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Reservation, RestaurantTable } from '@/types/restaurant';
import { mockReservations, mockTables } from '@/data/mock';

interface ReservationContextType {
  reservations: Reservation[];
  tables: RestaurantTable[];
  addReservation: (reservation: Omit<Reservation, 'id' | 'createdAt'>) => void;
  updateReservation: (id: string, updates: Partial<Reservation>) => void;
  deleteReservation: (id: string) => void;
  getTableById: (id: string) => RestaurantTable | undefined;
}

const ReservationContext = createContext<ReservationContextType | undefined>(undefined);

export const ReservationProvider = ({ children }: { children: ReactNode }) => {
  const [reservations, setReservations] = useState<Reservation[]>(mockReservations);
  const [tables] = useState<RestaurantTable[]>(mockTables);

  const addReservation = (reservation: Omit<Reservation, 'id' | 'createdAt'>) => {
    const newReservation: Reservation = {
      ...reservation,
      id: `r${Date.now()}`,
      createdAt: new Date().toISOString().split('T')[0],
    };
    setReservations(prev => [...prev, newReservation]);
  };

  const updateReservation = (id: string, updates: Partial<Reservation>) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const deleteReservation = (id: string) => {
    setReservations(prev => prev.filter(r => r.id !== id));
  };

  const getTableById = (id: string) => tables.find(t => t.id === id);

  return (
    <ReservationContext.Provider value={{ reservations, tables, addReservation, updateReservation, deleteReservation, getTableById }}>
      {children}
    </ReservationContext.Provider>
  );
};

export const useReservations = () => {
  const context = useContext(ReservationContext);
  if (!context) throw new Error('useReservations must be used within a ReservationProvider');
  return context;
};
