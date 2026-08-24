import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanySlugProvider, useCompanySlug } from '@/contexts/CompanySlugContext';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: supabaseMocks.from },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { company_id: null },
    roles: ['superadmin'],
    loading: false,
  }),
}));

vi.mock('@/hooks/useImpersonation', () => ({
  useImpersonation: () => ({
    isImpersonatingCompany: true,
    impersonatedCompanyId: 'company-1',
    impersonatedCompanyName: 'Empresa Teste',
    impersonatedSlug: 'empresa-teste',
  }),
}));

type QueryResponse = {
  data: Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
};

let responses: QueryResponse[] = [];

function Consumer() {
  const context = useCompanySlug();
  return (
    <div>
      <span>{context.companyName}</span>
      <span>{context.companyTimeZone}</span>
      <span>{context.companyTimeZoneResolved ? 'fuso-resolvido' : 'fuso-pendente'}</span>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/empresa-teste/admin']}>
        <Routes>
          <Route
            path="/:slug/admin"
            element={<CompanySlugProvider><Consumer /></CompanySlugProvider>}
          />
          <Route path="/acesso-negado" element={<div>Acesso negado no teste</div>} />
          <Route path="/empresas" element={<div>Lista de empresas</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CompanySlugProvider', () => {
  beforeEach(() => {
    responses = [];
    supabaseMocks.from.mockReset();
    supabaseMocks.select.mockReset();
    supabaseMocks.from.mockReturnValue({ select: supabaseMocks.select });
    supabaseMocks.select.mockImplementation(() => ({
      eq: () => ({
        maybeSingle: async () => responses.shift() ?? { data: null, error: null },
      }),
    }));
  });

  it('falls back to the legacy company select when time_zone is absent from the schema', async () => {
    responses = [
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'time_zone' column in the schema cache" } },
      { data: { id: 'company-1', name: 'Empresa Teste', slug: 'empresa-teste', logo_url: null }, error: null },
    ];

    renderProvider();

    await waitFor(() => expect(screen.getByText('fuso-resolvido')).toBeInTheDocument());
    expect(screen.getByText('America/Fortaleza')).toBeInTheDocument();
    expect(supabaseMocks.select).toHaveBeenNthCalledWith(1, 'id, name, slug, logo_url, time_zone');
    expect(supabaseMocks.select).toHaveBeenNthCalledWith(2, 'id, name, slug, logo_url');
  });

  it('uses the timezone returned by the current schema before releasing report queries', async () => {
    responses = [
      {
        data: {
          id: 'company-1',
          name: 'Empresa Teste',
          slug: 'empresa-teste',
          logo_url: null,
          time_zone: 'America/Manaus',
        },
        error: null,
      },
    ];

    renderProvider();

    await waitFor(() => expect(screen.getByText('fuso-resolvido')).toBeInTheDocument());
    expect(screen.getByText('America/Manaus')).toBeInTheDocument();
    expect(supabaseMocks.select).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid impersonated company visible but leaves its timezone pending when the background refetch fails', async () => {
    responses = [
      { data: null, error: { code: '503', message: 'Network unavailable' } },
    ];

    renderProvider();

    expect(screen.getByText('Empresa Teste')).toBeInTheDocument();
    await waitFor(() => expect(supabaseMocks.select).toHaveBeenCalledTimes(1));
    expect(screen.getByText('fuso-pendente')).toBeInTheDocument();
    expect(screen.getByText('America/Fortaleza')).toBeInTheDocument();
    expect(screen.queryByText('Acesso negado no teste')).not.toBeInTheDocument();
    expect(screen.queryByText('Lista de empresas')).not.toBeInTheDocument();
  });

  it('does not treat a transient schema-cache message as a confirmed legacy schema', async () => {
    responses = [
      {
        data: null,
        error: {
          code: '503',
          message: "Schema cache temporarily unavailable while reading 'time_zone'",
        },
      },
    ];

    renderProvider();

    await waitFor(() => expect(supabaseMocks.select).toHaveBeenCalledTimes(1));
    expect(screen.getByText('fuso-pendente')).toBeInTheDocument();
    expect(screen.queryByText('Acesso negado no teste')).not.toBeInTheDocument();
  });
});
