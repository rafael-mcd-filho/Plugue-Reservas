import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login from '@/pages/Login';

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false, signIn: vi.fn() },
  branding: {
    data: { system_name: 'Plug Guest', system_logo_url: 'https://example.test/logo.svg' },
    isLoading: false,
  },
  favicon: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/hooks/useSettings', () => ({ useSystemBranding: () => mocks.branding }));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: mocks.favicon }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const queryClients: QueryClient[] = [];

function Destination() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <div>
      <p data-testid="destination-path">{location.pathname}{location.search}{location.hash}</p>
      <p data-testid="destination-state">{JSON.stringify(location.state)}</p>
      <p data-testid="navigation-type">{navigationType}</p>
    </div>
  );
}

function renderLogin(redirectTo?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const makeView = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[{ pathname: '/login', state: { redirectTo } }]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(makeView());
  return { ...result, refresh: () => result.rerender(makeView()) };
}

function fillCredentials(email = 'USER@EXAMPLE.TEST', password = ' senha mantida ') {
  fireEvent.change(screen.getByLabelText(/^e-?mail$/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: password } });
}

function submitForm() {
  const form = screen.getByLabelText(/^senha$/i).closest('form');
  if (!form) throw new Error('Login must expose a credential form.');
  fireEvent.submit(form);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = null;
  mocks.auth.loading = false;
  mocks.auth.signIn.mockResolvedValue({ error: null });
  mocks.branding.data = { system_name: 'Plug Guest', system_logo_url: 'https://example.test/logo.svg' };
  mocks.branding.isLoading = false;
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((client) => client.clear());
});

describe('Login', () => {
  it('retains the configured logo and favicon', () => {
    mocks.branding.data = { system_name: 'Marca da plataforma', system_logo_url: 'https://example.test/custom-logo.svg' };
    renderLogin();

    expect(screen.getByRole('img', { name: 'Marca da plataforma' })).toHaveAttribute('src', mocks.branding.data.system_logo_url);
    expect(mocks.favicon).toHaveBeenCalledWith(mocks.branding.data.system_logo_url);
  });

  it('submits the normalized email and unchanged password without navigating before authentication completes', async () => {
    renderLogin('/empresas');
    fillCredentials();
    submitForm();

    await waitFor(() => expect(mocks.auth.signIn).toHaveBeenCalledWith('user@example.test', ' senha mantida '));
    expect(screen.queryByTestId('destination-path')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^e-?mail$/i)).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText(/^senha$/i)).toHaveAttribute('autocomplete', 'current-password');
  });

  it('reveals and hides the password without submitting credentials', () => {
    renderLogin();
    fillCredentials();
    const passwordInput = screen.getByLabelText(/^senha$/i);
    const reveal = screen.getByRole('button', { name: /mostrar senha/i });

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(reveal).toHaveAttribute('type', 'button');
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(reveal);

    expect(passwordInput).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: /ocultar senha/i });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(hide);

    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue(' senha mantida ');
    expect(mocks.auth.signIn).not.toHaveBeenCalled();
  });

  it('provides an accessible validation error before sending incomplete credentials', async () => {
    renderLogin();
    submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(/preencha|informe/i);
    expect(mocks.auth.signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^entrar$/i })).toBeEnabled();
  });

  it('does not send an invalid email to authentication', async () => {
    renderLogin();
    fillCredentials('email-invalido', 'password');
    submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(/e-?mail/i);
    expect(mocks.auth.signIn).not.toHaveBeenCalled();
  });

  it('blocks duplicate submissions while a login request is pending', async () => {
    let resolveLogin!: (result: { error: null }) => void;
    mocks.auth.signIn.mockImplementation(() => new Promise((resolve) => { resolveLogin = resolve; }));
    renderLogin();
    fillCredentials();
    submitForm();
    submitForm();

    expect(mocks.auth.signIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /entrando/i })).toBeDisabled();
    await act(async () => resolveLogin({ error: null }));
    expect(screen.getByRole('button', { name: /^entrar$/i })).toBeEnabled();
  });

  it('shows invalid credentials in Portuguese and permits another attempt', async () => {
    mocks.auth.signIn.mockResolvedValueOnce({ error: { message: 'Invalid login credentials' } });
    renderLogin();
    fillCredentials();
    submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(/e-?mail ou senha incorretos/i);
    expect(screen.getByRole('button', { name: /^entrar$/i })).toBeEnabled();
    submitForm();
    await waitFor(() => expect(mocks.auth.signIn).toHaveBeenCalledTimes(2));
  });

  it('recovers from a rejected request with an accessible error and an enabled submit button', async () => {
    mocks.auth.signIn.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderLogin();
    fillCredentials();
    submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível|tente novamente|erro/i);
    expect(screen.getByRole('button', { name: /^entrar$/i })).toBeEnabled();
    submitForm();
    await waitFor(() => expect(mocks.auth.signIn).toHaveBeenCalledTimes(2));
  });

  it('waits for authentication hydration and then replaces login with the requested path, query and hash', async () => {
    mocks.auth.user = { id: 'authenticated-user' };
    mocks.auth.loading = true;
    const { refresh } = renderLogin('/empresa/admin/reservas?data=2026-10-06#lista');
    expect(screen.queryByTestId('destination-path')).not.toBeInTheDocument();

    mocks.auth.loading = false;
    refresh();
    expect(await screen.findByTestId('destination-path')).toHaveTextContent('/empresa/admin/reservas?data=2026-10-06#lista');
    expect(screen.getByTestId('destination-state')).toHaveTextContent('{"fromLogin":true}');
    expect(screen.getByTestId('navigation-type')).toHaveTextContent('REPLACE');
  });

  it.each([
    undefined,
    'https://outside.example.test',
    '//outside.example.test',
    '/login',
    '/login?redirectTo=/empresas',
  ])('uses the application entry point for an unsafe or absent redirect: %s', async (redirectTo) => {
    mocks.auth.user = { id: 'authenticated-user' };
    renderLogin(redirectTo);
    expect(await screen.findByTestId('destination-path')).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId('destination-state')).toHaveTextContent('{"fromLogin":true}');
  });
});
