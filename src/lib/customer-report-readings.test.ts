import { describe, expect, it } from 'vitest';
import { getCustomerReportReadings } from './customer-report-readings';
import type { CustomerRecurrenceReport } from '@/hooks/useCustomerRecurrenceReport';
describe('leituras de recorrência', () => {
  it('explica a cobertura e distingue retorno histórico de repetição no período', () => {
    const report = { summary: { identified_customers: 5, returning_customers: 2, recurrence_rate: 40, repeated_in_period: 1, additional_visits: 2, period_visits: 7 }, meta: { include_companions: false } } as CustomerRecurrenceReport;
    const insights = getCustomerReportReadings(report);
    expect(insights).toHaveLength(3);
    expect(insights[0].detail).toContain('Base pequena');
    expect(insights[1].detail).toContain('cliente novo também pode repetir');
    expect(insights[2].detail).toContain('7 visitas');
  });
});
