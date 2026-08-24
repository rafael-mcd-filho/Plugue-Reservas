import type { QueryClient } from '@tanstack/react-query';

export const TIME_ZONE_DEPENDENT_REPORT_QUERY_KEYS = [
  'demand-conversion-report',
  'attendance-losses-report',
  'occupancy-capacity-report',
  'customer-recurrence-report',
] as const;

export function removeTimeZoneDependentReportQueries(
  queryClient: QueryClient,
  companyId: string,
) {
  for (const queryKey of TIME_ZONE_DEPENDENT_REPORT_QUERY_KEYS) {
    queryClient.removeQueries({ queryKey: [queryKey, companyId] });
  }
}
