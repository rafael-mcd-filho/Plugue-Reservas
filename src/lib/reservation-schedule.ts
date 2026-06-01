export function normalizeReservationScheduleSlot(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function sortReservationScheduleSlots(slots: readonly string[]): string[] {
  return [...new Set(slots.map(normalizeReservationScheduleSlot).filter((slot): slot is string => !!slot))]
    .sort((left, right) => left.localeCompare(right));
}

export function sortReservationScheduleSlotSettings<T extends { time: string }>(slots: readonly T[]): T[] {
  const slotsByTime = new Map<string, T>();

  slots.forEach((slot) => {
    const time = normalizeReservationScheduleSlot(slot.time);
    if (!time || slotsByTime.has(time)) return;
    slotsByTime.set(time, { ...slot, time });
  });

  return [...slotsByTime.values()].sort((left, right) => left.time.localeCompare(right.time));
}

export function generateReservationScheduleSlots(
  start: string,
  end: string,
  intervalMinutes: number,
): string[] {
  const normalizedStart = normalizeReservationScheduleSlot(start);
  const normalizedEnd = normalizeReservationScheduleSlot(end);
  if (!normalizedStart || !normalizedEnd || intervalMinutes <= 0) return [];

  const toMinutes = (slot: string) => {
    const [hours, minutes] = slot.split(':').map(Number);
    return (hours * 60) + minutes;
  };

  const startMinutes = toMinutes(normalizedStart);
  const endMinutes = toMinutes(normalizedEnd);
  if (startMinutes > endMinutes) return [];

  const slots: string[] = [];
  for (let current = startMinutes; current <= endMinutes; current += intervalMinutes) {
    const hours = Math.floor(current / 60);
    const minutes = current % 60;
    slots.push(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
  }

  return slots;
}
