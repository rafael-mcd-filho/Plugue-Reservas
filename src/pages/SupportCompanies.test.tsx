import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import SupportCompanies from '@/pages/SupportCompanies';
import { getImpersonationSession } from '@/lib/impersonationSession';

const mocks = vi.hoisted(() => ({
  actor: { id: '00000000-0000-4000-8000-000000000001' },
  roles: ['support'],
  rpc: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.actor, roles: mocks.roles, loading: false }),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const companies = [{ id: 'company-one', name: 'Empresa A', slug: 'empresa-a', status: 'active' }];
const candidates = [{ user_id: 'target-one', full_name: 'Usuário da empresa', email: 'target@example.test', effective_role: 'admin' }];
const queryClients: QueryClient[] = [];

function validContext() {
  return {
    id: '00000000-0000-4000-8000-000000000009',
    actorUserId: mocks.actor.id,
    companyId: companies[0].id,
    companySlug: companies[0].slug,
    companyName: companies[0].name,
    userId: candidates[0].user_id,
    userName: candidates[0].full_name,
    userEmail: candidates[0].email,
    effectiveRole: 'operator',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
}

function mockRpc(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (overrides[name]) return overrides[name];
    if (name === 'support_list_companies') return { data: companies, error: null };
    if (name === 'support_list_impersonation_candidates') return { data: candidates, error: null };
    if (name === 'start_support_impersonation') return { data: validContext(), error: null };
    throw new Error('Unexpected RPC: ' + name);
  });
}

function renderCompanies() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/empresas']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/empresas" element={<SupportCompanies />} />
          <Route path="/:slug/admin/*" element={<p>Painel da empresa</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openCandidateDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Acessar como usuário' }));
  return screen.findByRole('button', { name: 'Acessar' });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockRpc();
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  sessionStorage.clear();
});

describe('companies authorized for support', () => {
  it('lists only the scoped RPC result with impersonation as the sole company action', async () => {
    renderCompanies();
    expect(await screen.findByText('Empresa A')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('support_list_companies');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Acessar como usuário' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /criar|nova empresa|excluir|editar|pausar/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Pesquisar empresas'), { target: { value: 'outra empresa' } });
    expect(screen.getByText('Nenhuma empresa encontrada')).toBeInTheDocument();
    expect(screen.queryByText('Empresa A')).not.toBeInTheDocument();
  });

  it('starts through the server using only the company and target ids and stores the validated role', async () => {
    renderCompanies();
    fireEvent.click(await openCandidateDialog());
    expect(await screen.findByText('Painel da empresa')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('support_list_impersonation_candidates', { _company_id: 'company-one' });
    expect(mocks.rpc).toHaveBeenCalledWith('start_support_impersonation', {
      _company_id: 'company-one', _target_user_id: 'target-one',
    });
    expect(getImpersonationSession()).toMatchObject({
      actorUserId: mocks.actor.id,
      companyId: 'company-one',
      userId: 'target-one',
      effectiveRole: 'operator',
      supportSessionId: validContext().id,
      status: 'pending',
    });
  });

  it.each([
    ['a different target', { userId: 'other-user' }],
    ['a different company slug', { companySlug: 'empresa-b' }],
    ['a global role', { effectiveRole: 'superadmin' }],
  ])('rejects a start response for %s before saving or navigating', async (_, alteration) => {
    mockRpc({ start_support_impersonation: { data: { ...validContext(), ...alteration }, error: null } });
    renderCompanies();
    fireEvent.click(await openCandidateDialog());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Não foi possível validar o acesso à empresa.'));
    expect(getImpersonationSession()).toBeNull();
    expect(screen.queryByText('Painel da empresa')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps support outside the tenant when access was revoked between selection and starting', async () => {
    mockRpc({ start_support_impersonation: { data: null, error: new Error('Empresa não autorizada') } });
    renderCompanies();
    fireEvent.click(await openCandidateDialog());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Empresa não autorizada'));
    expect(getImpersonationSession()).toBeNull();
    expect(screen.getByRole('button', { name: 'Acessar' })).toBeEnabled();
    expect(screen.queryByText('Painel da empresa')).not.toBeInTheDocument();
  });
});
