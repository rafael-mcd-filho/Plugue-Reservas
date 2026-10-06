import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from '@/components/AppLayout';
import ProtectedRoute from '@/components/ProtectedRoute';
import CompanyPanelEntryRoute from '@/components/company/CompanyPanelEntryRoute';
import { CompanySlugProvider } from '@/contexts/CompanySlugContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getImpersonationSession, startImpersonationSession } from '@/lib/impersonationSession';
import type { SupportImpersonationContext } from '@/hooks/useImpersonation';
import type { AppRole } from '@/lib/companyPermissions';

const mocks = vi.hoisted(() => ({
  actor: { id: '00000000-0000-4000-8000-000000000001' },
  roles: ['support'] as AppRole[],
  rpc: vi.fn(),
  companyQuery: vi.fn(),
  permissionQuery: vi.fn(),
  from: vi.fn(),
  deniedRendered: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: mocks.actor,
    profile: { company_id: null, full_name: 'Pessoa de suporte', email: 'support@example.test' },
    roles: mocks.roles,
    loading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('@/hooks/useSettings', () => ({
  useSystemBranding: () => ({ data: { system_name: 'Plug Guest' }, isLoading: false }),
}));
vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatureFlags: () => ({ data: { features: { advanced_reports: true } }, isLoading: false }),
}));
vi.mock('@/hooks/usePlatformBilling', () => ({
  useCompanyBillingOverdueWarning: () => ({ data: null }),
  useCompanyBillingSummary: () => ({ data: null }),
  usePlatformBillingModuleStatus: () => ({ data: { enabled: false } }),
}));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: vi.fn() }));
vi.mock('@/lib/accessAudit', () => ({
  trackAccessAudit: vi.fn(async () => undefined),
  reportAccessAuditFailure: vi.fn(),
}));
vi.mock('@/components/WhatsAppStatusAlert', () => ({ default: () => null }));
vi.mock('@/components/CompanyNotificationsPopover', () => ({ default: () => null }));
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }));

const queryClients: QueryClient[] = [];

