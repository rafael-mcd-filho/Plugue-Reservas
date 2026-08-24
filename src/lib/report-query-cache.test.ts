import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { removeTimeZoneDependentReportQueries } from '@/lib/report-query-cache';

describe('removeTimeZoneDependentReportQueries', () => {
  it('removes every time-zone-dependent report cache and preserves unrelated data', () => {
    const queryClient = new QueryClient();
    const reportKeys = [
      ['demand-conversion-report', 'company-1'],
      ['attendance-losses-report', 'company-1'],
      ['occupancy-capacity-report', 'company-1'],
      ['customer-recurrence-report', 'company-1'],
    ] as const;

    for (const queryKey of reportKeys) {
      queryClient.setQueryData(queryKey, { timeZone: 'America/Fortaleza' });
      queryClient.setQueryData([queryKey[0], 'company-2'], { timeZone: 'America/Manaus' });
    }
    queryClient.setQueryData(['company-settings', 'company-1'], { name: 'Empresa' });

    removeTimeZoneDependentReportQueries(queryClient, 'company-1');

    for (const queryKey of reportKeys) {
      expect(queryClient.getQueryData(queryKey)).toBeUndefined();
      expect(queryClient.getQueryData([queryKey[0], 'company-2'])).toEqual({
        timeZone: 'America/Manaus',
      });
    }
    expect(queryClient.getQueryData(['company-settings', 'company-1'])).toEqual({ name: 'Empresa' });
  });
});
