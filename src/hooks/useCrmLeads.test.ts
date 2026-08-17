import { describe, expect, it, vi } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}));

import {
  collectCrmLeadPresenceHistoryPages,
  collectCrmLeadsExportPages,
  fetchCrmLeadsPage,
  fetchCrmLeadsExportPage,
  groupCrmLeadExportRows,
  normalizeCrmLeadPresenceHistory,
  normalizeCrmLeadsPage,
  normalizeCrmLeadsExportPage,
  type CrmLeadPresenceHistory,
  type CrmLeadExportRow,
} from '@/hooks/useCrmLeads';

describe('fetchCrmLeadsPage', () => {
  it('envia datas locais inclusivas sem converter para timestamp', async () => {
    const request = Promise.resolve({
      data: { leads: [], states: [], meta: { page: 1, page_size: 25 } },
      error: null,
    }) as Promise<unknown> & { abortSignal?: ReturnType<typeof vi.fn> };
    request.abortSignal = vi.fn(() => request);
    rpcMock.mockReturnValueOnce(request);
    const controller = new AbortController();

    await fetchCrmLeadsPage({
      companyId: 'company-1',
      page: 1,
      pageSize: 25,
      createdFrom: '2026-08-01',
      createdTo: '2026-08-13',
    }, controller.signal);

    expect(rpcMock).toHaveBeenCalledWith('get_crm_leads_page', expect.objectContaining({
      _created_from: '2026-08-01',
      _created_to: '2026-08-13',
    }));
    expect(request.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('envia os recortes locais à RPC paginada de exportação', async () => {
    const request = Promise.resolve({
      data: { rows: [], meta: { page: 1, page_size: 100, total_rows: 0, has_more: false } },
      error: null,
    }) as Promise<unknown> & { abortSignal?: ReturnType<typeof vi.fn> };
    request.abortSignal = vi.fn(() => request);
    rpcMock.mockReturnValueOnce(request);

    await fetchCrmLeadsExportPage({
      companyId: 'company-1',
      page: 1,
      pageSize: 100,
      createdFrom: '2026-08-01',
      createdTo: '2026-08-13',
      stateCode: 'PB',
      birthdayMonth: 8,
      visitFrom: '2026-08-05',
      visitTo: '2026-08-10',
    });

    expect(rpcMock).toHaveBeenCalledWith('get_crm_leads_export_page', {
      _company_id: 'company-1',
      _page: 1,
      _page_size: 100,
      _created_from: '2026-08-01',
      _created_to: '2026-08-13',
      _state_code: 'PB',
      _birthday_month: 8,
      _visit_from: '2026-08-05',
      _visit_to: '2026-08-10',
    });
  });
});

describe('normalizeCrmLeadsPage', () => {
  it('normaliza a página e mantém uma única linha por identidade canônica', () => {
    const result = normalizeCrmLeadsPage({
      leads: [
        {
          customer_key: 'phone:5583999991020',
          phone_normalized: '5583999991020',
          display_phone: '(83) 99999-1020',
          latest_name: 'João Rocha',
          latest_email: 'joao@example.com',
          latest_birthdate: '1990-08-14',
          first_seen_at: '2025-01-01T10:00:00Z',
          last_visit_date: '2026-08-01',
          last_visit_time: '20:25:00',
          state_code: 'PB',
          state_name: 'Paraíba',
          source: 'mixed',
          canonical_visit_count: '3',
          crm_lead: null,
        },
        {
          customer_key: 'phone:5583999991020',
          latest_name: 'Nome antigo que não deve criar outro cliente',
        },
      ],
      states: [{ code: 'pb', name: 'Paraíba' }],
      meta: {
        page: '1',
        page_size: '25',
        total_leads: '10',
        filtered_leads: '1',
        total_records: '20',
        filtered_records: '3',
        generated_at: '2026-08-14T12:00:00Z',
      },
    }, { page: 1, pageSize: 25 });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      customer_key: 'phone:5583999991020',
      latest_name: 'João Rocha',
      canonical_visit_count: 3,
    });
    expect(result.states).toEqual([{ code: 'PB', name: 'Paraíba' }]);
    expect(result.meta).toMatchObject({ total_leads: 10, filtered_records: 3 });
  });

  it('preserva lead importado sem telefone usando a chave de email', () => {
    const result = normalizeCrmLeadsPage({
      leads: [{
        customer_key: 'email:maria@example.com',
        phone_normalized: null,
        display_phone: null,
        latest_name: 'Maria',
        first_seen_at: '2026-08-14T10:00:00Z',
        source: 'imported',
        canonical_visit_count: 0,
        crm_lead: {
          id: 'lead-1',
          notes: 'Base antiga',
          imported_at: '2026-08-14T10:00:00Z',
          imported_by_user_id: null,
          import_filename: 'leads.csv',
        },
      }],
      meta: {},
    }, { page: 2, pageSize: 50 });

    expect(result.leads[0]).toMatchObject({
      customer_key: 'email:maria@example.com',
      phone_normalized: null,
      source: 'imported',
      crm_lead: { id: 'lead-1' },
    });
    expect(result.meta).toMatchObject({ page: 2, page_size: 50 });
  });

  it('preserva a origem bruta de acompanhante de reserva no perfil', () => {
    const result = normalizeCrmLeadsPage({
      leads: [{
        customer_key: 'phone:5583999990001',
        latest_name: 'Acompanhante',
        first_seen_at: '2026-08-14T10:00:00Z',
        source: 'reservation_companion',
        canonical_visit_count: 1,
      }],
      meta: {},
    }, { page: 1, pageSize: 25 });

    expect(result.leads[0].source).toBe('reservation_companion');
  });

  it('falha explicitamente quando a RPC não retorna um objeto', () => {
    expect(() => normalizeCrmLeadsPage(null, { page: 1, pageSize: 25 })).toThrow(
      'A base de leads não retornou dados válidos.',
    );
  });
});

describe('normalizeCrmLeadPresenceHistory', () => {
  it('normaliza e deduplica eventos canônicos pelo id do evento', () => {
    const history = normalizeCrmLeadPresenceHistory({
      customer_key: 'phone:5583999991020',
      visits: [
        {
          id: 'reservation:reservation-1',
          visit_id: 'reservation-1',
          created_at: '2026-08-01T20:00:00Z',
          date: '2026-08-01',
          time: '20:25:00',
          party_size: '2',
          status: 'completed',
          occasion: null,
          lead_source: 'reservation_holder',
          visit_origin: 'reservation',
          origin_waitlist_id: null,
          reservation_holder_name: 'João Rocha',
        },
        {
          id: 'reservation:reservation-1',
          visit_id: 'reservation-1',
          lead_source: 'reservation_companion',
          visit_origin: 'reservation',
        },
        {
          id: 'reservation:reservation-2',
          visit_id: 'reservation-2',
          lead_source: 'reservation_companion',
          visit_origin: 'reservation',
        },
      ],
      meta: { page: 1, page_size: 100, total_visits: '2' },
    }, { customerKey: 'phone:5583999991020', page: 1, pageSize: 100 });

    expect(history.visits).toHaveLength(2);
    expect(history.visits[0]).toMatchObject({ party_size: 2, status: 'completed' });
    expect(history.visits[1].lead_source).toBe('reservation_companion');
    expect(history.meta.total_visits).toBe(2);
  });
});

describe('collectCrmLeadPresenceHistoryPages', () => {
  it('carrega todas as páginas antes de entregar o histórico ao modal', async () => {
    const getPage = vi.fn(async (page: number, pageSize: number): Promise<CrmLeadPresenceHistory> => ({
      customer_key: 'phone:5583999991020',
      visits: page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
          id: `reservation:${index + 1}`,
          visit_id: `${index + 1}`,
          created_at: '',
          date: '2026-08-01',
          time: '20:00:00',
          party_size: 1,
          status: 'checked_in',
          occasion: null,
          lead_source: 'reservation_holder',
          visit_origin: 'reservation',
          origin_waitlist_id: null,
          reservation_holder_name: 'Cliente',
        }))
        : [{
          id: 'waitlist:101',
          visit_id: '101',
          created_at: '',
          date: '2026-08-02',
          time: '20:00:00',
          party_size: 1,
          status: 'seated',
          occasion: null,
          lead_source: 'waitlist_holder',
          visit_origin: 'waitlist',
          origin_waitlist_id: null,
          reservation_holder_name: 'Cliente',
        }],
      meta: { page, page_size: pageSize, total_visits: 101 },
    }));

    const history = await collectCrmLeadPresenceHistoryPages('phone:5583999991020', getPage);

    expect(history.visits).toHaveLength(101);
    expect(getPage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(getPage).toHaveBeenNthCalledWith(2, 2, 100);
  });

  it('não entrega histórico parcial quando uma página termina antes do total', async () => {
    await expect(collectCrmLeadPresenceHistoryPages('phone:1', async (page, pageSize) => ({
      customer_key: 'phone:1',
      visits: page === 1 ? [{
        id: 'reservation:1',
        visit_id: '1',
        created_at: '',
        date: '2026-08-01',
        time: '20:00:00',
        party_size: 1,
        status: 'checked_in',
        occasion: null,
        lead_source: 'reservation_holder',
        visit_origin: 'reservation',
        origin_waitlist_id: null,
        reservation_holder_name: 'Cliente',
      }] : [],
      meta: { page, page_size: pageSize, total_visits: 2 },
    }))).rejects.toThrow('histórico completo');
  });
});

