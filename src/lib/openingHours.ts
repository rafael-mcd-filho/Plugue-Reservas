export const CANONICAL_DAY_BY_INDEX: Record<number, string> = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sáb',
};

const DAY_INDEX_BY_NORMALIZED: Record<string, number> = {
  dom: 0,
  domingo: 0,
  seg: 1,
  segunda: 1,
  'segunda-feira': 1,
  ter: 2,
  terca: 2,
  'terca-feira': 2,
  qua: 3,
  quarta: 3,
  'quarta-feira': 3,
  qui: 4,
  quinta: 4,
  'quinta-feira': 4,
  sex: 5,
  sexta: 5,
  'sexta-feira': 5,
  sab: 6,
  sabado: 6,
};

export function normalizeDayName(value: string | undefined | null): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function getDayIndexFromName(value: string | undefined | null): number | null {
  const normalized = normalizeDayName(value);
  if (!normalized) return null;
  const index = DAY_INDEX_BY_NORMALIZED[normalized];
  return typeof index === 'number' ? index : null;
}

export function findOpeningHoursForDayIndex<T extends { day: string }>(
  hours: readonly T[] | null | undefined,
  dayIndex: number,
): T | null {
  if (!hours) return null;
  for (const hour of hours) {
    if (getDayIndexFromName(hour.day) === dayIndex) {
      return hour;
    }
  }
  return null;
}

export function getCanonicalDayLabel(dayIndex: number): string {
  return CANONICAL_DAY_BY_INDEX[dayIndex] ?? '';
}
