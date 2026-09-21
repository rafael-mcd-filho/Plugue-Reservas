import { describe, expect, it } from 'vitest';
import {
  findBestTableCombination,
  orderSelectedTableIds,
  type TableCombinationOption,
} from './reservation-table-selection';

function table(
  tableNumber: number,
  capacity: number,
  sectionCode = 'SALAO',
  available = true,
): TableCombinationOption {
  return {
    table_id: `table-${tableNumber}`,
    table_number: tableNumber,
    section_code: sectionCode,
    capacity,
    available,
  };
}

describe('findBestTableCombination', () => {
  it('combina todas as mesas necessárias para uma reserva grande', () => {
    const result = findBestTableCombination([
      table(1, 10),
      table(2, 10),
      table(3, 10),
      table(4, 12),
    ], 40);

    expect(result.map((option) => option.table_number)).toEqual([1, 2, 3, 4]);
    expect(result.reduce((sum, option) => sum + option.capacity, 0)).toBe(42);
  });

  it('prioriza capacidade exata antes de usar menos mesas', () => {
    const result = findBestTableCombination([
      table(1, 10),
      table(2, 4),
      table(3, 5),
    ], 9);

    expect(result.map((option) => option.table_number)).toEqual([2, 3]);
  });

  it('desconsidera mesas ocupadas', () => {
    const result = findBestTableCombination([
      table(1, 8, 'SALAO', false),
      table(2, 5),
      table(3, 5),
    ], 8);

    expect(result.map((option) => option.table_number)).toEqual([2, 3]);
  });

  it('prefere menos setores quando capacidade e quantidade empatam', () => {
    const result = findBestTableCombination([
      table(1, 5, 'A'),
      table(2, 5, 'B'),
      table(3, 5, 'A'),
    ], 10);

    expect(result.map((option) => option.table_number)).toEqual([1, 3]);
  });

  it('preserva alternativas de setor necessárias para o melhor resultado final', () => {
    const result = findBestTableCombination([
      table(1, 2, 'A'),
      table(2, 2, 'A'),
      table(3, 1, 'B'),
      table(4, 3, 'C'),
      table(5, 10, 'B'),
      table(6, 20, 'C'),
    ], 34);

    expect(new Set(result.map((option) => option.section_code))).toEqual(new Set(['B', 'C']));
  });

  it('retorna vazio quando a capacidade livre não atende ao grupo', () => {
    expect(findBestTableCombination([table(1, 6)], 10)).toEqual([]);
  });

  it('mantém a mesa primária e a ordem atual ao adicionar novas mesas', () => {
    expect(orderSelectedTableIds(
      [
        { table_id: 'table-12', sort_order: 0 },
        { table_id: 'table-10', sort_order: 1 },
      ],
      new Set(['table-12', 'table-10', 'table-8']),
      ['table-8', 'table-10', 'table-12'],
    )).toEqual(['table-12', 'table-10', 'table-8']);
  });
});
