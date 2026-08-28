import { format } from 'date-fns';

interface DashboardReportSearchOptions {
  period: string;
  startDate: Date;
  endDate: Date;
}

const DASHBOARD_TO_REPORT_PRESET: Record<string, string> = {
  today: 'today',
  yesterday: 'yesterday',
  this_month: 'current_month',
  last_month: 'previous_month',
  '7': 'last_7_days',
  '30': 'last_30_days',
};

export function buildDashboardReportSearch({
  period,
  startDate,
  endDate,
}: DashboardReportSearchOptions): string {
  const search = new URLSearchParams();
  const reportPreset = DASHBOARD_TO_REPORT_PRESET[period];

  if (reportPreset) {
    search.set('period', reportPreset);
  } else {
    search.set('period', 'custom');
    search.set('from', format(startDate, 'yyyy-MM-dd'));
    search.set('to', format(endDate, 'yyyy-MM-dd'));
  }

  // The dashboard is daily. Keeping this lens avoids an apparent data change
  // when the user follows a shortcut into a detailed report.
  search.set('granularity', 'day');

  return `?${search.toString()}`;
}