function makeExportRow(index: number, overrides: Partial<CrmLeadExportRow> = {}): CrmLeadExportRow {
  return {
    customer_key: `email:cliente${index}@example.com`,
    phone_normalized: null,
    display_phone: null,
    latest_name: `Cliente ${index}`,
    latest_email: `cliente${index}@example.com`,
    latest_birthdate: null,
    first_seen_at: '2026-08-14T10:00:00Z',
    last_visit_date: null,
    last_visit_time: null,
    state_code: null,
    state_name: null,
    source: 'imported',
    canonical_visit_count: 0,
    crm_lead: null,
    row_key: `lead_only:email:cliente${index}@example.com`,
    row_kind: 'lead_only',
    matched_visit_count: 0,
    matched_source: 'imported',
    last_matched_visit_date: null,
    last_matched_visit_time: null,
    last_matched_visit_at: null,
    visit: null,
    ...overrides,
  };
}

describe('normalizeCrmLeadsExportPage', () => {
  it('normaliza linhas achatadas e metadados numéricos da RPC', () => {
    const page = normalizeCrmLeadsExportPage({
      rows: [{
        ...makeExportRow(1),
        source: 'reservation_companion',
        canonical_visit_count: '1',
        matched_visit_count: '1',
        matched_source: 'companion',
        row_key: 'presence:email:cliente1@example.com:reservation:1',
        row_kind: 'presence',
        visit: {
          id: 'reservation:1',
          visit_id: '1',
          created_at: '',
          date: '2026-08-01',
          time: '20:00:00',
          party_size: '2',
          status: 'checked_in',
          lead_source: 'reservation_companion',
          visit_origin: 'reservation',
        },
      }],
      meta: {
        page: '1',
        page_size: '100',
        total_rows: '1',
        total_pages: '1',
        filtered_leads: '1',
        matched_visits: '1',
        has_more: false,
        visit_filter_applied: true,
      },
    }, { page: 1, pageSize: 100 });

    expect(page.rows[0]).toMatchObject({
      row_kind: 'presence',
      canonical_visit_count: 1,
      matched_visit_count: 1,
      source: 'reservation_companion',
      matched_source: 'companion',
      visit: { party_size: 2, lead_source: 'reservation_companion' },
    });
    expect(page.meta).toMatchObject({ total_rows: 1, matched_visits: 1, visit_filter_applied: true });
  });
});

