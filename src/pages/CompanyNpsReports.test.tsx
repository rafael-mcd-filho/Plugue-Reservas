import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format } from 'date-fns';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyNpsReports from './CompanyNpsReports';

const mock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  calls: [] as { table: string; method: string; args: unknown[] }[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mock.from, rpc: mock.rpc },
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useMaybeCompanySlug: () => ({ companyId: 'company-1', slug: 'casa', companyName: 'Casa' }),
}));

vi.mock('@/hooks/useCompanyNpsActivation', () => ({
  useCompanyNpsActivation: () => ({ data: { company_id: 'company-1', enabled: true }, isLoading: false }),
}));

const summary = {
  total_invited: 476,
  total_submitted: 3,
  total_pending: 470,
  total_expired: 3,
  response_rate: 0.6,
  nps_score: 33,
  promoters: 2,
  passives: 0,
  detractors: 1,
  avg_ambiance: 4.3,
  avg_food: 4.7,
  avg_service: 4.3,
  avg_return: null,
};

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
  let countRequested = false;
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  const chain = (method: string) => (...args: unknown[]) => {
    mock.calls.push({ table, method, args });
    if (method === 'select' && (args[1] as { count?: string } | undefined)?.count) countRequested = true;
    if (method === 'eq') filters[args[0] as string] = args[1];
    return builder;
  };
  ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'or', 'ilike', 'range', 'upsert'].forEach((method) => {
    builder[method] = chain(method);
  });
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
    const result = countRequested
      ? (filters.status === 'pending'
        ? { data: [pendingRecord], error: null, count: 1 }
        : {
          data: submittedReviews.map((review) => ({
            ...review,
            status: 'submitted',
            invited_at: '2026-09-18T12:00:00Z',
            expires_at: '2026-10-18T12:00:00Z',
          })),
          error: null,
          count: 3,
        })
      : { data: submittedReviews, error: null };
    return Promise.resolve(result).then(resolve, reject);
  };
  return builder;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CompanyNpsReports />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CompanyNpsReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.calls.length = 0;
    mock.from.mockImplementation((table: string) => createBuilder(table));
    // Só o período atual tem dados: sem base anterior, nenhum indicador mostra variação.
    mock.rpc.mockImplementation((_name: string, args: { _to: string }) => (
      Promise.resolve({ data: args._to === format(new Date(), 'yyyy-MM-dd') ? [summary] : [], error: null })
    ));
  });

  afterEach(() => cleanup());

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
});
