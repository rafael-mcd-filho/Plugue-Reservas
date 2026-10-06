import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AppRole } from '@/lib/companyPermissions';
import App from '@/App';

const mocks = vi.hoisted(() => ({
  roles: ['support'] as AppRole[],
  effectiveRoles: ['support'] as AppRole[],
  impersonating: false,
  company: null as null | { companyId: string; companyName: string; companySlug: string },
  hasPermission: vi.fn(() => true),
}));

vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'support-user' },
    profile: { full_name: 'Pessoa de suporte', email: 'support@example.test', company_id: null },
    roles: mocks.roles,
    loading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock('@/contexts/CompanySlugContext', () => ({
  CompanySlugProvider: ({ children }: { children: ReactNode }) => children,
  useMaybeCompanySlug: () => mocks.company,
}));
vi.mock('@/hooks/useImpersonation', () => ({
  useImpersonation: () => ({
    isImpersonatingCompany: mocks.impersonating,
    effectiveRoles: mocks.effectiveRoles,
    effectiveRole: mocks.effectiveRoles[0],
    impersonatedSlug: mocks.company?.companySlug,
    impersonationLoading: false,
    auditMetadata: {},
    stopImpersonation: vi.fn(),
  }),
}));
vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({
    activeRoles: mocks.effectiveRoles,
    hasPermission: mocks.hasPermission,
    permissionsLoading: false,
  }),
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
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/company/CompanyFeatureRouteGate', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/WhatsAppStatusAlert', () => ({ default: () => null }));
vi.mock('@/components/CompanyNotificationsPopover', () => ({ default: () => null }));
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }));
vi.mock('@/pages/SupportCompanies', () => ({ default: () => <h2>Empresas permitidas do suporte</h2> }));
vi.mock('@/pages/Companies', () => ({ default: () => <h2>Cadastro global de empresas</h2> }));
vi.mock('@/pages/Dashboard', () => ({ default: () => <h2>Conteúdo do dashboard</h2> }));
vi.mock('@/pages/AccessDenied', () => ({ default: () => <h2>Acesso negado</h2> }));

beforeEach(() => {
  mocks.roles = ['support'];
  mocks.effectiveRoles = ['support'];
  mocks.impersonating = false;
  mocks.company = null;
  mocks.hasPermission.mockReturnValue(true);
  // Node 25 exposes a localStorage accessor without a backing file. Provide a
  // per-test browser store so the sidebar pin preference stays isolated.
  const sidebarPreferences = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => sidebarPreferences.get(key) ?? null,
      setItem: (key: string, value: string) => sidebarPreferences.set(key, String(value)),
    },
  });
});

afterEach(() => cleanup());

function renderAt(path: string) {
  window.history.replaceState({}, '', path);
  render(<App />);
}

describe('support companies-only platform navigation', () => {
  it.each(['/', '/dashboard', '/empresas'])('takes support at %s to allowed companies with only Empresas in the menu', async (path) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { name: 'Empresas permitidas do suporte' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/empresas');
    const menu = within(screen.getByRole('navigation'));
    expect(menu.getAllByRole('link')).toHaveLength(1);
    expect(menu.getByRole('link', { name: 'Empresas' })).toHaveAttribute('href', '/empresas');
    expect(menu.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Conteúdo do dashboard' })).not.toBeInTheDocument();
  });

  it('keeps the superadmin home dashboard and global navigation', async () => {
    mocks.roles = ['superadmin'];
    mocks.effectiveRoles = ['superadmin'];
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Conteúdo do dashboard' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/dashboard');
    const menu = within(screen.getByRole('navigation'));
    expect(menu.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(menu.getByRole('link', { name: 'Financeiro' })).toHaveAttribute('href', '/financeiro');
  });

  it('keeps the full company management page for superadmin', async () => {
    mocks.roles = ['superadmin'];
    mocks.effectiveRoles = ['superadmin'];
    renderAt('/empresas');
    expect(await screen.findByRole('heading', { name: 'Cadastro global de empresas' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Empresas permitidas do suporte' })).not.toBeInTheDocument();
  });

  it('still denies other global pages to support', async () => {
    renderAt('/financeiro');
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/acesso-negado');
  });

  it('preserves the company dashboard when support impersonates an authorized admin', async () => {
    mocks.impersonating = true;
    mocks.effectiveRoles = ['admin'];
    mocks.company = { companyId: 'company-one', companyName: 'Empresa A', companySlug: 'empresa-a' };
    renderAt('/empresa-a/admin');
    expect(await screen.findByRole('heading', { name: 'Conteúdo do dashboard' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/empresa-a/admin');
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Dashboard' }))
      .toHaveAttribute('href', '/empresa-a/admin');
  });
});
