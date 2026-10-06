import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyPanelEntryRoute from '@/components/company/CompanyPanelEntryRoute';
import ProtectedRoute from '@/components/ProtectedRoute';
import { CompanySlugProvider } from '@/contexts/CompanySlugContext';
import { getImpersonationSession, startImpersonationSession } from '@/lib/impersonationSession';
import type { SupportImpersonationContext } from '@/hooks/useImpersonation';
import type { CompanyPanelPermissionOverrides } from '@/lib/companyPermissions';

const mocks = vi.hoisted(() => ({
  actor: { id: '00000000-0000-4000-8000-000000000001' },
  rpc: vi.fn(),
  companyQuery: vi.fn(),
  permissionQuery: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.actor, profile: { company_id: null }, roles: ['support'], loading: false }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));

const queryClients: QueryClient[] = [];
const onlyTables: CompanyPanelPermissionOverrides = {
  dashboard_view: false,
  checkins_view: false,
  reservations_view: false,
  calendar_view: false,
  tables_view: true,
  waitlist_view: false,
};

function context(): SupportImpersonationContext {
  return {
    id: '00000000-0000-4000-8000-000000000009',
    actorUserId: mocks.actor.id,
    companyId: 'company-one',
    companySlug: 'empresa-a',
    companyName: 'Empresa A',
    userId: 'target-one',
    userName: 'Operador autorizado',
    userEmail: 'target@example.test',
    effectiveRole: 'operator',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}

function startPendingSession() {
  const server = context();
  startImpersonationSession({
    ...server,
    supportSessionId: server.id,
    status: 'pending',
    startedAt: new Date().toISOString(),
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function renderEntry({ withGuard = true, path = '/empresa-a/admin' } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const entry = <CompanySlugProvider>
    <CompanyPanelEntryRoute loadingFallback={<p>Validando permissões</p>}>
      <p>Dashboard autorizado</p>
    </CompanyPanelEntryRoute>
  </CompanySlugProvider>;
  render(<QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LocationProbe />
      <Routes>
        <Route path="/:slug/admin" element={withGuard
          ? <ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>{entry}</ProtectedRoute>
          : entry} />
        <Route path="/:slug/admin/mesas" element={<ProtectedRoute allowedRoles={['admin', 'operator']} requiredCompanyPermission="tables_view">
          <CompanySlugProvider><p>Mesas autorizadas</p></CompanySlugProvider>
        </ProtectedRoute>} />
        <Route path="/empresas" element={<p>Empresas autorizadas</p>} />
        <Route path="/acesso-negado" element={<p>Acesso negado</p>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>);
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.rpc.mockResolvedValue({ data: context(), error: null });
  mocks.companyQuery.mockResolvedValue({ data: {
    id: 'company-one', name: 'Empresa A', slug: 'empresa-a', time_zone: 'America/Sao_Paulo',
  }, error: null });
  mocks.permissionQuery.mockResolvedValue({ data: { permission_overrides: onlyTables }, error: null });
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: table === 'companies' ? mocks.companyQuery : mocks.permissionQuery,
    };
    if (!['companies', 'company_user_panel_permissions'].includes(table)) throw new Error(`Unexpected table ${table}`);
    return query;
  });
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  sessionStorage.clear();
});

describe('support company entry with real route guards', () => {
  it('waits for delegation validation before querying the company or redirecting', async () => {
    let completeContext!: (result: { data: SupportImpersonationContext; error: null }) => void;
    mocks.rpc.mockImplementation(() => new Promise((resolve) => { completeContext = resolve; }));
    startPendingSession();
    renderEntry({ withGuard: false });

    expect(mocks.companyQuery).not.toHaveBeenCalled();
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin');
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();
    expect(screen.queryByText('Empresas autorizadas')).not.toBeInTheDocument();

    await act(async () => { completeContext({ data: context(), error: null }); });
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();
    expect(mocks.companyQuery).toHaveBeenCalled();
  });

  it('waits for target overrides and enters Mesas when Dashboard and every other operator page are disabled', async () => {
    let completePermissions!: (result: { data: { permission_overrides: CompanyPanelPermissionOverrides }; error: null }) => void;
    mocks.permissionQuery.mockImplementation(() => new Promise((resolve) => { completePermissions = resolve; }));
    startPendingSession();
    renderEntry();

    await waitFor(() => expect(mocks.permissionQuery).toHaveBeenCalled());
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin');
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();
    expect(mocks.companyQuery).not.toHaveBeenCalled();

    await act(async () => { completePermissions({ data: { permission_overrides: onlyTables }, error: null }); });
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin/mesas');
    expect(getImpersonationSession()?.status).toBe('active');
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
  });

  it('suspends access when overrides fail, ignores browser cache, and recovers the same session on retry', async () => {
    mocks.permissionQuery.mockResolvedValueOnce({ data: null, error: new Error('Permission read failed') });
    sessionStorage.setItem('company-panel-permission-overrides:company-one:target-one', JSON.stringify({ dashboard_view: true }));
    startPendingSession();
    renderEntry();

    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
    expect(screen.queryByText('Mesas autorizadas')).not.toBeInTheDocument();
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin');
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
    expect(mocks.companyQuery).not.toHaveBeenCalled();

    fireEvent.click(retry);
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();
    expect(mocks.permissionQuery).toHaveBeenCalledTimes(2);
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
  });

  it.each(['42501', 'PGRST301'])('denies access when reading overrides fails with authorization code %s', async (code) => {
    mocks.permissionQuery.mockResolvedValue({ data: null, error: { code, message: 'Access denied' } });
    startPendingSession();
    renderEntry();

    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
    expect(screen.queryByText('Mesas autorizadas')).not.toBeInTheDocument();
  });

  it('suspends cached page permissions when an override refresh fails and resumes only after a successful retry', async () => {
    startPendingSession();
    const queryClient = renderEntry();
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();

    mocks.permissionQuery.mockResolvedValueOnce({ data: null, error: { code: '503', message: 'Service unavailable' } });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['company-panel-permission-overrides'] }); });
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    expect(screen.queryByText('Mesas autorizadas')).not.toBeInTheDocument();
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin/mesas');

    fireEvent.click(retry);
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
  });

  it('fails closed when the server rejects the pending delegation', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Access revoked' } });
    startPendingSession();
    renderEntry();

    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(mocks.companyQuery).not.toHaveBeenCalled();
    expect(mocks.permissionQuery).not.toHaveBeenCalled();
    expect(getImpersonationSession()).toBeNull();
  });

  it('suspends company access on a network failure and retries the same delegation without redirecting', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '', message: 'Failed to fetch' } });
    startPendingSession();
    renderEntry();

    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin');
    expect(mocks.permissionQuery).not.toHaveBeenCalled();
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();

    mocks.rpc.mockResolvedValue({ data: context(), error: null });
    fireEvent.click(retry);
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
  });

  it('does not keep rendering a previously validated company while a context refresh fails', async () => {
    startPendingSession();
    const queryClient = renderEntry();
    expect(await screen.findByText('Mesas autorizadas')).toBeInTheDocument();

    mocks.rpc.mockResolvedValue({ data: null, error: { code: '503', message: 'Service unavailable' } });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['support-impersonation-context'] }); });
    expect(await screen.findByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
    expect(screen.queryByText('Mesas autorizadas')).not.toBeInTheDocument();
    expect(getImpersonationSession()?.supportSessionId).toBe(context().id);
    expect(screen.getByTestId('path')).toHaveTextContent('/empresa-a/admin/mesas');
  });

  it('never reuses a valid company delegation to open another company route', async () => {
    startPendingSession();
    renderEntry({ path: '/empresa-b/admin' });

    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(mocks.companyQuery).not.toHaveBeenCalled();
    expect(mocks.permissionQuery).not.toHaveBeenCalled();
    expect(screen.queryByText('Dashboard autorizado')).not.toBeInTheDocument();
  });
});
