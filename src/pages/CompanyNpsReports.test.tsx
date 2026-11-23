import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyNpsReports from './CompanyNpsReports';

const mock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  analysisRows: null as unknown[] | null,
  failOffset: null as number | null,
  calls: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mock.from, rpc: mock.rpc },
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useMaybeCompanySlug: () => ({ companyId: 'company-1', slug: 'casa', companyName: 'Casa', companyTimeZone: 'America/Fortaleza', companyTimeZoneResolved: true }),
}));

vi.mock('@/hooks/useCompanyNpsActivation', () => ({
  useCompanyNpsActivation: () => ({ data: { company_id: 'company-1', enabled: true }, isLoading: false }),
}));

const submittedReviews = [
  {
    id: 'r1',
    submitted_at: '2026-09-24T15:00:00Z',
    recommend_score: 3,
    nps_category: 'detractor',
    comment: 'Demoraram muito para servir.',
    ambiance_rating: 3,
    food_rating: 4,
    service_rating: 2,
    reservations: { guest_name: 'Ana Souza', guest_phone: '84996463570', date: '2026-09-19' },
  },
  {
    id: 'r2',
    submitted_at: '2026-09-23T15:00:00Z',
    recommend_score: 10,
    nps_category: 'promoter',
    comment: 'Tudo perfeito!',
    ambiance_rating: 5,
    food_rating: 5,
    service_rating: 5,
    reservations: { guest_name: 'Bruno Lima', guest_phone: '84991234567', date: '2026-09-20' },
  },
  {
    id: 'r3',
    submitted_at: '2026-09-22T15:00:00Z',
    recommend_score: 9,
    nps_category: 'promoter',
    comment: null,
    ambiance_rating: 5,
    food_rating: 5,
    service_rating: 5,
    reservations: { guest_name: 'Carla Dias', guest_phone: null, date: '2026-09-21' },
  },
];

const pendingRecord = {
  id: 'p1',
  status: 'pending',
  submitted_at: null,
  invited_at: '2026-09-20T12:00:00Z',
  expires_at: '2099-10-20T12:00:00Z',
  nps_category: null,
  ambiance_rating: null,
  food_rating: null,
  service_rating: null,
  recommend_score: null,
  comment: null,
  reservations: { guest_name: 'Diego Alves', guest_phone: '84990000000', date: '2026-09-20' },
};

function createBuilder(table: string) {
  let columns = '';
  let offset = 0;
  let end = 499;
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  const chain = (method: string) => (...args: unknown[]) => {
    mock.calls.push({ table, method, args });
    if (method === 'select') columns = String(args[0]);
    if (method === 'eq') filters[args[0] as string] = args[1];
    if (method === 'gte' || method === 'lt') filters[method + ':' + args[0]] = args[1];
    if (method === 'range') { offset = Number(args[0]); end = Number(args[1]); }
    return builder;
  };
  ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'or', 'ilike', 'range', 'upsert'].forEach((method) => {
    builder[method] = chain(method);
  });
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
    const analysis = columns.includes('return_score');
    const isPrevious = String(filters['lt:invited_at']) < '2026-09-01';
    const answered = submittedReviews.map((review) => ({
      ...review, status: 'submitted', invited_at: '2026-09-18T12:00:00Z',
      expires_at: '2026-10-18T12:00:00Z', return_score: null,
    }));
    const cohort = [
      ...answered,
      ...Array.from({ length: 470 }, (_, index) => ({ ...pendingRecord, id: 'pending-' + index, return_score: null })),
      ...Array.from({ length: 3 }, (_, index) => ({ ...pendingRecord, id: 'expired-' + index, status: 'expired', return_score: null })),
    ];
    const rows = isPrevious ? [] : analysis ? mock.analysisRows ?? cohort
      : filters.status === 'pending' ? [pendingRecord]
      : filters.nps_category ? answered.filter(row => row.nps_category === filters.nps_category)
      : answered;
    const result = analysis && !isPrevious && mock.failOffset !== null && offset >= mock.failOffset
      ? { data: null, error: { message: 'Página indisponível' }, count: null }
      : { data: rows.slice(offset, end + 1), error: null, count: rows.length };
    return Promise.resolve(result).then(resolve, reject);
  };
  return builder;
}

