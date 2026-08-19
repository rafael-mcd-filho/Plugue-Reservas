import { describe, expect, it } from 'vitest';
import {
  buildCustomerRecurrenceQueryKey,
  buildCustomerRecurrenceRpcParams,
  CUSTOMER_RECURRENCE_MIN_VISITS_MAX,
  CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH,
  isSameCustomerRecurrenceDataset,
  normalizeCustomerRecurrenceSearch,
  normalizeCustomerRecurrenceReport,
  normalizeMinimumTotalVisits,
  resolveCustomerRecurrenceDisplayedPage,
} from '@/hooks/useCustomerRecurrenceReport';

const fallback = {
  periodStart: '2026-08-01',
  periodEnd: '2026-08-13',
  comparisonMode: 'month_to_date' as const,
  includeCompanions: false,
  page: 1,
  pageSize: 12,
  minTotalVisits: 2,
};

const reportMonths = [
  '2026-03-01',
  '2026-04-01',
  '2026-05-01',
  '2026-06-01',
  '2026-07-01',
  '2026-08-01',
];

function createValidPayload() {
  return {
    summary: {
      identified_customers: '1',
      returning_customers: '1',
      new_customers: 0,
      recurrence_rate: '100.0',
      repeated_in_period: 1,
      repeat_rate: 100,
      additional_visits: 1,
      period_visits: 2,
      avg_visits_per_customer: '2',
    },
    comparison: {
      period_start: '2026-07-01',
      period_end: '2026-07-13',
      identified_customers: 0,
      returning_customers: 0,
      new_customers: 0,
      recurrence_rate: 0,
      repeated_in_period: 0,
      repeat_rate: 0,
      additional_visits: 0,
      period_visits: 0,
      avg_visits_per_customer: 0,
    },
    frequency_bands: [
      { key: 'one', label: '1 visita', min_visits: 1, max_visits: 1, customers: 0, percentage: 0 },
      { key: 'two', label: '2 visitas', min_visits: 2, max_visits: 2, customers: 0, percentage: 0 },
      { key: 'three_four', label: '3–4 visitas', min_visits: 3, max_visits: 4, customers: '1', percentage: '100' },
      { key: 'five_plus', label: '5+ visitas', min_visits: 5, max_visits: null, customers: 0, percentage: 0 },
    ],
    monthly_composition: reportMonths.map((month) => ({
      month,
      identified_customers: month === '2026-08-01' ? 1 : 0,
      new_customers: 0,
      returning_customers: month === '2026-08-01' ? 1 : 0,
      recurrence_rate: month === '2026-08-01' ? 100 : 0,
    })),
    customers: [
      {
        customer_key: 'customer:company:5585999990000',
        phone_normalized: '0000',
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
      comparison_mode: 'month_to_date',
      include_companions: false,
      page: 1,
      page_size: 12,
      customers_total: '1',
      filtered_customers_total: '1',
      min_total_visits: '2',
      generated_at: '2026-08-13T12:00:00Z',
    },
  };
}

describe('normalizeCustomerRecurrenceReport', () => {
  it('normaliza números do Postgres e preserva o contrato do relatório', () => {
    const report = normalizeCustomerRecurrenceReport(createValidPayload(), fallback);

    expect(report.summary).toMatchObject({
      identified_customers: 1,
      returning_customers: 1,
      recurrence_rate: 100,
      avg_visits_per_customer: 2,
    });
    expect(report.frequency_bands[2]).toMatchObject({ key: 'three_four', customers: 1, percentage: 100 });
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
    expect(report.meta.customers_total).toBe(1);
    expect(report.meta.min_total_visits).toBe(2);
  });

  it('não transforma payload parcial em um relatório vazio aparentemente válido', () => {
    expect(() => normalizeCustomerRecurrenceReport({
      summary: null,
      comparison: null,
      frequency_bands: [],
      monthly_composition: [],
      customers: [],
      meta: {},
    }, fallback)).toThrow('dados incompletos ou inválidos');
  });

  it('detecta página truncada em vez de esconder clientes da contagem', () => {
    const payload = { ...createValidPayload(), customers: [] };

    expect(() => normalizeCustomerRecurrenceReport(payload, fallback)).toThrow(
      'dados incompletos ou inválidos',
    );
  });

  it('rejeita customer_key duplicada, inclusive colisão criada pelo fallback de chave antiga', () => {
    const validPayload = createValidPayload();
    const secondCustomer = {
      ...validPayload.customers[0],
      customer_key: 'customer:1',
      phone_normalized: '1111',
      guest_name: 'Bia',
      first_visit_date: '2026-08-11',
      last_visit_date: '2026-08-11',
      previous_visit_date: null,
      prior_visits: '0',
      period_visits: '1',
      total_visits: '1',
      customer_type: 'new',
      frequency_band: 'one',
    };
    const payload = {
      ...validPayload,
      summary: {
        ...validPayload.summary,
        identified_customers: 2,
        returning_customers: 1,
        new_customers: 1,
        recurrence_rate: 50,
        repeat_rate: 50,
        period_visits: 3,
        avg_visits_per_customer: 1.5,
      },
      frequency_bands: validPayload.frequency_bands.map((band) => ({
        ...band,
        customers: band.key === 'one' || band.key === 'three_four' ? 1 : 0,
        percentage: band.key === 'one' || band.key === 'three_four' ? 50 : 0,
      })),
      monthly_composition: validPayload.monthly_composition.map((month) => (
        month.month === '2026-08-01'
          ? { ...month, identified_customers: 2, new_customers: 1, returning_customers: 1, recurrence_rate: 50 }
          : month
      )),
      customers: [validPayload.customers[0], secondCustomer],
      meta: {
        ...validPayload.meta,
        customers_total: 2,
        filtered_customers_total: 2,
      },
    };

    expect(() => normalizeCustomerRecurrenceReport(payload, fallback)).toThrow(
      'dados incompletos ou inválidos',
    );
  });

  it('rejeita metadados de outra página ou de outro filtro', () => {
    const validPayload = createValidPayload();
    const anotherPage = { ...validPayload, meta: { ...validPayload.meta, page: 2 } };
    const missingMinimum = {
      ...validPayload,
      meta: { ...validPayload.meta, min_total_visits: undefined },
    };
    const anotherComparison = {
      ...validPayload,
      meta: { ...validPayload.meta, comparison_mode: 'previous_period' },
    };

    expect(() => normalizeCustomerRecurrenceReport(anotherPage, fallback)).toThrow(
      'dados incompletos ou inválidos',
    );
    expect(() => normalizeCustomerRecurrenceReport(missingMinimum, fallback)).toThrow(
      'dados incompletos ou inválidos',
    );
    expect(() => normalizeCustomerRecurrenceReport(anotherComparison, fallback)).toThrow(
      'dados incompletos ou inválidos',
    );
  });

  it('rejeita composição mensal vazia, parcial ou fora de ordem', () => {
    const validPayload = createValidPayload();
    const empty = { ...validPayload, monthly_composition: [] };
    const partial = {
      ...validPayload,
      monthly_composition: validPayload.monthly_composition.slice(0, 5),
    };
    const reversed = {
      ...validPayload,
      monthly_composition: [...validPayload.monthly_composition].reverse(),
    };

    expect(() => normalizeCustomerRecurrenceReport(empty, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(partial, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(reversed, fallback)).toThrow('dados incompletos ou inválidos');
  });

  it('rejeita taxas, médias e percentuais diferentes das fórmulas arredondadas da RPC', () => {
    const validPayload = createValidPayload();
    const wrongSummaryRate = {
      ...validPayload,
      summary: { ...validPayload.summary, recurrence_rate: 99.9 },
    };
    const wrongAverage = {
      ...validPayload,
      summary: { ...validPayload.summary, avg_visits_per_customer: 1.99 },
    };
    const wrongFrequencyPercentage = {
      ...validPayload,
      frequency_bands: validPayload.frequency_bands.map((band) => (
        band.key === 'three_four' ? { ...band, percentage: 99.9 } : band
      )),
    };
    const wrongFrequencyDefinition = {
      ...validPayload,
      frequency_bands: validPayload.frequency_bands.map((band) => (
        band.key === 'two' ? { ...band, min_visits: 3 } : band
      )),
    };
    const wrongMonthlyRate = {
      ...validPayload,
      monthly_composition: validPayload.monthly_composition.map((month) => (
        month.month === '2026-08-01' ? { ...month, recurrence_rate: 99.9 } : month
      )),
    };

    expect(() => normalizeCustomerRecurrenceReport(wrongSummaryRate, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(wrongAverage, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(wrongFrequencyPercentage, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(wrongFrequencyDefinition, fallback)).toThrow('dados incompletos ou inválidos');
    expect(() => normalizeCustomerRecurrenceReport(wrongMonthlyRate, fallback)).toThrow('dados incompletos ou inválidos');
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

  it('normaliza limites aceitos pela RPC sem criar teto de 10.000 páginas no cliente', () => {
    expect(normalizeMinimumTotalVisits(2.9)).toBe(2);
    expect(normalizeMinimumTotalVisits(CUSTOMER_RECURRENCE_MIN_VISITS_MAX + 1)).toBe(
      CUSTOMER_RECURRENCE_MIN_VISITS_MAX,
    );
    expect(normalizeMinimumTotalVisits(0)).toBeNull();
    expect(normalizeMinimumTotalVisits(Number.NaN)).toBeNull();
    expect(normalizeMinimumTotalVisits(undefined)).toBeNull();

    const longSearch = `  ${'a'.repeat(CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH + 20)}  `;
    expect(normalizeCustomerRecurrenceSearch(longSearch)).toHaveLength(
      CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH,
    );

    expect(buildCustomerRecurrenceRpcParams({
      ...params,
      page: 12_501,
      pageSize: 500,
      search: longSearch,
      minTotalVisits: CUSTOMER_RECURRENCE_MIN_VISITS_MAX + 1,
    })).toMatchObject({
      _page: 12_501,
      _page_size: 100,
      _min_total_visits: CUSTOMER_RECURRENCE_MIN_VISITS_MAX,
    });
  });
});