describe('collectCrmLeadsExportPages', () => {
  it('carrega todas as páginas achatadas e valida o total único', async () => {
    const source = Array.from({ length: 205 }, (_, index) => makeExportRow(index + 1));
    const getPage = vi.fn(async (page: number, pageSize: number) => ({
      rows: source.slice((page - 1) * pageSize, page * pageSize),
      meta: {
        page,
        page_size: pageSize,
        total_rows: source.length,
        total_pages: 3,
        filtered_leads: source.length,
        matched_visits: 0,
        has_more: page < 3,
        visit_filter_applied: false,
        generated_at: '',
      },
    }));

    const result = await collectCrmLeadsExportPages(getPage);

    expect(result.rows).toHaveLength(205);
    expect(getPage.mock.calls).toEqual([[1, 100], [2, 100], [3, 100]]);
  });

  it('falha se os totais mudarem entre páginas', async () => {
    await expect(collectCrmLeadsExportPages(async (page, pageSize) => ({
      rows: [makeExportRow(page)],
      meta: {
        page,
        page_size: pageSize,
        total_rows: page === 1 ? 2 : 3,
        total_pages: 2,
        filtered_leads: 2,
        matched_visits: 0,
        has_more: page === 1,
        visit_filter_applied: false,
        generated_at: '',
      },
    }))).rejects.toThrow('mudou durante a exportação');
  });
});

describe('groupCrmLeadExportRows', () => {
  it('agrupa presenças por cliente e preserva lead sem visitas', () => {
    const presenceBase = makeExportRow(2, {
      customer_key: 'phone:5583999991020',
      canonical_visit_count: 2,
      row_kind: 'presence',
      matched_visit_count: 2,
      matched_source: 'reservation_holder',
      source: 'reservation_holder',
    });
    const presenceOne = makeExportRow(2, {
      ...presenceBase,
      row_key: 'presence:phone:5583999991020:reservation:1',
      visit: {
        id: 'reservation:1',
        visit_id: '1',
        created_at: '',
        date: '2026-08-01',
        time: '20:00:00',
        party_size: 1,
        status: 'checked_in',
        occasion: null,
        lead_source: 'reservation_holder',
        visit_origin: 'reservation',
        origin_waitlist_id: null,
        reservation_holder_name: 'Cliente',
      },
    });
    const presenceTwo = makeExportRow(2, {
      ...presenceBase,
      row_key: 'presence:phone:5583999991020:waitlist:2',
      visit: {
        ...presenceOne.visit!,
        id: 'waitlist:2',
        visit_id: '2',
        visit_origin: 'waitlist',
        lead_source: 'waitlist_holder',
        status: 'seated',
      },
    });

    const result = groupCrmLeadExportRows([makeExportRow(1), presenceOne, presenceTwo]);

    expect(result).toHaveLength(2);
    expect(result[0].visits).toEqual([]);
    expect(result[1].visits.map((visit) => visit.id)).toEqual(['reservation:1', 'waitlist:2']);
  });
});