function renderPage(initialEntry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <CompanyNpsReports />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CompanyNpsReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.calls.length = 0;
    mock.analysisRows = null;
    mock.failOffset = null;
    mock.from.mockImplementation((table: string) => createBuilder(table));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));

  });

  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('mostra os indicadores, o detrator a contatar e o aviso de poucas respostas', async () => {
    renderPage();

    const kpis = await screen.findByRole('region', { name: 'Indicadores de avaliação' });
    expect(within(kpis).getByText('+33')).toBeInTheDocument();
    expect(within(kpis).getByText('de 476 convites · 0,6% de resposta')).toBeInTheDocument();
    expect(within(kpis).getByText(/amostra pequena/)).toBeInTheDocument();

    expect(screen.getByText('Poucas respostas para o volume de convites')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Revisar pós-visita' })).toHaveAttribute('href', '/casa/admin/automacoes');

    expect(await screen.findByText('Precisa de atenção')).toBeInTheDocument();
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Conversar com Ana Souza no WhatsApp' }))
      .toHaveAttribute('href', 'https://wa.me/5584996463570');
    expect(screen.getByText(/aparecem a partir de 10 respostas/)).toBeInTheDocument();
  });

  it('abre os registros nas respondidas e filtra os pendentes no servidor', async () => {
    renderPage();

    const registrosTab = await screen.findByRole('tab', { name: 'Registros' });
    fireEvent.mouseDown(registrosTab, { button: 0 });

    const answered = await screen.findByRole('button', { name: /Respondidas/ });
    expect(answered).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText('3 registros');

    fireEvent.click(screen.getByRole('button', { name: /Aguardando/ }));

    await screen.findByText('Diego Alves');
    expect(screen.getAllByText('Aguardando').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'eq', args: ['status', 'pending'] });
    });
  });

  it('uses exact company-day boundaries and the same previous window without the legacy summary RPC', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Indicadores de avaliação' });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'gte', args: ['invited_at', '2026-08-28T03:00:00.000Z'] });
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'lt', args: ['invited_at', '2026-09-27T03:00:00.000Z'] });
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'gte', args: ['invited_at', '2026-07-29T03:00:00.000Z'] });
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'lt', args: ['invited_at', '2026-08-28T03:00:00.000Z'] });
    const analysisFields = mock.calls.filter(call => call.method === 'select' && String(call.args[0]).includes('return_score'));
    expect(analysisFields.every(call => !String(call.args[0]).includes('guest_name') && !String(call.args[0]).includes('guest_phone'))).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Selecionar granularidade do relatório' })).not.toBeInTheDocument();
  });

  it('loads every analysis page beyond 1,000 and keeps summary and coverage complete', async () => {
    mock.analysisRows = Array.from({ length: 1501 }, (_, index) => ({
      ...submittedReviews[1], id: 'large-' + index, status: 'submitted',
      invited_at: '2026-09-18T12:00:00Z', expires_at: '2026-10-18T12:00:00Z', return_score: null,
    }));
    renderPage();
    const kpis = await screen.findByRole('region', { name: 'Indicadores de avaliação' });
    expect(within(kpis).getByText('1.501')).toBeInTheDocument();
    expect(within(kpis).getByText('+100')).toBeInTheDocument();
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'range', args: [1000, 1499] });
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'range', args: [1500, 1999] });
    expect(screen.getByText(/1.501 respostas de 1.501 convites/)).toBeInTheDocument();
  });

  it('does not show a partial population when a later analysis page fails', async () => {
    mock.analysisRows = Array.from({ length: 1001 }, (_, index) => ({ ...pendingRecord, id: 'large-' + index }));
    mock.failOffset = 500;
    renderPage();
    expect(await screen.findByText('Não foi possível carregar as avaliações')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Indicadores de avaliação' })).not.toBeInTheDocument();
    expect(screen.queryByText('Cobertura completa')).not.toBeInTheDocument();
  });

  it('opens the detractor records from its indicator and preserves the custom period', async () => {
    renderPage('/?period=custom&from=2026-09-01&to=2026-09-26&compare=0');
    const trigger = await screen.findByRole('button', { name: 'Abrir registros de Detratores' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('button', { name: /^Detratores/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tab', { name: 'Registros' })).toHaveAttribute('aria-selected', 'true');
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'gte', args: ['invited_at', '2026-09-01T03:00:00.000Z'] });
    expect(mock.calls).toContainEqual({ table: 'reservation_reviews', method: 'eq', args: ['nps_category', 'detractor'] });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Resumo' }), { button: 0 });
    expect(await screen.findByRole('region', { name: 'Leituras do período' })).toBeInTheDocument();
  });
});
