import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Users from '@/pages/Users';
import type { ManagedUser } from '@/hooks/useUsers';

const mocks = vi.hoisted(() => ({
  users: [] as ManagedUser[],
  companiesError: null as Error | null,
  companiesLoading: false,
  invokeManageUser: vi.fn(),
  updateUser: vi.fn(),
  refetchUsers: vi.fn(),
  refetchCompanies: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'superadmin' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useManageUserInvoker', () => ({
  useManageUserInvoker: () => ({ invokeManageUser: mocks.invokeManageUser }),
}));

vi.mock('@/hooks/useCompanies', () => ({
  useCompanies: () => ({
    data: [{ id: 'company-a', name: 'Empresa Á' }, { id: 'company-b', name: 'Empresa B' }],
    error: mocks.companiesError,
    isLoading: mocks.companiesLoading,
    isFetching: false,
    refetch: mocks.refetchCompanies,
  }),
}));

vi.mock('@/hooks/useUsers', () => ({
  useUsers: () => ({ data: mocks.users, isLoading: false, error: null, refetch: mocks.refetchUsers, isFetching: false }),
  useToggleBan: () => ({ mutate: vi.fn() }),
  useUpdateUser: () => ({ mutateAsync: mocks.updateUser, isPending: false }),
  useSetUserPassword: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteUser: () => ({ mutate: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/components/users/UserPasswordDialog', () => ({ default: () => null }));

// Native selects keep these integration tests focused on the access form and payloads.
vi.mock('@/components/ui/select', async () => {
  const { Children } = await import('react');
  return {
    Select: ({ children, value, onValueChange, disabled }: {
      children: ReactNode; value: string; onValueChange: (value: string) => void; disabled?: boolean;
    }) => {
      const trigger = Children.toArray(children).find((child) => (child as ReactElement).props?.['aria-label']) as ReactElement;
      return (
        <select aria-label={trigger?.props['aria-label']} value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
          {children}
        </select>
      );
    },
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ children, value, disabled }: { children: ReactNode; value: string; disabled?: boolean }) => (
      <option value={value} disabled={disabled}>{children}</option>
    ),
  };
});

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: () => null,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => null,
}));

const supportUser: ManagedUser = {
  id: 'support-user',
  full_name: 'João Suporte',
  email: 'joao@example.com',
  phone: '',
  company_id: null,
  roles: ['support'],
  support_company_ids: ['company-a'],
  is_banned: false,
  last_sign_in: null,
  created_at: '2026-10-06',
};

function renderUsers() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><Users /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillCreateForm() {
  fireEvent.change(screen.getByLabelText('Nome completo *'), { target: { value: 'Maria Suporte' } });
  fireEvent.change(screen.getByLabelText('E-mail *'), { target: { value: 'maria@example.com' } });
  fireEvent.change(screen.getByLabelText('Senha inicial *'), { target: { value: 'SenhaForte123!' } });
  fireEvent.change(screen.getByLabelText('Confirmar senha *'), { target: { value: 'SenhaForte123!' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  mocks.users = [];
  mocks.companiesError = null;
  mocks.companiesLoading = false;
  mocks.invokeManageUser.mockResolvedValue({ results: [{}] });
  mocks.updateUser.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Suporte na gestão de usuários', () => {
  it('starts with no grants and submits only selected companies, without a tenant membership', async () => {
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Novo Usuário' }));
    fireEvent.change(screen.getByLabelText('Perfil do novo usuario'), { target: { value: 'support' } });
    expect(screen.queryByLabelText('Empresa do novo usuario')).not.toBeInTheDocument();
    expect(screen.getByText('0 selecionadas')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Empresa Á' })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Empresa Á' }));
    fireEvent.change(screen.getByLabelText('Buscar empresas autorizadas'), { target: { value: 'empresa b' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Empresa B' }));
    fireEvent.change(screen.getByLabelText('Buscar empresas autorizadas'), { target: { value: 'empresa a' } });
    expect(screen.getByRole('checkbox', { name: 'Empresa Á' })).toBeChecked();
    expect(screen.getByText('2 selecionadas')).toBeInTheDocument();

    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Criar Usuário' }));
    await waitFor(() => expect(mocks.invokeManageUser).toHaveBeenCalledWith({
      action: 'seed_users',
      users: [expect.objectContaining({ role: 'support', company_id: null, support_company_ids: ['company-a', 'company-b'] })],
    }));
  });

  it('allows creating support with an explicit empty company list', async () => {
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Novo Usuário' }));
    fireEvent.change(screen.getByLabelText('Perfil do novo usuario'), { target: { value: 'support' } });
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Criar Usuário' }));
    await waitFor(() => expect(mocks.invokeManageUser).toHaveBeenCalledWith({
      action: 'seed_users',
      users: [expect.objectContaining({ role: 'support', company_id: null, support_company_ids: [] })],
    }));
  });

  it('omits grants when the selected profile is changed back to a company role', async () => {
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Novo Usuário' }));
    fireEvent.change(screen.getByLabelText('Perfil do novo usuario'), { target: { value: 'support' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Empresa B' }));
    fireEvent.change(screen.getByLabelText('Perfil do novo usuario'), { target: { value: 'operator' } });
    expect(screen.queryByText('Empresas autorizadas')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Empresa do novo usuario'), { target: { value: 'company-a' } });
    fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Criar Usuário' }));
    await waitFor(() => expect(mocks.invokeManageUser).toHaveBeenCalled());
    const payload = mocks.invokeManageUser.mock.calls[0][0].users[0];
    expect(payload.role).toBe('operator');
    expect(payload.company_id).toBe('company-a');
    expect(payload).not.toHaveProperty('support_company_ids');
  });

  it('filters support users by authorized company and preserves existing grants on edit', async () => {
    mocks.users = [supportUser];
    renderUsers();
    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: 'company-b' } });
    expect(screen.queryByText('João Suporte')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filtrar por empresa'), { target: { value: 'company-a' } });
    expect(screen.getByText('João Suporte')).toBeInTheDocument();
    expect(screen.getByText('1 empresa autorizada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByRole('checkbox', { name: 'Empresa Á' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Empresa B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      user_id: supportUser.id,
      company_id: null,
      role: 'support',
      support_company_ids: ['company-a', 'company-b'],
    })));
  });

  it('blocks editing when support grants were not returned instead of saving an empty list', () => {
    const { support_company_ids: _, ...userWithoutGrants } = supportUser;
    mocks.users = [userWithoutGrants];
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as autorizações');
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Perfil do usuario'), { target: { value: 'operator' } });
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('blocks creating support while the company catalog could not be loaded', () => {
    mocks.companiesError = new Error('Sem conexão');
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Novo Usuário' }));
    fireEvent.change(screen.getByLabelText('Perfil do novo usuario'), { target: { value: 'support' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar as empresas');
    expect(screen.getByRole('button', { name: 'Criar Usuário' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(mocks.refetchCompanies).toHaveBeenCalledOnce();
  });

  it('recovers missing grants before editing and submits an explicit empty list to revoke the last company', async () => {
    const { support_company_ids: _, ...userWithoutGrants } = supportUser;
    mocks.users = [userWithoutGrants];
    mocks.refetchUsers.mockResolvedValue({ data: [supportUser] });
    renderUsers();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Empresa Á' })).toBeChecked());
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Empresa Á' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({
      user_id: supportUser.id,
      role: 'support',
      company_id: null,
      support_company_ids: [],
    })));
  });
});
