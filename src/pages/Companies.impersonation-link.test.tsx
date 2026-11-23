import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Companies from './Companies';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn() }));
const company = { id: 'company-a', name: 'Empresa teste', slug: 'empresa-teste', status: 'active', cnpj: null, created_at: '2026-11-23T12:00:00Z' };
vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({ data: [company], isLoading: false }),
  useUpdateCompany: () => ({ isPending: false, mutate: vi.fn() }),
  useRequestCompanyDeletion: () => ({ isPending: false, mutate: vi.fn() }),
  useCancelCompanyDeletion: () => ({ isPending: false, mutate: vi.fn() }),
  useCompanyDeletionRequests: () => ({ data: [] }),
  COMPANY_DELETION_REQUEST_STATUS_LABEL: {},
}));
vi.mock('@/hooks/useCompanyFeatures', () => ({ useCompaniesFeatureMatrix: () => ({ data: {} }) }));
vi.mock('@/hooks/useManageUserInvoker', () => ({ useManageUserInvoker: () => ({ invokeManageUser: mocks.invoke, manageUserScopeKey: 'global-test' }) }));
vi.mock('@/hooks/useImpersonation', () => ({ startImpersonationSession: mocks.start }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'global-admin' }, loading: false }) }));
vi.mock('@/components/company/CompanyDialog', () => ({ default: () => null }));
vi.mock('@/components/company/CompanyDeletionRecoveryActions', () => ({ CompanyDeletionRecoveryActions: () => null }));
vi.mock('@/components/company/CompanyFeatureSwitchList', () => ({ CompanyFeatureSummary: () => null }));

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function setup(query = 'impersonar=company-a&destino=configuracoes') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/empresas?${query}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Location/><Routes>
    <Route path="/empresas" element={<Companies/>}/><Route path="/:slug/admin/*" element={<p>Painel autorizado</p>}/>
  </Routes></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue({ users: [
    { id: 'admin-user', full_name: 'Admin da empresa', email: 'admin@example.invalid', roles: ['admin'], is_banned: false },
    { id: 'operator-user', full_name: 'Operador da empresa', email: 'operador@example.invalid', roles: ['operator'], is_banned: false },
    { id: 'blocked-user', full_name: 'Pessoa bloqueada', email: 'bloqueada@example.invalid', roles: ['admin'], is_banned: true },
  ] });
});

describe('company settings through existing impersonation', () => {
  it('consumes the request once and requires choosing an active company user before opening settings', async () => {
    setup('impersonar=company-a&destino=configuracoes&outro=preservado');
    expect(await screen.findByRole('dialog', { name: 'Escolher impersonação' })).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/empresas?outro=preservado'));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(screen.queryByText('Pessoa bloqueada')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Admin da empresa/ }));
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'global-admin', companyId: 'company-a', userId: 'admin-user', effectiveRole: 'admin', status: 'pending' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/empresa-teste/admin/configuracoes/empresa'));
  });

  it('keeps an operator on the normal authorized entry instead of sending them to company settings', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /Operador da empresa/ }));
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ effectiveRole: 'operator', userId: 'operator-user' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/empresa-teste/admin'));
    expect(screen.getByTestId('location')).not.toHaveTextContent('configuracoes');
  });

  it('ignores an arbitrary destination and cannot redirect outside the authorized company entry', async () => {
    setup('impersonar=company-a&destino=https%3A%2F%2Foutside.invalid');
    fireEvent.click(await screen.findByRole('button', { name: /Admin da empresa/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/empresa-teste/admin'));
    expect(screen.getByTestId('location')).not.toHaveTextContent('outside');
  });

  it('does not open or authorize an unknown company', async () => {
    setup('impersonar=unknown-company&destino=configuracoes');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/empresas'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
