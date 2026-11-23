import { describe, expect, it } from 'vitest';
import { resolveCompanyPanelPermissions } from '@/lib/companyPermissions';
import { getServiceTodayClock, getServiceTodayTabs, isServiceTimeInPeriod } from './service-today';

describe('Service today access and unit clock', () => {
  it('keeps the administrator and default operator permissions unchanged', () => {
    const admin = resolveCompanyPanelPermissions(['admin']);
    const operator = resolveCompanyPanelPermissions(['operator']);
    expect(getServiceTodayTabs(permission => admin.has(permission))).toEqual(['arrivals', 'salon', 'waitlist']);
    expect(getServiceTodayTabs(permission => operator.has(permission))).toEqual(['arrivals', 'waitlist']);
  });
  it.each([
    [[], []], [['waitlist_view'], ['waitlist']], [['checkins_view'], ['arrivals']],
    [['tables_view'], []], [['reservations_view'], []], [['tables_view', 'reservations_view'], ['salon']],
  ])('opens only explicitly authorized views for %j', (permissions, expected) => {
    expect(getServiceTodayTabs(permission => (permissions as string[]).includes(permission))).toEqual(expected);
  });
  it('resolves the day and wall clock in the unit rather than the browser timezone', () => {
    const instant = new Date('2026-11-23T02:59:59Z');
    expect(getServiceTodayClock('America/Sao_Paulo', instant)).toEqual({ date: '2026-11-22', time: '23:59:59' });
    expect(getServiceTodayClock('Asia/Tokyo', instant)).toEqual({ date: '2026-11-23', time: '11:59:59' });
    expect(getServiceTodayClock('America/Sao_Paulo', new Date('2026-11-23T03:00:00Z'))).toEqual({ date: '2026-11-23', time: '00:00:00' });
  });
  it('does not duplicate or drop the 18h period boundary', () => {
    expect(isServiceTimeInPeriod('17:59:59', 'lunch')).toBe(true);
    expect(isServiceTimeInPeriod('18:00:00', 'lunch')).toBe(false);
    expect(isServiceTimeInPeriod('18:00:00', 'dinner')).toBe(true);
    expect(isServiceTimeInPeriod('00:00:00', 'all')).toBe(true);
    expect(isServiceTimeInPeriod('24:00', 'all')).toBe(false);
    expect(isServiceTimeInPeriod('18:60', 'dinner')).toBe(false);
  });
});
