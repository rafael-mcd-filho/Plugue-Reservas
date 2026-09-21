import { isOperationalActiveReservationStatus } from '@/lib/reservation-operational-filter';
import type { ReservationStatus } from '@/types/restaurant';

export interface ReservationTableRef {
  number: number;
  section: string | null;
}

export type ReservationTableBadgeTone = 'assigned' | 'unassigned';

export interface ReservationTableBadgeInfo {
  label: string;
  tone: ReservationTableBadgeTone;
}

export interface OccupiedTableLabel {
  label: string;
  title: string;
}

export interface ReservationTableBadgeInput {
  tableId: string | null;
  table: ReservationTableRef | null;
  createdInMode?: string | null;
  // Modo do horario em que a reserva cai. Quando conhecido tem precedencia
  // sobre created_in_mode, que nem toda consulta traz.
  availabilityMode?: string | null;
  status: ReservationStatus;
}

export function formatReservationTableLabel(table: ReservationTableRef) {
  return table.section ? `Mesa ${table.number} · ${table.section}` : `Mesa ${table.number}`;
}

export function formatOccupiedTableLabel(guestName?: string | null): OccupiedTableLabel {
  const normalizedGuestName = guestName?.trim().replace(/\s+/g, ' ');

  if (!normalizedGuestName) {
    return {
      label: 'Ocupada',
      title: 'Ocupada neste horário',
    };
  }

  const [firstName] = normalizedGuestName.split(' ');

  return {
    label: `Ocupada ${firstName}`,
    title: `Ocupada por ${normalizedGuestName}`,
  };
}

export function getReservationTableBadge({
  tableId,
  table,
  createdInMode,
  availabilityMode,
  status,
}: ReservationTableBadgeInput): ReservationTableBadgeInfo | null {
  if (tableId) {
    // A mesa pode ter sido removida do mapa depois da atribuicao; nesse caso
    // ainda sinalizamos que existe mesa, sem inventar numero.
    return { label: table ? formatReservationTableLabel(table) : 'Mesa atribuída', tone: 'assigned' };
  }

  const effectiveMode = availabilityMode ?? createdInMode;

  // Horarios por capacidade nao tem mesa para alocar, e reservas ja perdidas
  // nao demandam acao operacional.
  if (effectiveMode === 'capacity' || !isOperationalActiveReservationStatus(status)) {
    return null;
  }

  return { label: 'Sem mesa', tone: 'unassigned' };
}
