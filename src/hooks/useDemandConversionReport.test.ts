import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

import {
  DEMAND_CONVERSION_SEARCH_MAX_LENGTH,
  buildDemandConversionQueryKey,
  buildDemandConversionRpcParams,
  getDemandConversionErrorMessage,
  isSameDemandConversionDataset,
  normalizeDemandConversionReport,
  normalizeDemandConversionSearch,
  shouldRetryDemandConversion,
} from '@/hooks/useDemandConversionReport';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const context = {
  periodStart: '2026-08-01',
  periodEnd: '2026-08-20',
  uniqueOnly: false,
  comparisonEnabled: true,
  granularity: 'day' as const,
  pageSize: 15,
  entryMode: 'all' as const,
};

function createValidPayload() {
  return {
    summary: {
      sessions: '10',
      completed: 2,
      overall_conversion_rate: '20.0',
      created_reservations: 10,
      created_people: 36,
      average_lead_days: '7.5',
    },
    comparison: {
      period_start: '2026-07-12',
      period_end: '2026-07-31',
      summary: {
        sessions: 8,
        completed: 1,
        overall_conversion_rate: 12.5,
        created_reservations: 8,
        created_people: 30,
        average_lead_days: 5,
      },
      party_size_bands: [
        ['one_two', '1–2 pessoas', 2, 3],
        ['three_four', '3–4 pessoas', 3, 10],
        ['five_six', '5–6 pessoas', 2, 10],
        ['seven_plus', '7+ pessoas', 1, 7],
      ].map(([key, label, reservations, people]) => ({
        key,
        label,
        reservations,
        people,
        percentage: Number(reservations) * 12.5,
      })),
    },
    funnel: [
      ['page_view', 'Página pública', 10, 100, 100, 2, 20],
      ['date_select', 'Seleção de data', 8, 80, 80, 2, 25],
      ['time_select', 'Seleção de horário', 6, 75, 60, 2, 33.3],
      ['form_fill', 'Dados pessoais', 4, 66.7, 40, 2, 50],
      ['completed', 'Reserva finalizada', 2, 50, 20, 0, 0],
    ].map(([step, label, count, previous, start, dropoff, dropoffRate]) => ({
      step,
      label,
      count,
      conversion_from_previous: previous,
      conversion_from_start: start,
      dropoff,
      dropoff_rate: dropoffRate,
    })),
    trend: [{
      period: '2026-08-01',
      page_views: 10,
      date_selections: 8,
      time_selections: 6,
      forms: 4,
      completed: 2,
      created_reservations: 10,
      created_people: 36,
    }],
    transition_times: [
      ['page_to_date', 'Página pública', 'Seleção de data'],
      ['date_to_time', 'Seleção de data', 'Seleção de horário'],
      ['time_to_form', 'Seleção de horário', 'Dados pessoais'],
      ['form_to_completed', 'Dados pessoais', 'Reserva finalizada'],
    ].map(([key, from_label, to_label], index) => ({
      key,
      from_label,
      to_label,
      median_seconds: (index + 1) * 60,
      sample_size: 5 - index,
    })),
    lead_time_bands: [
      ['same_day', 'No mesmo dia', 2],
      ['one_day', '1 dia antes', 1],
      ['two_to_seven', '2 a 7 dias', 2],
      ['eight_to_fourteen', '8 a 14 dias', 2],
      ['fifteen_to_thirty', '15 a 30 dias', 1],
      ['thirty_one_plus', '31 dias ou mais', 2],
    ].map(([key, label, reservations]) => ({
      key,
      label,
      reservations,
      people: Number(reservations) * 3,
      percentage: Number(reservations) * 10,
    })),
    entry_modes: [
      ['online', 'Online', 5],
      ['affiliate', 'Filiados e parceiros', 2],
      ['manual', 'Criada no painel', 2],
      ['waitlist', 'Convertida da fila', 1],
    ].map(([key, label, reservations]) => ({
      key,
      label,
      reservations,
      people: Number(reservations) * 3,
      percentage: Number(reservations) * 10,
    })),
    party_size_bands: [
      ['one_two', '1–2 pessoas', 3, 5],
      ['three_four', '3–4 pessoas', 4, 13],
      ['five_six', '5–6 pessoas', 2, 11],
      ['seven_plus', '7+ pessoas', 1, 7],
    ].map(([key, label, reservations, people]) => ({
      key,
      label,
      reservations,
      people,
      percentage: Number(reservations) * 10,
    })),
    details: [createDetailRow()],
    meta: {
      period_start: '2026-08-01',
      period_end: '2026-08-20',
      time_zone: 'America/Manaus',
      unique_only: false,
      comparison_enabled: true,
      comparison_start: '2026-07-12',
      comparison_end: '2026-07-31',
      granularity: 'day',
      page: 1,
      page_size: 15,
      details_total: 10,
      entry_mode: 'all',
      search: null,
      generated_at: '2026-08-20T15:00:00Z',
      funnel_source: 'tracking_funnel_sessions',
    },
  };
}

