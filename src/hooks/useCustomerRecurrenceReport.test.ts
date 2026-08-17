import { describe, expect, it } from 'vitest';
import {
  buildCustomerRecurrenceQueryKey,
  buildCustomerRecurrenceRpcParams,
  isSameCustomerRecurrenceDataset,
  normalizeCustomerRecurrenceReport,
  normalizeMinimumTotalVisits,
  resolveCustomerRecurrenceDisplayedPage,
} from '@/hooks/useCustomerRecurrenceReport';

const fallback = {
  periodStart: '2026-08-01',
  periodEnd: '2026-08-13',
  includeCompanions: false,
  page: 1,
  pageSize: 12,
};

describe('normalizeCustomerRecurrenceReport', () => {
  it('normaliza números do Postgres e preserva o contrato do relatório', () => {
    const report = normalizeCustomerRecurrenceReport({
      summary: {
        identified_customers: '10',
        returning_customers: '4',
        new_customers: 6,
        recurrence_rate: '40.0',
        repeated_in_period: 2,
        repeat_rate: 20,
        additional_visits: 3,
        period_visits: 13,
        avg_visits_per_customer: '1.3',
      },
      comparison: {
        period_start: '2026-07-01',
        period_end: '2026-07-13',
        identified_customers: 8,
      },
      frequency_bands: [
        { key: 'one', label: '1 visita', min_visits: 1, max_visits: 1, customers: '6', percentage: '60' },
      ],
      monthly_composition: [
        { month: '2026-08-01', identified_customers: '10', new_customers: 6, returning_customers: 4, recurrence_rate: 40 },
      ],
      customers: [
        {
          customer_key: 'customer:company:5585999990000',
          phone_normalized: '5585999990000',
          guest_name: 'Ana',
          guest_phone: '(85) 99999-0000',
          first_visit_date: '2026-06-01',
          last_visit_date: '2026-08-10',
          previous_visit_date: '2026-06-01',
          prior_visits: '1',
          period_visits: '2',
          total_visits: '3',
          customer_type: 'returning',
          frequency_band: 'three_four',
          next_reservation_date: null,
        },
      ],
      meta: {
        period_start: '2026-08-01',
        period_end: '2026-08-13',
        include_companions: false,
        page: 1,
        page_size: 12,
        customers_total: '10',
        filtered_customers_total: '10',
        min_total_visits: '2',
        generated_at: '2026-08-13T12:00:00Z',
      },
    }, fallback);

    expect(report.summary).toMatchObject({
      identified_customers: 10,
      returning_customers: 4,
      recurrence_rate: 40,
      avg_visits_per_customer: 1.3,
    });
    expect(report.frequency_bands[0]).toMatchObject({ key: 'one', customers: 6, percentage: 60 });
    expect(report.customers[0]).toMatchObject({
      guest_name: 'Ana',
      customer_key: 'customer:1',
      guest_phone: null,
      phone_normalized: '0000',
      prior_visits: 1,
      period_visits: 2,
      customer_type: 'returning',
      frequency_band: 'three_four',
    });
    expect(report.meta.customers_total).toBe(10);
    expect(report.meta.min_total_visits).toBe(2);
  });

  it('usa metadados de fallback e ignora linhas inválidas', () => {
    const report = normalizeCustomerRecurrenceReport({
      summary: null,
      comparison: null,
      frequency_bands: [{ key: 'invalid' }],
      monthly_composition: [{ month: null }],
      customers: [{ customer_key: '' }],
      meta: {},
    }, fallback);

    expect(report.summary.identified_customers).toBe(0);
    expect(report.frequency_bands).toEqual([]);
    expect(report.monthly_composition).toEqual([]);
    expect(report.customers).toEqual([]);
    expect(report.meta).toMatchObject({
      period_start: fallback.periodStart,
      period_end: fallback.periodEnd,
      page: fallback.page,
      page_size: fallback.pageSize,
    });
  });

  it('falha de forma explícita quando a RPC não retorna um objeto', () => {
    expect(() => normalizeCustomerRecurrenceReport(null, fallback)).toThrow(
      'O relatório de recorrência não retornou dados válidos.',
    );
  });
});

describe('consulta paginada de recorrência', () => {
  const params = {
    companyId: '00000000-0000-0000-0000-000000000001',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-17',
    comparisonMode: 'month_to_date' as const,
    includeCompanions: false,
    page: 28,
    pageSize: 12,
    search: '  João  ',
    minTotalVisits: 2,
  };

  it('envia página e mínimo de visitas para a RPC sem consulta client-side limitada a 1.000 linhas', () => {
    expect(buildCustomerRecurrenceRpcParams(params)).toEqual({
      _company_id: params.companyId,
      _period_start: params.periodStart,
      _period_end: params.periodEnd,
      _comparison_mode: 'month_to_date',
      _include_companions: false,
      _page: 28,
      _page_size: 12,
      _search: 'João',
      _min_total_visits: 2,
    });
  });

  it('separa páginas no cache e só reaproveita placeholder quando os filtros são iguais', () => {
    const firstPageKey = buildCustomerRecurrenceQueryKey({ ...params, page: 1 });
    const page28Key = buildCustomerRecurrenceQueryKey(params);
    const anotherMinimumKey = buildCustomerRecurrenceQueryKey({ ...params, minTotalVisits: 3 });

    expect(page28Key).not.toEqual(firstPageKey);
    expect(isSameCustomerRecurrenceDataset(firstPageKey, page28Key)).toBe(true);
    expect(isSameCustomerRecurrenceDataset(page28Key, anotherMinimumKey)).toBe(false);
  });

  it('mantém o rodapé na página da resposta enquanto a nova página ainda carrega', () => {
    expect(resolveCustomerRecurrenceDisplayedPage(28, 1)).toBe(1);
    expect(resolveCustomerRecurrenceDisplayedPage(28, 28)).toBe(28);
    expect(resolveCustomerRecurrenceDisplayedPage(28)).toBe(28);
  });

  it('aceita somente mínimos inteiros positivos', () => {
    expect(normalizeMinimumTotalVisits(2.9)).toBe(2);
    expect(normalizeMinimumTotalVisits(0)).toBeNull();
    expect(normalizeMinimumTotalVisits(Number.NaN)).toBeNull();
    expect(normalizeMinimumTotalVisits(undefined)).toBeNull();
  });
});
