export interface TableCombinationOption {
  table_id: string;
  table_number: number;
  section_code: string | null;
  capacity: number;
  available: boolean;
}

export interface CurrentTableAssignment {
  table_id: string;
  sort_order: number;
}

function countSections(options: TableCombinationOption[]) {
  return new Set(options.map((option) => option.section_code ?? '')).size;
}

function compareSameCapacityCombinations<T extends TableCombinationOption>(
  left: T[],
  right: T[],
) {
  if (left.length !== right.length) return left.length - right.length;

  const sectionDifference = countSections(left) - countSections(right);
  if (sectionDifference !== 0) return sectionDifference;

  const leftNumbers = left.map((option) => option.table_number).sort((a, b) => a - b).join(',');
  const rightNumbers = right.map((option) => option.table_number).sort((a, b) => a - b).join(',');
  return leftNumbers.localeCompare(rightNumbers, 'pt-BR', { numeric: true });
}

/**
 * Escolhe mesas livres nesta ordem: menor sobra de lugares, menos mesas,
 * menos setores diferentes e, por fim, menor numeração.
 */
export function findBestTableCombination<T extends TableCombinationOption>(
  options: T[],
  partySize: number,
) {
  const target = Math.max(1, partySize);
  const eligibleOptions = options.filter((option) => option.available && option.capacity > 0);
  const combinationsByCapacityAndSections = new Map<number, Map<string, T[]>>([
    [0, new Map([['', []]])],
  ]);

  eligibleOptions.forEach((option) => {
    const currentCombinations = Array.from(combinationsByCapacityAndSections.entries())
      .flatMap(([capacity, combinationsBySections]) => (
        Array.from(combinationsBySections.values()).map((combination) => [capacity, combination] as const)
      ));

    currentCombinations.forEach(([capacity, combination]) => {
      const nextCapacity = capacity + option.capacity;
      const nextCombination = [...combination, option];
      const sectionSignature = Array.from(new Set(
        nextCombination.map((item) => item.section_code ?? ''),
      )).sort().join('|');
      const combinationsBySections = combinationsByCapacityAndSections.get(nextCapacity) ?? new Map<string, T[]>();
      const existing = combinationsBySections.get(sectionSignature);

      if (!existing || compareSameCapacityCombinations(nextCombination, existing) < 0) {
        combinationsBySections.set(sectionSignature, nextCombination);
        combinationsByCapacityAndSections.set(nextCapacity, combinationsBySections);
      }
    });
  });

  return Array.from(combinationsByCapacityAndSections.entries())
    .flatMap(([capacity, combinationsBySections]) => (
      Array.from(combinationsBySections.values()).map((combination) => [capacity, combination] as const)
    ))
    .filter(([capacity]) => capacity >= target)
    .sort(([leftCapacity, left], [rightCapacity, right]) => (
      leftCapacity - rightCapacity || compareSameCapacityCombinations(left, right)
    ))[0]?.[1] ?? [];
}

export function orderSelectedTableIds(
  currentAssignments: CurrentTableAssignment[],
  selectedTableIds: Set<string>,
  displayedTableIds: string[],
) {
  const retainedAssignments = currentAssignments
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((assignment) => assignment.table_id)
    .filter((tableId) => selectedTableIds.has(tableId));
  const retainedIds = new Set(retainedAssignments);
  const displayOrder = new Map(displayedTableIds.map((tableId, index) => [tableId, index]));
  const newlySelected = Array.from(selectedTableIds)
    .filter((tableId) => !retainedIds.has(tableId))
    .sort(
      (left, right) => (displayOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (displayOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  return [...retainedAssignments, ...newlySelected];
}
