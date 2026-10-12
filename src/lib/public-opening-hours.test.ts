import { describe, expect, it } from 'vitest';
import {
  buildOpeningHourGroups,
  getOpeningScheduleDates,
  getOpeningStatus,
  resolveOpeningHourForDate,
  type OpeningHour,
} from '@/lib/public-opening-hours';
import type { PublicReservationSchedule } from '@/lib/public-reservation-schedule';

const hours: OpeningHour[] = [
  { day: 'Seg', open: '17:00', close: '22:30', closed: true },
  { day: 'Ter', open: '17:00', close: '22:30', closed: false },
  { day: 'Qua', open: '17:00', close: '22:30', closed: false },
  { day: 'Qui', open: '17:00', close: '22:30', closed: false },
  { day: 'Sex', open: '17:00', close: '22:30', closed: false },
  { day: 'Sáb', open: '17:30', close: '22:30', closed: false },
  { day: 'Dom', open: '17:00', close: '22:30', closed: false },
];

function schedules(date = '2026-10-12', source: PublicReservationSchedule['source'] = 'date_specific', slots = ['19:00', '20:00']) {
  return new Map<string, PublicReservationSchedule>([[date, {
    source, slots, rule_id: 'rule-1', rule_name: 'Dia das crianças',
    block_id: null, block_name: null, max_party_size_per_reservation: null,
    availability_mode: 'tables', default_duration_minutes: null,
  }]]);
}

describe('public opening hours with reservation rules', () => {
  it('opens a normally closed Monday using the company hours, not reservation slots', () => {
    const now = new Date(2026, 9, 12, 18);
    const rules = schedules();
    expect(resolveOpeningHourForDate(hours, now, rules)).toEqual({
      day: 'Seg', open: '17:00', close: '22:30', closed: false,
    });
    expect(getOpeningStatus(hours, now, rules)).toEqual({
      title: 'Aberto agora', description: 'Fecha às 22:30', variant: 'open',
    });
    expect(buildOpeningHourGroups(hours, now, rules)[0]).toEqual({
      label: 'Segunda · hoje', open: '17:00', close: '22:30', closed: false, isToday: true,
    });
    expect(hours[0].closed).toBe(true);
  });

  it('uses normal opening time before service and normal closing time after the last reservation slot', () => {
    expect(getOpeningStatus(hours, new Date(2026, 9, 12, 16), schedules())).toEqual({
      title: 'Abre hoje', description: 'Abre às 17:00', variant: 'closed',
    });
    expect(getOpeningStatus(hours, new Date(2026, 9, 12, 22, 15), schedules())?.title).toBe('Aberto agora');
    expect(getOpeningStatus(hours, new Date(2026, 9, 12, 22, 30), schedules())?.title).toBe('Abre amanhã');
  });

  it.each(['weekly', 'date_range'] as const)('also considers an effective %s rule', (source) => {
    expect(resolveOpeningHourForDate(hours, new Date(2026, 9, 12), schedules('2026-10-12', source))?.closed).toBe(false);
  });

  it('keeps the regular Monday closed when the resolver returns default (no active exception)', () => {
    expect(getOpeningStatus(hours, new Date(2026, 9, 12, 18), schedules('2026-10-12', 'default', []))?.title).toBe('Abre amanhã');
    expect(buildOpeningHourGroups(hours, new Date(2026, 9, 12), new Map())[0].closed).toBe(true);
  });

  it('does not carry a date-specific exception over to the following Monday', () => {
    const nextMonday = new Date(2026, 9, 19, 18);
    expect(resolveOpeningHourForDate(hours, nextMonday, schedules())?.closed).toBe(true);
    expect(getOpeningStatus(hours, nextMonday, schedules())?.title).toBe('Abre amanhã');
  });

  it('respects an all-day block on a normally open day', () => {
    const now = new Date(2026, 9, 13, 18);
    const rules = schedules('2026-10-13', 'blocked', []);
    expect(resolveOpeningHourForDate(hours, now, rules)?.closed).toBe(true);
    expect(buildOpeningHourGroups(hours, now, rules).find((row) => row.isToday)?.closed).toBe(true);
    expect(getOpeningStatus(hours, now, rules)?.title).toBe('Abre amanhã');
  });

  it('skips blocked future dates when announcing the next opening', () => {
    expect(getOpeningStatus(hours, new Date(2026, 9, 12, 18), schedules('2026-10-13', 'blocked', []))?.title)
      .toBe('Abre quarta-feira, 14/10');
  });

  it('shows tomorrow when a rule opens a normally closed day tomorrow', () => {
    expect(getOpeningStatus(hours, new Date(2026, 9, 11, 23), schedules())?.title).toBe('Abre amanhã');
  });

  it('keeps yesterday\'s exception open past midnight using the company closing time', () => {
    const overnight = hours.map((hour) => hour.day === 'Seg' ? { ...hour, close: '01:00' } : hour);
    expect(getOpeningStatus(overnight, new Date(2026, 9, 13, 0, 30), schedules())).toEqual({
      title: 'Aberto agora', description: 'Fecha às 01:00', variant: 'open',
    });
  });

  it('requests yesterday and the next eight days across month boundaries', () => {
    const dates = getOpeningScheduleDates(new Date(2026, 9, 31, 18));
    expect(dates).toHaveLength(10);
    expect(dates[0]).toBe('2026-10-30');
    expect(dates.at(-1)).toBe('2026-11-08');
  });
});
