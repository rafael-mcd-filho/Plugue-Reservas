import {
  formatScheduleDurationLabel,
  formatScheduleSlotLimitsDetail,
  formatShortWeekdaysLabel,
  summarizeScheduleSlotLimits,
} from './reservation-schedule-rule-summary';

describe('reservation-schedule-rule-summary', () => {
  it('formats durations in hours and minutes', () => {
    expect(formatScheduleDurationLabel(90)).toBe('1h30');
    expect(formatScheduleDurationLabel(120)).toBe('2h');
    expect(formatScheduleDurationLabel(45)).toBe('45min');
    expect(formatScheduleDurationLabel(null)).toBe('');
  });

  it('shortens weekdays starting on monday', () => {
    expect(formatShortWeekdaysLabel([0, 2, 3, 4])).toBe('Ter, Qua, Qui, Dom');
    expect(formatShortWeekdaysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('Todos os dias');
    expect(formatShortWeekdaysLabel([])).toBe('Todos os dias');
    expect(formatShortWeekdaysLabel(null, 'Nenhum dia')).toBe('Nenhum dia');
  });

  it('summarizes limits shared by every slot', () => {
    const slots = [
      { max_party_size_per_reservation: 2, max_reservations_per_slot: 57 },
      { max_party_size_per_reservation: 2, max_reservations_per_slot: 57 },
    ];

    expect(summarizeScheduleSlotLimits(slots)).toBe('até 2 pessoas · 57 reservas por horário');
  });

  it('returns null when slots have no limits or diverge', () => {
    expect(summarizeScheduleSlotLimits([])).toBeNull();
    expect(summarizeScheduleSlotLimits([{ time: '18:00' } as never])).toBeNull();
    expect(summarizeScheduleSlotLimits([
      { max_reservations_per_slot: 10 },
      { max_reservations_per_slot: 4 },
    ])).toBeNull();
  });

  it('keeps the per-slot detail available for divergent slots', () => {
    expect(formatScheduleSlotLimitsDetail({ duration_minutes: 90, max_guests_per_slot: 30 }))
      .toBe(' · 1h30 · 30 lugares por horário');
    expect(formatScheduleSlotLimitsDetail({})).toBe('');
  });
});
