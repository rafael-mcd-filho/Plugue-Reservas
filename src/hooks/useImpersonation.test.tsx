import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useImpersonation, type SupportImpersonationContext } from '@/hooks/useImpersonation';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { getImpersonationSession, startImpersonationSession, type ImpersonationSession } from '@/lib/impersonationSession';
import type { AppRole, CompanyPanelPermission } from '@/lib/companyPermissions';

const mocks = vi.hoisted(() => ({
  actor: { id: '00000000-0000-4000-8000-000000000001' },
  roles: ['support'] as AppRole[],
  rpc: vi.fn(),
  permissionQuery: vi.fn(),
  permissionFilters: [] as Array<[string, unknown]>,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.actor, profile: { company_id: null }, roles: mocks.roles, loading: false }),
}));

vi.mock('@/contexts/CompanySlugContext', () => ({
  useMaybeCompanySlug: () => ({ companyId: 'company-one' }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table: string) => {
      if (table !== 'company_user_panel_permissions') throw new Error('Unexpected table: ' + table);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          mocks.permissionFilters.push([column, value]);
          return query;
        },
        maybeSingle: mocks.permissionQuery,
      };
      return query;
    },
  },
}));

const queryClients: QueryClient[] = [];

function storedSession(overrides: Partial<ImpersonationSession> = {}): ImpersonationSession {
  return {
    actorUserId: mocks.actor.id,
    companyId: 'company-one',
    companySlug: 'empresa-a',
    companyName: 'Empresa A',
    userId: 'target-one',
    userName: 'Nome alterado no navegador',
    userEmail: 'target@example.test',
    effectiveRole: 'admin',
    status: 'active',
    startedAt: new Date().toISOString(),
    supportSessionId: '00000000-0000-4000-8000-000000000009',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
}

function serverContext(overrides: Partial<SupportImpersonationContext> = {}): SupportImpersonationContext {
  const { status: _, startedAt: __, supportSessionId, ...context } = storedSession();
  return {
    ...context,
    id: supportSessionId!,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    userName: 'Operador autorizado',
    effectiveRole: 'operator',
    ...overrides,
  };
}

function Probe() {
  const impersonation = useImpersonation();
  const permissions = useCompanyPermissions();
  return <output data-testid="state">{JSON.stringify({
    isImpersonatingCompany: impersonation.isImpersonatingCompany,
    impersonationLoading: impersonation.impersonationLoading,
    effectiveRoles: impersonation.effectiveRoles,
    targetName: impersonation.impersonatedUserName,
    targetUserId: impersonation.impersonatedUserId,
    permissionNames: [...permissions.permissions],
    permissionsLoading: permissions.permissionsLoading,
  })}</output>;
}

function readState() {
  return JSON.parse(screen.getByTestId('state').textContent!);
}

function renderRuntime(options: { path?: string; allowedRoles?: AppRole[]; requiredPermission?: CompanyPanelPermission } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const content = options.allowedRoles
    ? <ProtectedRoute allowedRoles={options.allowedRoles} requiredCompanyPermission={options.requiredPermission}><Probe /></ProtectedRoute>
    : <Probe />;
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.path ?? '/empresa-a/admin']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/:slug/admin/*" element={content} />
          <Route path="/financeiro" element={content} />
          <Route path="/acesso-negado" element={<p>Acesso negado</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.roles = ['support'];
  mocks.permissionFilters = [];
  mocks.rpc.mockResolvedValue({ data: serverContext(), error: null });
  mocks.permissionQuery.mockResolvedValue({
    data: { permission_overrides: { dashboard_view: false, tables_view: true } },
    error: null,
  });
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  sessionStorage.clear();
});

describe('support impersonation runtime', () => {
  it('keeps company roles inaccessible until the backend validates the delegation and uses the target operator overrides', async () => {
    let completeContext: (result: { data: SupportImpersonationContext; error: null }) => void;
    mocks.rpc.mockImplementation(() => new Promise((resolve) => { completeContext = resolve; }));
    startImpersonationSession(storedSession());
    renderRuntime();
    expect(readState()).toMatchObject({
      isImpersonatingCompany: false,
      impersonationLoading: true,
      effectiveRoles: ['support'],
      permissionNames: [],
    });
    expect(mocks.permissionQuery).not.toHaveBeenCalled();

    await act(async () => { completeContext!({ data: serverContext(), error: null }); });
    await waitFor(() => expect(readState().permissionsLoading).toBe(false));
    expect(readState()).toMatchObject({
      isImpersonatingCompany: true,
      effectiveRoles: ['operator'],
      targetName: 'Operador autorizado',
      targetUserId: 'target-one',
    });
    expect(readState().permissionNames).toContain('tables_view');
    expect(readState().permissionNames).not.toContain('dashboard_view');
    expect(readState().permissionNames).not.toContain('settings_view');
    expect(mocks.permissionFilters).toEqual(expect.arrayContaining([
      ['company_id', 'company-one'], ['user_id', 'target-one'],
    ]));
  });

  it('never allows a support actor to use a local superadmin-style session without a server delegation', async () => {
    startImpersonationSession(storedSession({ supportSessionId: undefined, expiresAt: undefined }));
    renderRuntime();
    await waitFor(() => expect(getImpersonationSession()).toBeNull());
    expect(readState()).toMatchObject({ isImpersonatingCompany: false, effectiveRoles: ['support'], permissionNames: [] });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked delegation', null],
    ['different actor', serverContext({ actorUserId: 'another-actor' })],
    ['different company', serverContext({ companyId: 'company-two' })],
    ['different target', serverContext({ userId: 'target-two' })],
    ['expired delegation', serverContext({ expiresAt: '2020-01-01T00:00:00.000Z' })],
    ['invalid expiry', serverContext({ expiresAt: 'not-a-date' })],
  ])('clears local context and denies company access after %s', async (_, context) => {
    mocks.rpc.mockResolvedValue({ data: context, error: null });
    startImpersonationSession(storedSession());
    renderRuntime();
    await waitFor(() => expect(getImpersonationSession()).toBeNull());
    expect(readState()).toMatchObject({ isImpersonatingCompany: false, effectiveRoles: ['support'], permissionNames: [] });
  });

  it('removes a previously validated context when the authorization is revoked on refresh', async () => {
    startImpersonationSession(storedSession());
    const queryClient = renderRuntime();
    await waitFor(() => expect(readState().isImpersonatingCompany).toBe(true));
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['support-impersonation-context'] }); });
    await waitFor(() => expect(getImpersonationSession()).toBeNull());
    expect(readState()).toMatchObject({ isImpersonatingCompany: false, effectiveRoles: ['support'], permissionNames: [] });
  });

  it('denies global superadmin routes to support actors', async () => {
    renderRuntime({ path: '/financeiro', allowedRoles: ['superadmin'] });
    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(screen.queryByTestId('state')).not.toBeInTheDocument();
  });

  it('denies a company route disabled by the target operator override', async () => {
    startImpersonationSession(storedSession());
    renderRuntime({ allowedRoles: ['admin', 'operator'], requiredPermission: 'dashboard_view' });
    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(screen.queryByTestId('state')).not.toBeInTheDocument();
  });

  it('does not grant a company route from modified browser permission cache while awaiting the target permissions', async () => {
    let completePermissions: (result: { data: { permission_overrides: { dashboard_view: boolean } }; error: null }) => void;
    mocks.permissionQuery.mockImplementation(() => new Promise((resolve) => { completePermissions = resolve; }));
    sessionStorage.setItem('company-panel-permission-overrides:company-one:target-one', JSON.stringify({ dashboard_view: true }));
    startImpersonationSession(storedSession());
    renderRuntime({ allowedRoles: ['admin', 'operator'], requiredPermission: 'dashboard_view' });
    await waitFor(() => expect(mocks.permissionQuery).toHaveBeenCalled());
    expect(screen.queryByTestId('state')).not.toBeInTheDocument();
    expect(screen.queryByText('Acesso negado')).not.toBeInTheDocument();

    await act(async () => { completePermissions!({ data: { permission_overrides: { dashboard_view: false } }, error: null }); });
    expect(await screen.findByText('Acesso negado')).toBeInTheDocument();
    expect(screen.queryByTestId('state')).not.toBeInTheDocument();
  });

  it('clears an already expired stored support context before company access can be granted', async () => {
    startImpersonationSession(storedSession({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    renderRuntime();
    await waitFor(() => expect(getImpersonationSession()).toBeNull());
    expect(readState()).toMatchObject({ isImpersonatingCompany: false, effectiveRoles: ['support'], permissionNames: [] });
  });
});
