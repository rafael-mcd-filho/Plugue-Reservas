import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyDetail from './CompanyDetail';

const state = vi.hoisted(() => ({
  billing: {} as Record<string, unknown>,
  settlement: {} as Record<string, unknown>,
  features: {} as Record<string, unknown>,
  users: {} as Record<string, unknown>,
  access: {} as Record<string, unknown>,
  lastAccess: vi.fn(),
}));
const company = { id: 'company-a', name: 'Empresa teste', slug: 'empresa-teste', status: 'active', created_at: '2026-11-23T12:00:00Z', responsible_phone: '+5562999990000' };
vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({ data: [company], isPending: false, isError: false }),
  useUpdateCompany: () => ({ isPending: false, mutate: vi.fn() }),
  useRequestCompanyDeletion: () => ({ isPending: false, mutate: vi.fn() }),
  useCancelCompanyDeletion: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useCompanyFeatures', () => ({ useCompanyFeatureFlags: () => state.features }));
vi.mock('@/hooks/usePlatformBilling', () => ({ useSuperadminBillingOverview: () => state.billing }));
vi.mock('@/hooks/useUsers', () => ({ useUsers: () => state.users }));
vi.mock('@/hooks/useLastPanelAccess', () => ({ useLastPanelAccess: (...args: unknown[]) => { state.lastAccess(...args); return state.access; } }));
vi.mock('@/components/company-detail/useCompanyDetailData', () => ({
  useCompanySettlement: () => state.settlement,
  useCompanyHistory: () => ({ data: { access: [], audit: [], auditTotal: 0 }, isPending: false, isError: false }),
}));
vi.mock('@/components/company-detail/CompanyFeaturesTab', () => ({ default: () => null }));
vi.mock('@/components/company-detail/CompanyFinanceTab', () => ({ default: () => null }));
vi.mock('@/components/company-detail/CompanyRegistrationTab', () => ({ default: () => null }));
vi.mock('@/components/company-detail/CompanyUsersTab', () => ({ default: () => null }));

function query(overrides: Record<string, unknown> = {}) {
  return { isPending: false, isError: false, isSuccess: false, refetch: vi.fn(), ...overrides };
}
function setup() {
  render(<MemoryRouter initialEntries={['/empresas/company-a']}><Routes><Route path="/empresas/:id" element={<CompanyDetail />} /></Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.billing = query({ isError: true });
  state.settlement = query({ isError: true });
  state.features = query({ isError: true });
  state.users = query({ isError: true });
  state.access = query({ isError: true });
});

describe('company detail availability', () => {
  it('does not turn financial, feature and user lookup errors into reassuring or zero summaries', () => {
    setup();
    for (const name of ['Cobrança da assinatura', 'Repasses', 'Recursos', 'Usuários']) {
      expect(within(screen.getByRole('button', { name: new RegExp(`^${name}`) })).getByText('Indisponível')).toBeVisible();
    }
    expect(screen.getByRole('status')).toHaveTextContent('Não foi possível conferir todas as pendências financeiras');
    expect(screen.queryByText('Nada pendente nesta empresa.')).not.toBeInTheDocument();
    expect(screen.queryByText('Todos ligados')).not.toBeInTheDocument();
    expect(screen.queryByText('0 pessoas')).not.toBeInTheDocument();
    expect(screen.queryByText('Sem vínculo')).not.toBeInTheDocument();
  });

  it('keeps a verified unconfigured billing link distinct from a lookup error', () => {
    state.billing = query({ isSuccess: true, data: { available: true, companies: [{ companyId: company.id, configured: false }] } });
    setup();
    expect(within(screen.getByRole('button', { name: /^Cobrança da assinatura/ })).getByText('Sem vínculo')).toBeVisible();
    expect(screen.getByText('Sem vínculo no Asaas')).toBeVisible();
  });

  it('scopes the access summary to this company and reports an unavailable access history', () => {
    state.users = query({ isSuccess: true, data: [{ id: 'support-user', full_name: 'Suporte teste', email: 'suporte@example.invalid', company_id: null, support_company_ids: ['company-a', 'company-b'] }] });
    setup();
    expect(state.lastAccess).toHaveBeenCalledWith(['support-user'], 'company-a');
    expect(within(screen.getByRole('button', { name: /^Usuários/ })).getByText('1 pessoa')).toBeVisible();
    expect(within(screen.getByRole('button', { name: /^Usuários/ })).getByText('Último acesso indisponível')).toBeVisible();
  });
});
