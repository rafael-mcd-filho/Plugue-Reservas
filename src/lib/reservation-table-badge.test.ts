import { describe, expect, it } from 'vitest';
import { formatOccupiedTableLabel, getReservationTableBadge } from '@/lib/reservation-table-badge';

describe('formatOccupiedTableLabel', () => {
  it('mostra apenas o primeiro nome e preserva o nome completo no titulo', () => {
    expect(formatOccupiedTableLabel('  Jaiclesia   Misiam de Rezende  ')).toEqual({
      label: 'Ocupada Jaiclesia',
      title: 'Ocupada por Jaiclesia Misiam de Rezende',
    });
  });

  it('usa uma mensagem generica quando o nome nao esta disponivel', () => {
    expect(formatOccupiedTableLabel('   ')).toEqual({
      label: 'Ocupada',
      title: 'Ocupada neste horário',
    });
    expect(formatOccupiedTableLabel(null)).toEqual({
      label: 'Ocupada',
      title: 'Ocupada neste horário',
    });
  });
});

describe('getReservationTableBadge', () => {
  it('mostra numero e secao da mesa atribuida', () => {
    expect(
      getReservationTableBadge({
        tableId: 'table-1',
        table: { number: 12, section: 'Varanda' },
        status: 'confirmed',
      }),
    ).toEqual({ label: 'Mesa 12 · Varanda', tone: 'assigned' });
  });

  it('omite a secao quando a mesa nao tem uma', () => {
    expect(
      getReservationTableBadge({
        tableId: 'table-1',
        table: { number: 7, section: null },
        status: 'checked_in',
      }),
    ).toEqual({ label: 'Mesa 7', tone: 'assigned' });
  });

  it('sinaliza mesa atribuida mesmo sem encontrar a mesa no mapa', () => {
    expect(
      getReservationTableBadge({
        tableId: 'table-removida',
        table: null,
        status: 'confirmed',
      }),
    ).toEqual({ label: 'Mesa atribuída', tone: 'assigned' });
  });

  it('alerta reservas ativas sem mesa', () => {
    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        status: 'confirmed',
      }),
    ).toEqual({ label: 'Sem mesa', tone: 'unassigned' });
  });

  it('nao alerta reservas criadas por capacidade', () => {
    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        createdInMode: 'capacity',
        status: 'confirmed',
      }),
    ).toBeNull();
  });

  it('nao alerta horarios por capacidade mesmo sem created_in_mode na consulta', () => {
    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        availabilityMode: 'capacity',
        status: 'confirmed',
      }),
    ).toBeNull();
  });

  it('usa o modo do horario no lugar do created_in_mode da reserva', () => {
    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        createdInMode: 'capacity',
        availabilityMode: 'tables',
        status: 'confirmed',
      }),
    ).toEqual({ label: 'Sem mesa', tone: 'unassigned' });
  });

  it('nao alerta reservas perdidas', () => {
    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        status: 'cancelled',
      }),
    ).toBeNull();

    expect(
      getReservationTableBadge({
        tableId: null,
        table: null,
        status: 'no-show',
      }),
    ).toBeNull();
  });
});
