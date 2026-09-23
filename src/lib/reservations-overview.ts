// Intensidade dos dias na visão geral de reservas: a barra no pé de cada card
// mostra o volume do dia contra o dia mais cheio do período, para o pico saltar
// à vista sem precisar ler os quinze números.

export interface ReservationsOverviewDay {
  dateString: string;
  reservationCount: number;
  totalGuests: number;
}

// Sempre deixa um fio visível quando há reserva, para dias fracos não sumirem.
export function getReservationsOverviewIntensity(reservationCount: number, maxReservationCount: number) {
  if (reservationCount <= 0 || maxReservationCount <= 0) return 0;
  return Math.max(0.12, Math.min(1, reservationCount / maxReservationCount));
}
