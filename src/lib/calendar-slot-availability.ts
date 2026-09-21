// Regras da aba "Disponibilidade" das faixas do calendario.
//
// O modo de disponibilidade vem da regra de agenda do dia, entao todas as
// faixas de uma data compartilham o mesmo modo:
//  * 'tables': a unidade reservavel e a mesa (livre ou ocupada inteira);
//  * 'capacity': a unidade reservavel e a propria faixa (limite de pessoas).

export const MANUAL_RESERVATION_MAX_PARTY_SIZE = 50;
export const CAPACITY_QUICK_PARTY_SIZES = [2, 4, 6, 8] as const;

const UNSECTIONED_KEY = '__sem_setor__';
const UNSECTIONED_LABEL = 'Sem setor';

export interface SlotTableOptionRow {
  table_id: string;
  table_number: number | string | null;
  section_code: string | null;
  section_name: string | null;
  capacity: number | string | null;
  available: boolean | null;
  conflict_reservation_id: string | null;
  conflict_guest_name: string | null;
}

export interface SlotTableOption {
  tableId: string;
  tableNumber: number;
  sectionCode: string | null;
  sectionName: string | null;
  capacity: number;
  available: boolean;
  conflictReservationId: string | null;
  conflictGuestName: string | null;
}

export interface SlotTableSection {
  key: string;
  label: string;
  /** Mesas exibidas (respeita "Cabe X" e "Livres/Todas"). */
  tables: SlotTableOption[];
  /** Mesas livres do setor que comportam o filtro "Cabe X". */
  freeCount: number;
  /** Mesas do setor que comportam o filtro "Cabe X". */
  totalCount: number;
  freeSeats: number;
}

export interface SlotTableAvailability {
  sections: SlotTableSection[];
  /** Totais sem filtro, para o resumo da faixa. */
  freeCount: number;
  totalCount: number;
  freeSeats: number;
  /** Mesas livres que comportam o filtro "Cabe X". */
  matchingFreeCount: number;
}

export interface SlotTableAvailabilityFilters {
  showOccupied: boolean;
  /** 0 = qualquer tamanho. */
  minSeats: number;
}

export interface SlotBookingInput {
  availabilityMode: 'tables' | 'capacity';
  capacityLimit: number | null;
  remainingCapacity: number | null;
  reservationLimit: number | null;
  arrivalReservationCount: number;
}

export interface SlotBookingState {
  /** Motivo para nao oferecer novas reservas; null quando ha vaga. */
  blockedReason: string | null;
  /** Maior grupo aceito pela faixa (limite de pessoas e limite do formulario). */
  maxPartySize: number;
}

export function normalizeSlotTableOptions(rows: SlotTableOptionRow[] | null | undefined): SlotTableOption[] {
  return (rows ?? [])
    .filter((row) => !!row?.table_id)
    .map((row) => ({
      tableId: row.table_id,
      tableNumber: Number(row.table_number) || 0,
      sectionCode: row.section_code ?? null,
      sectionName: row.section_name ?? row.section_code ?? null,
      capacity: Math.max(Number(row.capacity) || 0, 0),
      available: row.available === true,
      conflictReservationId: row.conflict_reservation_id ?? null,
      conflictGuestName: row.conflict_guest_name ?? null,
    }));
}

function compareTables(left: SlotTableOption, right: SlotTableOption) {
  if (left.available !== right.available) return left.available ? -1 : 1;
  if (left.capacity !== right.capacity) return left.capacity - right.capacity;
  return left.tableNumber - right.tableNumber;
}

function getSectionKey(option: SlotTableOption) {
  return option.sectionCode || option.sectionName || UNSECTIONED_KEY;
}

/**
 * Agrupa as mesas da faixa por setor. Dentro do setor: livres primeiro, depois
 * menor capacidade e menor numero. Setores sem mesas visiveis sao omitidos.
 */
export function buildSlotTableAvailability(
  options: SlotTableOption[],
  filters: SlotTableAvailabilityFilters,
): SlotTableAvailability {
  const minSeats = Math.max(filters.minSeats, 0);
  const sectionsByKey = new Map<string, SlotTableSection>();
  let freeCount = 0;
  let freeSeats = 0;
  let matchingFreeCount = 0;

  options.forEach((option) => {
    if (option.available) {
      freeCount += 1;
      freeSeats += option.capacity;
    }

    if (option.capacity < minSeats) return;

    const key = getSectionKey(option);
    const section = sectionsByKey.get(key) ?? {
      key,
      label: option.sectionName || UNSECTIONED_LABEL,
      tables: [],
      freeCount: 0,
      totalCount: 0,
      freeSeats: 0,
    };

    section.totalCount += 1;
    if (option.available) {
      section.freeCount += 1;
      section.freeSeats += option.capacity;
      matchingFreeCount += 1;
    }
    if (option.available || filters.showOccupied) {
      section.tables.push(option);
    }

    sectionsByKey.set(key, section);
  });

  const sections = Array.from(sectionsByKey.values())
    .filter((section) => section.tables.length > 0)
    .map((section) => ({ ...section, tables: section.tables.slice().sort(compareTables) }))
    .sort((left, right) => {
      if (left.key === UNSECTIONED_KEY) return 1;
      if (right.key === UNSECTIONED_KEY) return -1;
      return left.label.localeCompare(right.label, 'pt-BR', { numeric: true });
    });

  return {
    sections,
    freeCount,
    totalCount: options.length,
    freeSeats,
    matchingFreeCount,
  };
}

/**
 * Espelha as validacoes de create_panel_reservation para decidir se a faixa
 * ainda aceita reservas pelo painel. O backend continua sendo a fonte final.
 */
export function getSlotBookingState(slot: SlotBookingInput): SlotBookingState {
  const remaining = slot.capacityLimit != null && slot.remainingCapacity != null
    ? Math.max(slot.remainingCapacity, 0)
    : null;
  const maxPartySize = Math.min(remaining ?? MANUAL_RESERVATION_MAX_PARTY_SIZE, MANUAL_RESERVATION_MAX_PARTY_SIZE);

  if (slot.availabilityMode === 'capacity' && !slot.capacityLimit) {
    return { blockedReason: 'Capacidade não configurada para esta faixa.', maxPartySize: 0 };
  }

  if (slot.reservationLimit != null && slot.arrivalReservationCount >= slot.reservationLimit) {
    return { blockedReason: 'Limite de reservas atingido nesta faixa.', maxPartySize };
  }

  if (remaining != null && remaining <= 0) {
    return { blockedReason: 'Limite de pessoas atingido nesta faixa.', maxPartySize: 0 };
  }

  return { blockedReason: null, maxPartySize };
}

/** Maior grupo que cabe numa mesa livre, respeitando o limite de pessoas da faixa. */
export function getTableMaxPartySize(tableCapacity: number, slotMaxPartySize: number) {
  return Math.max(Math.min(tableCapacity, slotMaxPartySize), 0);
}

/** Quantidade sugerida ao clicar numa mesa: o filtro "Cabe X" ou os lugares da mesa. */
export function getTableSuggestedPartySize(tableCapacity: number, minSeats: number, slotMaxPartySize: number) {
  const max = getTableMaxPartySize(tableCapacity, slotMaxPartySize);
  if (max <= 0) return 0;
  return minSeats > 0 ? Math.min(minSeats, max) : max;
}
