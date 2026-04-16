import { filterPastTimeSlotsForDate, generateTimeSlots, parseTimeSlotToMinutes } from './reservation-slots';

describe('reservation-slots', () => {
  it('parses a time slot into minutes', () => {
    expect(parseTimeSlotToMinutes('17:30')).toBe(1050);
  });

  it('generates slots in the configured interval', () => {
    expect(generateTimeSlots('17:30', '19:00')).toEqual(['17:30', '18:00', '18:30']);
  });

  it('removes slots that have already passed when the selected date is today', () => {
    const slots = ['17:30', '18:00', '18:30', '19:00'];
    const selectedDate = new Date(2026, 3, 15, 12, 0, 0);
    const now = new Date(2026, 3, 15, 18, 5, 0);

    expect(filterPastTimeSlotsForDate(slots, selectedDate, now)).toEqual(['18:30', '19:00']);
  });

  it('keeps all slots when the selected date is not today', () => {
    const slots = ['17:30', '18:00', '18:30', '19:00'];
    const selectedDate = new Date(2026, 3, 16, 12, 0, 0);
    const now = new Date(2026, 3, 15, 18, 5, 0);

    expect(filterPastTimeSlotsForDate(slots, selectedDate, now)).toEqual(slots);
  });

  it('returns an empty list when all slots for today have already passed', () => {
    const slots = ['17:30', '18:00'];
    const selectedDate = new Date(2026, 3, 15, 12, 0, 0);
    const now = new Date(2026, 3, 15, 23, 44, 0);

    expect(filterPastTimeSlotsForDate(slots, selectedDate, now)).toEqual([]);
  });
});
