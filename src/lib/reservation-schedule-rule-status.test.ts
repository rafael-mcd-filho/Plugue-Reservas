import {
  getReservationScheduleRuleStatus,
  getReservationScheduleRuleStatusLabel,
  isReservationScheduleRuleExpired,
  partitionReservationScheduleRulesByEnd,
  type ReservationScheduleRuleStatusInput,
} from './reservation-schedule-rule-status';

const REFERENCE = new Date('2026-09-22T10:00:00');

function makeRule(overrides: Partial<ReservationScheduleRuleStatusInput> = {}): ReservationScheduleRuleStatusInput {
  return {
    scope: 'date_specific',
    enabled: true,
    publish_at: null,
    start_date: '2026-06-12',
    end_date: '2026-06-12',
    archived_at: null,
    ...overrides,
  };
}

describe('reservation-schedule-rule-status', () => {
  it('treats weekly rules as never expired', () => {
    const weekly = makeRule({ scope: 'weekly', start_date: null, end_date: null });
    expect(isReservationScheduleRuleExpired(weekly, REFERENCE)).toBe(false);
    expect(getReservationScheduleRuleStatus(weekly, REFERENCE)).toBe('active');
  });

  it('marks past exceptions as expired instead of active', () => {
    expect(getReservationScheduleRuleStatus(makeRule(), REFERENCE)).toBe('expired');
    expect(getReservationScheduleRuleStatusLabel('expired')).toBe('Encerrada');
  });

  it('keeps the rule of the current day out of the expired group', () => {
    const today = makeRule({ start_date: '2026-09-22', end_date: '2026-09-22' });
    expect(isReservationScheduleRuleExpired(today, REFERENCE)).toBe(false);
    expect(getReservationScheduleRuleStatus(today, REFERENCE)).toBe('active');
  });

  it('uses the last day of a date range', () => {
    const running = makeRule({ scope: 'date_range', start_date: '2026-09-01', end_date: '2026-09-30' });
    const finished = makeRule({ scope: 'date_range', start_date: '2026-08-01', end_date: '2026-08-31' });
    expect(isReservationScheduleRuleExpired(running, REFERENCE)).toBe(false);
    expect(isReservationScheduleRuleExpired(finished, REFERENCE)).toBe(true);
  });

  it('gives expiry precedence over draft and publishing states', () => {
    expect(getReservationScheduleRuleStatus(makeRule({ enabled: false }), REFERENCE)).toBe('expired');
    expect(
      getReservationScheduleRuleStatus(makeRule({ publish_at: '2026-12-01T00:00:00.000Z' }), REFERENCE),
    ).toBe('expired');
  });

  it('reports scheduled and draft states for rules still ahead', () => {
    const future = makeRule({ start_date: '2026-12-25', end_date: '2026-12-25' });
    expect(getReservationScheduleRuleStatus(future, REFERENCE)).toBe('active');
    expect(
      getReservationScheduleRuleStatus({ ...future, publish_at: '2026-12-01T00:00:00.000Z' }, REFERENCE),
    ).toBe('scheduled');
    expect(getReservationScheduleRuleStatus({ ...future, enabled: false }, REFERENCE)).toBe('draft');
  });

  it('reports archived rules regardless of dates', () => {
    const archived = makeRule({ scope: 'weekly', start_date: null, end_date: null, archived_at: '2026-09-01T12:00:00Z' });
    expect(getReservationScheduleRuleStatus(archived, REFERENCE)).toBe('archived');
  });

  it('splits rules and orders the expired ones from the most recent', () => {
    const rules = [
      makeRule({ start_date: '2026-05-28', end_date: '2026-05-28' }),
      makeRule({ start_date: '2026-10-15', end_date: '2026-10-15' }),
      makeRule({ start_date: '2026-06-12', end_date: '2026-06-12' }),
    ];

    const { current, expired } = partitionReservationScheduleRulesByEnd(rules, REFERENCE);

    expect(current.map((rule) => rule.start_date)).toEqual(['2026-10-15']);
    expect(expired.map((rule) => rule.start_date)).toEqual(['2026-06-12', '2026-05-28']);
  });
});
