import { describe, expect, it, vi } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}));

import {
  buildCrmLeadsPageQueryKey,
  collectCrmImportedLeadMatchPages,
  collectCrmLeadPresenceHistoryPages,
  collectCrmLeadsExportPages,
  fetchCrmLeadsPage,
  fetchCrmLeadsExportPage,
  getCrmVisitsFilterRangeError,
  groupCrmLeadExportRows,
  isSameCrmLeadsDataset,
  normalizeCrmVisitsFilter,
  normalizeCrmVisitsFilterInput,
  normalizeCrmLeadsSearch,
  normalizeCrmLeadPresenceHistory,
  normalizeCrmLeadsPage,
  normalizeCrmLeadsExportPage,
  resolveCrmLeadsDisplayedPage,
  type CrmLeadPresenceHistory,
  type CrmLeadExportRow,
} from '@/hooks/useCrmLeads';

describe('paginação da lista de leads', () => {
  it('reutiliza a página anterior apenas durante a troca de página do mesmo conjunto de filtros', () => {
    const firstPage = buildCrmLeadsPageQueryKey({
      companyId: 'company-1',
      page: 1,
      pageSize: 25,
      search: ' João ',
      minVisits: 2,
    });
    const pageBeyondOneThousand = buildCrmLeadsPageQueryKey({
      companyId: 'company-1',
      page: 41,
      pageSize: 25,
      search: 'João',
      minVisits: 2,
    });
    const changedFilter = buildCrmLeadsPageQueryKey({
      companyId: 'company-1',
      page: 41,
      pageSize: 25,
      search: 'Maria',
      minVisits: 2,
    });

    expect(isSameCrmLeadsDataset(firstPage, pageBeyondOneThousand)).toBe(true);
    expect(isSameCrmLeadsDataset(firstPage, changedFilter)).toBe(false);
    expect(resolveCrmLeadsDisplayedPage(41, 1)).toBe(1);
    expect(resolveCrmLeadsDisplayedPage(41)).toBe(41);
  });
});

describe('filtros de quantidade de visitas', () => {
  it('normaliza inteiros no intervalo aceito pela RPC', () => {
    expect(normalizeCrmVisitsFilter(-2)).toBe(0);
    expect(normalizeCrmVisitsFilter(2.9)).toBe(2);
    expect(normalizeCrmVisitsFilter(1_000_001)).toBe(1_000_000);
    expect(normalizeCrmVisitsFilter(Number.NaN)).toBeNull();
    expect(normalizeCrmVisitsFilterInput('')).toBe('');
    expect(normalizeCrmVisitsFilterInput('-3')).toBe('0');
    expect(normalizeCrmVisitsFilterInput('4.8')).toBe('4');
    expect(normalizeCrmVisitsFilterInput('texto')).toBe('');
    expect(getCrmVisitsFilterRangeError(3, 2)).toContain('maior ou igual');
    expect(getCrmVisitsFilterRangeError(2, 3)).toBeNull();
    expect(normalizeCrmLeadsSearch(`  ${'a'.repeat(250)}  `)).toHaveLength(200);
  });
});

describe('paginação da conferência da importação', () => {
  it('continua após o teto remoto ser menor que o range solicitado', async () => {
    const source = Array.from({ length: 250 }, (_, index) => ({ id: `lead-${index + 1}` }));
    const getPage = vi.fn(async (rangeStart: number, _rangeEnd: number) => ({
      rows: source.slice(rangeStart, rangeStart + 100),
      total: source.length,
    }));

    const result = await collectCrmImportedLeadMatchPages(getPage, (lead) => lead.id, 500);

    expect(result).toHaveLength(250);
    expect(getPage.mock.calls).toEqual([[0, 499], [100, 599], [200, 699]]);
  });

  it('falha sem esconder ausência de progresso antes do total', async () => {
    await expect(collectCrmImportedLeadMatchPages(
      async () => ({ rows: [], total: 2 }),
      (lead: { id: string }) => lead.id,
    )).rejects.toThrow('parou antes');
  });
});