function context(effectiveRole: 'admin' | 'operator' = 'operator'): SupportImpersonationContext {
  return {
    id: '00000000-0000-4000-8000-000000000009',
    actorUserId: mocks.actor.id,
    companyId: 'company-one',
    companySlug: 'empresa-a',
    companyName: 'Empresa A',
    userId: 'target-one',
    userName: 'Usuário autorizado',
    userEmail: 'target@example.test',
    effectiveRole,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function AccessDenied() {
  useEffect(() => { mocks.deniedRendered(); }, []);
  return <p>Acesso negado</p>;
}

function renderImpersonation(effectiveRole: 'admin' | 'operator' = 'operator') {
  const server = context(effectiveRole);
  startImpersonationSession({
    ...server,
    supportSessionId: mocks.roles.includes('support') ? server.id : undefined,
    status: 'active',
    startedAt: new Date().toISOString(),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  render(<QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <MemoryRouter initialEntries={['/empresa-a/admin']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <LocationProbe />
        <Routes>
          <Route path="/:slug/admin" element={<ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>
            <CompanySlugProvider>
              <AppLayout>
                <CompanyPanelEntryRoute loadingFallback={<p>Validando permissões</p>}>
                  <h2>Dashboard da empresa</h2>
                </CompanyPanelEntryRoute>
              </AppLayout>
            </CompanySlugProvider>
          </ProtectedRoute>} />
          <Route path="/empresas" element={<ProtectedRoute allowedRoles={['support', 'superadmin']}>
            <AppLayout><h2>Empresas permitidas</h2></AppLayout>
          </ProtectedRoute>} />
          <Route path="/dashboard" element={<ProtectedRoute allowedRoles={['superadmin']}>
            <AppLayout><h2>Dashboard global</h2></AppLayout>
          </ProtectedRoute>} />
          <Route path="/acesso-negado" element={<AccessDenied />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>);
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  sessionStorage.clear();
  mocks.roles = ['support'];
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_support_impersonation_context') return { data: context(), error: null };
    if (name === 'stop_support_impersonation') return { data: null, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  mocks.companyQuery.mockResolvedValue({ data: {
    id: 'company-one', name: 'Empresa A', slug: 'empresa-a', time_zone: 'America/Sao_Paulo',
  }, error: null });
  mocks.permissionQuery.mockResolvedValue({ data: { permission_overrides: { dashboard_view: true } }, error: null });
  mocks.from.mockImplementation((table: string) => {
    if (!['companies', 'company_user_panel_permissions'].includes(table)) throw new Error(`Unexpected table ${table}`);
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: table === 'companies' ? mocks.companyQuery : mocks.permissionQuery,
    };
    return query;
  });
  const sidebarPreferences = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => sidebarPreferences.get(key) ?? null,
      setItem: (key: string, value: string) => sidebarPreferences.set(key, String(value)),
    },
  });
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('leaving impersonation with the real layout, delegation hook, and guards', () => {
  it.each(['operator', 'admin'] as const)('takes Support impersonating %s directly to Empresas without rendering Access Denied', async (role) => {
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'get_support_impersonation_context' ? context(role) : null,
      error: null,
    }));
    renderImpersonation(role);
    expect(await screen.findByRole('heading', { name: 'Dashboard da empresa' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));

    expect(await screen.findByRole('heading', { name: 'Empresas permitidas' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/empresas$/);
    expect(getImpersonationSession()).toBeNull();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('stop_support_impersonation', { _session_id: context().id });
  });

  it('finishes a delayed server stop without exposing a denied page or keeping local delegation', async () => {
    let finishStop!: (result: { data: null; error: null }) => void;
    mocks.rpc.mockImplementation((name: string) => name === 'get_support_impersonation_context'
      ? Promise.resolve({ data: context(), error: null })
      : new Promise((resolve) => { finishStop = resolve; }));
    renderImpersonation();
    await screen.findByRole('heading', { name: 'Dashboard da empresa' });

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('stop_support_impersonation', { _session_id: context().id }));
    expect(mocks.deniedRendered).not.toHaveBeenCalled();

    await act(async () => { finishStop({ data: null, error: null }); });

    expect(await screen.findByRole('heading', { name: 'Empresas permitidas' })).toBeInTheDocument();
    expect(getImpersonationSession()).toBeNull();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
  });

  it('clears local delegation and returns to Empresas even when stopping the server session throws', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_support_impersonation_context') return { data: context(), error: null };
      throw new Error('Failed to fetch');
    });
    renderImpersonation();
    await screen.findByRole('heading', { name: 'Dashboard da empresa' });

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));

    expect(await screen.findByRole('heading', { name: 'Empresas permitidas' })).toBeInTheDocument();
    expect(getImpersonationSession()).toBeNull();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Dashboard da empresa' })).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('clears delegated cache and returns to Empresas when the stop RPC returns an error', async () => {
    const serverDetail = 'Sensitive server failure details';
    mocks.rpc.mockImplementation(async (name: string) => name === 'get_support_impersonation_context'
      ? { data: context(), error: null }
      : { data: null, error: { code: '503', message: serverDetail } });
    const queryClient = renderImpersonation();
    await screen.findByRole('heading', { name: 'Dashboard da empresa' });
    queryClient.setQueryData(['delegated-company-data'], { private: true });

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));

    expect(await screen.findByRole('heading', { name: 'Empresas permitidas' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/empresas$/);
    expect(getImpersonationSession()).toBeNull();
    expect(queryClient.getQueryData(['delegated-company-data'])).toBeUndefined();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls.flat()).not.toContain(serverDetail);
  });

  it('removes local delegation and cached company data even when cancelling queries fails', async () => {
    const queryClient = renderImpersonation();
    await screen.findByRole('heading', { name: 'Dashboard da empresa' });
    queryClient.setQueryData(['delegated-company-data'], { private: true });
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries').mockRejectedValueOnce(new Error('Cancellation failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));

    expect(await screen.findByRole('heading', { name: 'Empresas permitidas' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/empresas$/);
    expect(cancelQueries).toHaveBeenCalled();
    expect(getImpersonationSession()).toBeNull();
    expect(queryClient.getQueryData(['delegated-company-data'])).toBeUndefined();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('preserves Superadmin exit to the global Dashboard without a support stop RPC', async () => {
    mocks.roles = ['superadmin'];
    renderImpersonation('admin');
    await screen.findByRole('heading', { name: 'Dashboard da empresa' });

    fireEvent.click(screen.getByRole('button', { name: 'Sair da impersonação' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard global' })).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/dashboard$/);
    expect(getImpersonationSession()).toBeNull();
    expect(mocks.deniedRendered).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('stop_support_impersonation', expect.anything());
  });
});
