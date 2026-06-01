import {
  generateReservationScheduleSlots,
  normalizeReservationScheduleSlot,
  sortReservationScheduleSlotSettings,
  sortReservationScheduleSlots,
} from './reservation-schedule';

describe('reservation-schedule', () => {
  it('normalizes API time values to hours and minutes', () => {
    expect(normalizeReservationScheduleSlot('8:30:00')).toBe('08:30');
    expect(normalizeReservationScheduleSlot('21:45')).toBe('21:45');
  });

  it('sorts slots and removes duplicates', () => {
    expect(sortReservationScheduleSlots(['21:30', '18:00:00', '18:00', '19:30'])).toEqual([
      '18:00',
      '19:30',
      '21:30',
    ]);
  });

  it('sorts configured slots while preserving the first configuration for each time', () => {
    expect(sortReservationScheduleSlotSettings([
      { time: '19:30:00', maxReservations: 3 },
      { time: '18:00', maxReservations: null },
      { time: '19:30', maxReservations: 8 },
    ])).toEqual([
      { time: '18:00', maxReservations: null },
      { time: '19:30', maxReservations: 3 },
    ]);
  });

  it('generates an inclusive list that can be edited afterwards', () => {
    expect(generateReservationScheduleSlots('18:00', '19:30', 30)).toEqual([
      '18:00',
      '18:30',
      '19:00',
      '19:30',
    ]);
  });

  it('does not generate slots for an invalid range', () => {
    expect(generateReservationScheduleSlots('20:00', '18:00', 30)).toEqual([]);
  });
});
