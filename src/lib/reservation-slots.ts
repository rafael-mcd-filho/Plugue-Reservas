import { isSameDay } from 'date-fns';

export function parseTimeSlotToMinutes(slot: string): number {
  const [hours, minutes] = slot.split(':').map(Number);
  return (hours * 60) + minutes;
}

export function generateTimeSlots(open: string, close: string, interval: number = 30): string[] {
  const slots: string[] = [];
  const [openHours, openMinutes] = open.split(':').map(Number);
  const [closeHours, closeMinutes] = close.split(':').map(Number);
  let current = (openHours * 60) + openMinutes;
  const end = (closeHours * 60) + closeMinutes;

  while (current < end) {
    const hours = Math.floor(current / 60);
    const minutes = current % 60;
    slots.push(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
    current += interval;
  }

  return slots;
}

export function filterPastTimeSlotsForDate(
  slots: string[],
  selectedDate: Date | undefined,
  now: Date = new Date(),
): string[] {
  if (!selectedDate || !isSameDay(selectedDate, now)) {
    return slots;
  }

  const currentMinutes = (now.getHours() * 60) + now.getMinutes();
  return slots.filter((slot) => parseTimeSlotToMinutes(slot) > currentMinutes);
}
