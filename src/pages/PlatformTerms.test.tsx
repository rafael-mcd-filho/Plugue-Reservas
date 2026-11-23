import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import App from '@/App';
import PublicApp from '@/PublicApp';
import PlatformTerms from '@/pages/PlatformTerms';

const mocks = vi.hoisted(() => ({ renderCompany: vi.fn() }));

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('@/contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ user: null, profile: null, roles: [], loading: false }),
}));
vi.mock('@/contexts/CompanySlugContext', () => ({
  CompanySlugProvider: ({ children }: { children: ReactNode }) => {
    mocks.renderCompany();
    return children;
  },
}));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ProtectedRoute', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/company/CompanyFeatureRouteGate', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/company/CompanyPanelEntryRoute', () => ({ default: () => <h1>Painel da unidade</h1> }));
vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({ hasPermission: () => true, permissionsLoading: false }),
}));
vi.mock('@/pages/CompanyPublicPage', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Página da unidade</h1>;
} }));
vi.mock('@/pages/PublicWaitlistPage', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Fila da unidade</h1>;
} }));
vi.mock('@/pages/WaitlistTracking', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Acompanhamento da fila</h1>;
} }));
vi.mock('@/pages/ReservationTracking', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Acompanhamento da reserva</h1>;
} }));
vi.mock('@/pages/ReservationReview', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Avaliação da reserva</h1>;
} }));
vi.mock('@/pages/AffiliateCompanyPublicPage', () => ({ default: () => {
  mocks.renderCompany();
  return <h1>Indicação do parceiro</h1>;
} }));

beforeEach(() => {
  mocks.renderCompany.mockClear();
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    if (String(input).endsWith('/rest/v1/rpc/get_public_system_branding')) {
      return Promise.resolve(new Response(JSON.stringify([{ system_name: 'Plug Guest', system_logo_url: '' }]), { headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.reject(new Error('Os termos não devem consultar dados de uma unidade.'));
  }));
});

function expectOnlyPlatformBrandingRequests() {
  // Both app shells load the platform favicon for every route; terms stay static
  // and must never fetch company/reservation/customer data.
  for (const [url] of vi.mocked(fetch).mock.calls) {
    expect(String(url)).toMatch(/\/rest\/v1\/rpc\/get_public_system_branding$/);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('PlatformTerms', () => {
  it('exibe termos públicos versionados, condições de pagamento e contato sem consultar a rede', () => {
    render(<MemoryRouter><PlatformTerms /></MemoryRouter>);

    expect(screen.getByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeVisible();
    expect(screen.getByText('Versão 1.0 · Elaborada em 20/11/2026')).toBeVisible();
    const summary = screen.getByRole('region', { name: 'Resumo dos termos' });
    expect(within(summary).getByText(/sinal é abatido integralmente/)).toBeVisible();
    expect(within(summary).getByText(/Não há perda automática do sinal/)).toBeVisible();
    expect(screen.getByRole('link', { name: /contato@/ })).toHaveAttribute('href', expect.stringMatching(/^mailto:/));
    expect(screen.getByRole('link', { name: 'Plug Guest' })).toHaveAttribute('href', '/');
    expect(document.title).toBe('Termos de Uso | Plug Guest');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('oferece cópia íntegra para conservar os termos e a versão consultada', () => {
    render(<MemoryRouter><PlatformTerms /></MemoryRouter>);
    const copy = screen.getByRole('link', { name: 'Salvar cópia' });
    expect(copy).toHaveAttribute('download', 'termos-de-uso-plug-guest-1.0.txt');
    const href = copy.getAttribute('href') ?? '';
    expect(href).toMatch(/^data:text\/plain;charset=utf-8,/);
    const content = decodeURIComponent(href.slice(href.indexOf(',') + 1));
    expect(content).toContain('Termos de Uso da Plug Guest');
    expect(content).toContain('Versão 1.0 · Elaborada em 20/11/2026');
    expect(content).toMatch(/Cancelamento, remarcação e reembolso/);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe.each([
    ['pública', PublicApp],
    ['principal', App],
  ] as const)('shell %s', (_name, Shell) => {
    it.each(['/termos-de-uso', '/termos-de-uso/'])('abre a rota estática %s sem montar uma unidade', async pathname => {
      window.history.replaceState({}, '', pathname);
      render(<Shell />);
      expect(await screen.findByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeVisible();
      expect(mocks.renderCompany).not.toHaveBeenCalled();
      expectOnlyPlatformBrandingRequests();
    });

    it.each([
      '/termos-de-uso/fila',
      '/termos-de-uso/fila/ABC123',
      '/termos-de-uso/f/parceiro',
      '/termos-de-uso/reserva/ABC123',
      '/termos-de-uso/avaliacao/token',
      '/termos-de-uso/admin',
    ])('não monta uma unidade pela rota reservada %s', async pathname => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      window.history.replaceState({}, '', pathname);
      render(<Shell />);
      expect(await screen.findByRole('heading', { name: '404' })).toBeVisible();
      expect(mocks.renderCompany).not.toHaveBeenCalled();
      expectOnlyPlatformBrandingRequests();
    });
  });
});
