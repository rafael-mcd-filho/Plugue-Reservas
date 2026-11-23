import type { CompanyPanelPermission } from '@/lib/companyPermissions';

export type ServiceTodayPeriod = 'all' | 'lunch' | 'dinner';
export type ServiceTodayTab = 'arrivals' | 'salon' | 'waitlist';
export interface ServiceTodayFreshness {
  updatedAt: number | null;
  fetching: boolean;
  hasError: boolean;
}

export interface ServiceTodayContext {
  date: string;
  search: string;
  section: string;
  period: ServiceTodayPeriod;
  timeZone?: string;
  referenceTime?: string;
  onOpenSalon?: (tableId?: string) => void;
  onSectionsChange?: (sections: string[]) => void;
  canViewReservations?: boolean;
  canViewLeads?: boolean;
  canViewEvents?: boolean;
  onFreshnessChange?: (freshness: ServiceTodayFreshness) => void;
}

export const SERVICE_TODAY_PERMISSION_SETS: CompanyPanelPermission[][] = [
  ['checkins_view'], ['waitlist_view'], ['tables_view', 'reservations_view'],
];

export function getServiceTodayTabs(hasPermission: (permission: CompanyPanelPermission) => boolean): ServiceTodayTab[] {
  const tabs: ServiceTodayTab[] = [];
  if (hasPermission('checkins_view')) tabs.push('arrivals');
  if (hasPermission('tables_view') && hasPermission('reservations_view')) tabs.push('salon');
  if (hasPermission('waitlist_view')) tabs.push('waitlist');
  return tabs;
}

export function getServiceTodayClock(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}:${value('second')}`,
  };
}

export function isServiceTimeInPeriod(time: string, period: ServiceTodayPeriod) {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return false;
  if (period === 'all') return true;
  return period === 'lunch' ? Number(match[1]) < 18 : Number(match[1]) >= 18;
}