function createDetailRow(index = 1) {
  return {
    id: `reservation-${index}`,
    guest_name: `Cliente ${index}`,
    guest_phone: '5592999990000',
    guest_email: null,
    reservation_date: '2026-08-25',
    reservation_time: '19:00:00',
    party_size: 3,
    status: 'confirmed',
    entry_mode: 'online',
    lead_days: 5,
    created_at: '2026-08-20T15:00:00Z',
    source: 'reservation',
    origin_affiliate_code: null,
    origin_affiliate_name: null,
    checked_in_at: null,
    checked_in_party_size: null,
    updated_at: '2026-08-20T15:00:00Z',
    occasion: null,
    notes: null,
    table_id: null,
    created_in_mode: 'capacity',
    public_tracking_code: `tracking-${index}`,
  };
}

describe('contrato de Demanda & Conversão', () => {

  it('normaliza números do Postgres e valida todas as dimensões', () => {
    const result = normalizeDemandConversionReport(createValidPayload(), context);

    expect(result.summary).toEqual({
      sessions: 10,
      completed: 2,
      overall_conversion_rate: 20,
      created_reservations: 10,
      created_people: 36,
      average_lead_days: 7.5,
    });
    expect(result.funnel.map((stage) => stage.count)).toEqual([10, 8, 6, 4, 2]);
    expect(result.meta.time_zone).toBe('America/Manaus');
    expect(result.comparison?.summary.created_reservations).toBe(8);
    expect(result.details[0].guest_name).toBe('Cliente 1');
  });

  it('rejeita funil não monotônico, séries truncadas e metadados de outra consulta', () => {
    const nonMonotonic = createValidPayload();
    nonMonotonic.funnel[2].count = 9;
    const truncatedSeries = createValidPayload();
    truncatedSeries.trend[0].page_views = 9;
    const wrongMeta = createValidPayload();
    wrongMeta.meta.time_zone = '';

    expect(() => normalizeDemandConversionReport(nonMonotonic, context)).toThrow('monotônico');
    expect(() => normalizeDemandConversionReport(truncatedSeries, context)).toThrow('série diverge');
    expect(() => normalizeDemandConversionReport(wrongMeta, context)).toThrow('metadados');
  });

  it('aceita comparação desativada sem inventar uma base anterior', () => {
    const payload = createValidPayload();
    payload.comparison = null as unknown as ReturnType<typeof createValidPayload>['comparison'];
    payload.meta.comparison_enabled = false;
    payload.meta.comparison_start = null as unknown as string;
    payload.meta.comparison_end = null as unknown as string;

    const result = normalizeDemandConversionReport(payload, {
      ...context,
      comparisonEnabled: false,
    });

    expect(result.comparison).toBeNull();
    expect(result.meta.comparison_enabled).toBe(false);
  });

  it('traduz indisponibilidade do read model sem expor erro interno', () => {
    expect(getDemandConversionErrorMessage({
      code: '55000',
      message: 'erro interno não deve aparecer',
    })).toBe('Os dados do funil ainda estão sendo preparados. Tente novamente em alguns instantes.');
  });

  it('normaliza busca, página e query key sem compartilhar dados entre filtros', () => {
    expect(normalizeDemandConversionSearch(`  ${'x'.repeat(250)}  `)).toHaveLength(
      DEMAND_CONVERSION_SEARCH_MAX_LENGTH,
    );
    const params = buildDemandConversionRpcParams({
      companyId: COMPANY_ID,
      periodStart: context.periodStart,
      periodEnd: context.periodEnd,
      page: -2,
      pageSize: 999,
      search: '  Ana  ',
      entryMode: 'online',
    });
    expect(params).toMatchObject({ _page: 1, _page_size: 100, _search: 'Ana', _entry_mode: 'online' });

    const first = buildDemandConversionQueryKey({
      companyId: COMPANY_ID,
      periodStart: context.periodStart,
      periodEnd: context.periodEnd,
      page: 1,
    });
    const secondPage = buildDemandConversionQueryKey({
      companyId: COMPANY_ID,
      periodStart: context.periodStart,
      periodEnd: context.periodEnd,
      page: 2,
    });
    const filtered = buildDemandConversionQueryKey({
      companyId: COMPANY_ID,
      periodStart: context.periodStart,
      periodEnd: context.periodEnd,
      page: 2,
      entryMode: 'manual',
    });
    expect(isSameDemandConversionDataset(first, secondPage)).toBe(true);
    expect(isSameDemandConversionDataset(secondPage, filtered)).toBe(false);
    expect(shouldRetryDemandConversion(0, { name: 'AbortError' })).toBe(false);
  });

});