describe('fetchCrmLeadsPage', () => {
  it('envia datas locais inclusivas sem converter para timestamp', async () => {
    const request = Promise.resolve({
      data: {
        leads: [],
        states: [],
        meta: {
          page: 41,
          page_size: 25,
          total_leads: 0,
          filtered_leads: 0,
          total_records: 0,
          filtered_records: 0,
          total_canonical_visits: 0,
          filtered_canonical_visits: 0,
          total_import_only_leads: 0,
          filtered_import_only_leads: 0,
          generated_at: '2026-08-17T12:00:00Z',
        },
      },
      error: null,
    }) as Promise<unknown> & { abortSignal?: ReturnType<typeof vi.fn> };
    request.abortSignal = vi.fn(() => request);
    rpcMock.mockReturnValueOnce(request);
    const controller = new AbortController();

    await fetchCrmLeadsPage({
      companyId: 'company-1',
      page: 41,
      pageSize: 25,
      createdFrom: '2026-08-01',
      createdTo: '2026-08-13',
      search: `  ${'x'.repeat(250)}  `,
      minVisits: -1,
      maxVisits: 1_000_001,
    }, controller.signal);

    expect(rpcMock).toHaveBeenCalledWith('get_crm_leads_page', expect.objectContaining({
      _page: 41,
      _created_from: '2026-08-01',
      _created_to: '2026-08-13',
      _search: 'x'.repeat(200),
      _min_visits: 0,
      _max_visits: 1_000_000,
    }));
    expect(request.abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('envia os recortes locais à RPC paginada de exportação', async () => {
    const request = Promise.resolve({
      data: {
        rows: [],
        meta: {
          page: 1,
          page_size: 100,
          total_rows: 0,
          total_pages: 0,
          filtered_leads: 0,
          matched_visits: 0,
          has_more: false,
          visit_filter_applied: false,
          generated_at: '2026-08-17T12:00:00Z',
        },
      },
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
  it('normaliza a página canônica e valida suas contagens', () => {
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
      ],
      states: [{ code: 'pb', name: 'Paraíba' }],
      meta: {
        page: '1',
        page_size: '25',
        total_leads: '10',
        filtered_leads: '1',
        total_records: '20',
        filtered_records: '3',
        total_canonical_visits: '18',
        filtered_canonical_visits: '3',
        total_import_only_leads: '2',
        filtered_import_only_leads: '0',
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
      states: [],
      meta: {
        page: 2,
        page_size: 50,
        total_leads: 51,
        filtered_leads: 51,
        total_records: 51,
        filtered_records: 51,
        total_canonical_visits: 0,
        filtered_canonical_visits: 0,
        total_import_only_leads: 51,
        filtered_import_only_leads: 51,
        generated_at: '2026-08-17T12:00:00Z',
      },
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
      states: [],
      meta: {
        page: 1,
        page_size: 25,
        total_leads: 1,
        filtered_leads: 1,
        total_records: 1,
        filtered_records: 1,
        total_canonical_visits: 1,
        filtered_canonical_visits: 1,
        total_import_only_leads: 0,
        filtered_import_only_leads: 0,
        generated_at: '2026-08-17T12:00:00Z',
      },
    }, { page: 1, pageSize: 25 });

    expect(result.leads[0].source).toBe('reservation_companion');
  });

  it('não esconde identidade duplicada nem página truncada retornada pela RPC', () => {
    const lead = {
      customer_key: 'phone:5583999991020',
      latest_name: 'João Rocha',
      first_seen_at: '2026-08-14T10:00:00Z',
      source: 'mixed',
      canonical_visit_count: 1,
    };
    const meta = {
      page: 1,
      page_size: 25,
      total_leads: 2,
      filtered_leads: 2,
      total_records: 2,
      filtered_records: 2,
      total_canonical_visits: 2,
      filtered_canonical_visits: 2,
      total_import_only_leads: 0,
      filtered_import_only_leads: 0,
      generated_at: '2026-08-17T12:00:00Z',
    };

    expect(() => normalizeCrmLeadsPage({ leads: [lead, lead], states: [], meta }, { page: 1, pageSize: 25 }))
      .toThrow('incompleta ou duplicada');
    expect(() => normalizeCrmLeadsPage({ leads: [lead], states: [], meta }, { page: 1, pageSize: 25 }))
      .toThrow('contagens ou paginação inconsistentes');
  });

  it('rejeita metadados parciais e estados inválidos em vez de assumir zero', () => {
    expect(() => normalizeCrmLeadsPage({
      leads: [],
      states: [],
      meta: { page: 1, page_size: 25 },
    }, { page: 1, pageSize: 25 })).toThrow('metadados ausentes ou inválidos');

    const emptyMeta = {
      page: 1,
      page_size: 25,
      total_leads: 0,
      filtered_leads: 0,
      total_records: 0,
      filtered_records: 0,
      total_canonical_visits: 0,
      filtered_canonical_visits: 0,
      total_import_only_leads: 0,
      filtered_import_only_leads: 0,
      generated_at: '2026-08-17T12:00:00Z',
    };
    expect(() => normalizeCrmLeadsPage({
      leads: [],
      states: [{ code: '', name: 'Inválido' }],
      meta: emptyMeta,
    }, { page: 1, pageSize: 25 })).toThrow('estado inválidas');

    const metaWithoutGeneratedAt: Record<string, unknown> = { ...emptyMeta };
    delete metaWithoutGeneratedAt.generated_at;
    expect(() => normalizeCrmLeadsPage({
      leads: [],
      states: [],
      meta: metaWithoutGeneratedAt,
    }, { page: 1, pageSize: 25 })).toThrow('metadados ausentes ou inválidos');
  });

  it('rejeita lead sem contagem canônica inteira ou data inicial', () => {
    const invalidLead = {
      customer_key: 'phone:5583999991020',
      latest_name: 'João',
      first_seen_at: '2026-08-17T12:00:00Z',
      source: 'mixed',
    };
    const meta = {
      page: 1,
      page_size: 25,
      total_leads: 1,
      filtered_leads: 1,
      total_records: 1,
      filtered_records: 1,
      total_canonical_visits: 1,
      filtered_canonical_visits: 1,
      total_import_only_leads: 0,
      filtered_import_only_leads: 0,
      generated_at: '2026-08-17T12:00:00Z',
    };

    expect(() => normalizeCrmLeadsPage({
      leads: [invalidLead],
      states: [],
      meta,
    }, { page: 1, pageSize: 25 })).toThrow('incompleta ou duplicada');

    expect(() => normalizeCrmLeadsPage({
      leads: [{ ...invalidLead, canonical_visit_count: 1, first_seen_at: '' }],
      states: [],
      meta,
    }, { page: 1, pageSize: 25 })).toThrow('incompleta ou duplicada');

    expect(() => normalizeCrmLeadsPage({
      leads: [{ ...invalidLead, canonical_visit_count: 1, first_seen_at: 'não-é-data' }],
      states: [],
      meta,
    }, { page: 1, pageSize: 25 })).toThrow('incompleta ou duplicada');

    expect(() => normalizeCrmLeadsPage({
      leads: [{ ...invalidLead, canonical_visit_count: 1, latest_birthdate: '2026-02-30' }],
      states: [],
      meta,
    }, { page: 1, pageSize: 25 })).toThrow('incompleta ou duplicada');
  });

  it('falha explicitamente quando a RPC não retorna um objeto', () => {
    expect(() => normalizeCrmLeadsPage(null, { page: 1, pageSize: 25 })).toThrow(
      'A base de leads não retornou dados válidos.',
    );
  });
});

describe('normalizeCrmLeadPresenceHistory', () => {
  it('normaliza eventos canônicos e valida o total da página', () => {
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
          id: 'reservation:reservation-2',
          visit_id: 'reservation-2',
          created_at: '2026-08-02T20:00:00Z',
          date: '2026-08-02',
          time: '20:00:00',
          party_size: 1,
          status: 'checked_in',
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

  it('não entrega uma página parcial de histórico', () => {
    expect(() => normalizeCrmLeadPresenceHistory({
      customer_key: 'phone:5583999991020',
      visits: [],
      meta: { page: 1, page_size: 100, total_visits: 1 },
    }, { customerKey: 'phone:5583999991020', page: 1, pageSize: 100 }))
      .toThrow('contagens ou paginação inconsistentes');
  });

  it('rejeita metadados ausentes ou não inteiros no histórico', () => {
    expect(() => normalizeCrmLeadPresenceHistory({
      customer_key: 'phone:5583999991020',
      visits: [],
      meta: { page: 1, page_size: 100 },
    }, { customerKey: 'phone:5583999991020', page: 1, pageSize: 100 }))
      .toThrow('metadados ausentes ou inválidos');

    expect(() => normalizeCrmLeadPresenceHistory({
      customer_key: 'phone:5583999991020',
      visits: [],
      meta: { page: 1, page_size: 100, total_visits: 0.5 },
    }, { customerKey: 'phone:5583999991020', page: 1, pageSize: 100 }))
      .toThrow('metadados ausentes ou inválidos');
  });

  it('rejeita visita parcial, data impossível e quantidade não inteira', () => {
    const validVisit = {
      id: 'reservation:1',
      visit_id: '1',
      created_at: '2026-08-17T20:00:00Z',
      date: '2026-08-17',
      time: '20:00:00',
      party_size: 2,
      status: 'checked_in',
      occasion: null,
      lead_source: 'reservation_holder',
      visit_origin: 'reservation',
      origin_waitlist_id: null,
      reservation_holder_name: 'Cliente',
    };
    const invalidVisits = [
      { ...validVisit, created_at: '' },
      { ...validVisit, created_at: 'não-é-data' },
      { ...validVisit, date: '2026-02-30' },
      { ...validVisit, time: '25:61:00' },
      { ...validVisit, party_size: 1.5 },
      { ...validVisit, status: '' },
    ];

    for (const visit of invalidVisits) {
      expect(() => normalizeCrmLeadPresenceHistory({
        customer_key: 'phone:5583999991020',
        visits: [visit],
        meta: { page: 1, page_size: 100, total_visits: 1 },
      }, { customerKey: 'phone:5583999991020', page: 1, pageSize: 100 }))
        .toThrow('incompleta ou duplicada');
    }
  });
});

describe('collectCrmLeadPresenceHistoryPages', () => {
  it('carrega mais de 1.000 visitas antes de entregar o histórico ao modal', async () => {
    const totalVisits = 1_001;
    const getPage = vi.fn(async (page: number, pageSize: number): Promise<CrmLeadPresenceHistory> => {
      const start = (page - 1) * pageSize;
      const pageLength = Math.min(pageSize, Math.max(0, totalVisits - start));

      return {
        customer_key: 'phone:5583999991020',
        visits: Array.from({ length: pageLength }, (_, index) => {
          const visitNumber = start + index + 1;
          return {
            id: `reservation:${visitNumber}`,
            visit_id: `${visitNumber}`,
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
          };
        }),
        meta: { page, page_size: pageSize, total_visits: totalVisits },
      };
    });

    const history = await collectCrmLeadPresenceHistoryPages('phone:5583999991020', getPage);

    expect(history.visits).toHaveLength(1_001);
    expect(getPage).toHaveBeenCalledTimes(11);
    expect(getPage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(getPage).toHaveBeenNthCalledWith(11, 11, 100);
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
    }))).rejects.toThrow('base de visitas mudou');
  });

  it('rejeita a página errada do histórico canônico', async () => {
    await expect(collectCrmLeadPresenceHistoryPages('phone:1', async (_page, pageSize) => ({
      customer_key: 'phone:1',
      visits: [],
      meta: { page: 2, page_size: pageSize, total_visits: 0 },
    }))).rejects.toThrow('base de visitas mudou');
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
          created_at: '2026-08-01T20:00:00Z',
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
        generated_at: '2026-08-17T12:00:00Z',
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

  it('rejeita metadados parciais ou booleanos convertidos silenciosamente', () => {
    expect(() => normalizeCrmLeadsExportPage({
      rows: [],
      meta: { page: 1, page_size: 100, total_rows: 0 },
    }, { page: 1, pageSize: 100 })).toThrow('metadados ausentes ou inválidos');

    expect(() => normalizeCrmLeadsExportPage({
      rows: [],
      meta: {
        page: 1,
        page_size: 100,
        total_rows: 0,
        total_pages: 0,
        filtered_leads: 0,
        matched_visits: 0,
        has_more: 'false',
        visit_filter_applied: false,
        generated_at: '2026-08-17T12:00:00Z',
      },
    }, { page: 1, pageSize: 100 })).toThrow('metadados ausentes ou inválidos');

    expect(() => normalizeCrmLeadsExportPage({
      rows: [],
      meta: {
        page: 1,
        page_size: 100,
        total_rows: 0,
        total_pages: 0,
        filtered_leads: 0,
        matched_visits: 0,
        has_more: false,
        visit_filter_applied: false,
      },
    }, { page: 1, pageSize: 100 })).toThrow('metadados ausentes ou inválidos');
  });

  it('rejeita total por cliente ausente e origem filtrada desconhecida', () => {
    const meta = {
      page: 1,
      page_size: 100,
      total_rows: 1,
      total_pages: 1,
      filtered_leads: 1,
      matched_visits: 0,
      has_more: false,
      visit_filter_applied: false,
      generated_at: '2026-08-17T12:00:00Z',
    };
    const rowWithoutMatchedCount = { ...makeExportRow(1) } as Record<string, unknown>;
    delete rowWithoutMatchedCount.matched_visit_count;

    expect(() => normalizeCrmLeadsExportPage({
      rows: [rowWithoutMatchedCount],
      meta,
    }, { page: 1, pageSize: 100 })).toThrow('incompleta ou duplicada');

    expect(() => normalizeCrmLeadsExportPage({
      rows: [{ ...makeExportRow(1), matched_source: 'desconhecida' }],
      meta,
    }, { page: 1, pageSize: 100 })).toThrow('incompleta ou duplicada');
  });
});

describe('collectCrmLeadsExportPages', () => {
  it('carrega mais de 1.000 linhas achatadas e valida o total único', async () => {
    const source = Array.from({ length: 1_205 }, (_, index) => makeExportRow(index + 1));
    const getPage = vi.fn(async (page: number, pageSize: number) => ({
      rows: source.slice((page - 1) * pageSize, page * pageSize),
      meta: {
        page,
        page_size: pageSize,
        total_rows: source.length,
        total_pages: Math.ceil(source.length / pageSize),
        filtered_leads: source.length,
        matched_visits: 0,
        has_more: page < Math.ceil(source.length / pageSize),
        visit_filter_applied: false,
        generated_at: '',
      },
    }));

    const result = await collectCrmLeadsExportPages(getPage);

    expect(result.rows).toHaveLength(1_205);
    expect(getPage).toHaveBeenCalledTimes(13);
    expect(getPage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(getPage).toHaveBeenNthCalledWith(13, 13, 100);
  });

  it('falha se os totais mudarem entre páginas', async () => {
    await expect(collectCrmLeadsExportPages(async (page, pageSize) => {
      const totalRows = page === 1 ? 101 : 102;
      const source = Array.from({ length: totalRows }, (_, index) => makeExportRow(index + 1));

      return {
        rows: source.slice((page - 1) * pageSize, page * pageSize),
        meta: {
          page,
          page_size: pageSize,
          total_rows: totalRows,
          total_pages: 2,
          filtered_leads: totalRows,
          matched_visits: 0,
          has_more: page === 1,
          visit_filter_applied: false,
          generated_at: '',
        },
      };
    })).rejects.toThrow('mudou durante a exportação');
  });

  it('rejeita metadados de página divergentes sem montar exportação parcial', async () => {
    await expect(collectCrmLeadsExportPages(async (_page, pageSize) => ({
      rows: [],
      meta: {
        page: 2,
        page_size: pageSize,
        total_rows: 0,
        total_pages: 0,
        filtered_leads: 0,
        matched_visits: 0,
        has_more: false,
        visit_filter_applied: false,
        generated_at: '',
      },
    }))).rejects.toThrow('página ou contagem inconsistente');
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
