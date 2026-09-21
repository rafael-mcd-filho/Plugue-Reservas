import { describe, expect, it } from 'vitest';
import {
  buildSlotTableAvailability,
  getSlotBookingState,
  getTableSuggestedPartySize,
  normalizeSlotTableOptions,
  type SlotTableOption,
} from './calendar-slot-availability';

function table(
  tableNumber: number,
  capacity: number,
  sectionName: string | null = 'Salão',
  available = true,
): SlotTableOption {
  return {
    tableId: `table-${tableNumber}`,
    tableNumber,
    sectionCode: sectionName ? sectionName.toUpperCase() : null,
    sectionName,
    capacity,
    available,
    conflictReservationId: available ? null : `reservation-${tableNumber}`,
    conflictGuestName: available ? null : 'Ana Souza',
  };
}

describe('normalizeSlotTableOptions', () => {
  it('converte números vindos como texto e usa o código quando não há nome de setor', () => {
    const [option] = normalizeSlotTableOptions([{
      table_id: 'table-1',
      table_number: '12',
      section_code: 'VARANDA',
      section_name: null,
      capacity: '4',
      available: true,
      conflict_reservation_id: null,
      conflict_guest_name: null,
    }]);

    expect(option).toMatchObject({ tableNumber: 12, capacity: 4, sectionName: 'VARANDA', available: true });
  });
});

describe('buildSlotTableAvailability', () => {
  const options = [
    table(9, 6),
    table(7, 4, 'Salão', false),
    table(3, 4),
    table(1, 2),
    table(21, 4, 'Varanda'),
    table(30, 2, null),
  ];

  it('agrupa por setor, ordena livres por lugares e deixa "Sem setor" por último', () => {
    const result = buildSlotTableAvailability(options, { showOccupied: false, minSeats: 0 });

    expect(result.sections.map((section) => section.label)).toEqual(['Salão', 'Varanda', 'Sem setor']);
    expect(result.sections[0].tables.map((option) => option.tableNumber)).toEqual([1, 3, 9]);
    expect(result).toMatchObject({ freeCount: 5, totalCount: 6, freeSeats: 18, matchingFreeCount: 5 });
    expect(result.sections[0]).toMatchObject({ freeCount: 3, totalCount: 4, freeSeats: 12 });
  });

  it('mostra ocupadas depois das livres quando "Todas" está ativo', () => {
    const result = buildSlotTableAvailability(options, { showOccupied: true, minSeats: 0 });

    expect(result.sections[0].tables.map((option) => option.tableNumber)).toEqual([1, 3, 9, 7]);
  });

  it('aplica o filtro "Cabe X" nas linhas e nos contadores dos setores, mas não no total', () => {
    const result = buildSlotTableAvailability(options, { showOccupied: false, minSeats: 4 });

    expect(result.sections.map((section) => section.label)).toEqual(['Salão', 'Varanda']);
    expect(result.sections[0].tables.map((option) => option.tableNumber)).toEqual([3, 9]);
    expect(result.sections[0]).toMatchObject({ freeCount: 2, totalCount: 3, freeSeats: 10 });
    expect(result).toMatchObject({ freeCount: 5, matchingFreeCount: 3 });
  });

  it('omite setores sem mesas visíveis', () => {
    const result = buildSlotTableAvailability(
      [table(1, 4, 'Mezanino', false), table(2, 4)],
      { showOccupied: false, minSeats: 0 },
    );

    expect(result.sections.map((section) => section.label)).toEqual(['Salão']);
  });
});

describe('getSlotBookingState', () => {
  const base = {
    availabilityMode: 'capacity' as const,
    capacityLimit: 186,
    remainingCapacity: 171,
    reservationLimit: null,
    arrivalReservationCount: 5,
  };

  it('limita o maior grupo ao formulário manual quando sobram muitas vagas', () => {
    expect(getSlotBookingState(base)).toEqual({ blockedReason: null, maxPartySize: 50 });
  });

  it('limita o maior grupo às vagas restantes', () => {
    expect(getSlotBookingState({ ...base, remainingCapacity: 5 })).toEqual({ blockedReason: null, maxPartySize: 5 });
  });

  it('bloqueia quando o limite de pessoas foi atingido', () => {
    expect(getSlotBookingState({ ...base, remainingCapacity: 0 }).blockedReason).toBe('Limite de pessoas atingido nesta faixa.');
  });

  it('bloqueia quando o limite de reservas foi atingido mesmo com vagas', () => {
    expect(getSlotBookingState({ ...base, reservationLimit: 5 }).blockedReason).toBe('Limite de reservas atingido nesta faixa.');
  });

  it('bloqueia o modo por capacidade sem capacidade configurada', () => {
    expect(getSlotBookingState({ ...base, capacityLimit: null, remainingCapacity: null }).blockedReason)
      .toBe('Capacidade não configurada para esta faixa.');
  });

  it('não limita pessoas no modo por mesas sem limite configurado', () => {
    expect(getSlotBookingState({
      ...base,
      availabilityMode: 'tables',
      capacityLimit: null,
      remainingCapacity: null,
    })).toEqual({ blockedReason: null, maxPartySize: 50 });
  });
});

describe('getTableSuggestedPartySize', () => {
  it('usa os lugares da mesa sem filtro', () => {
    expect(getTableSuggestedPartySize(4, 0, 50)).toBe(4);
  });

  it('usa o filtro "Cabe X" quando preenchido', () => {
    expect(getTableSuggestedPartySize(6, 3, 50)).toBe(3);
  });

  it('respeita as vagas restantes da faixa', () => {
    expect(getTableSuggestedPartySize(6, 0, 2)).toBe(2);
  });
});
