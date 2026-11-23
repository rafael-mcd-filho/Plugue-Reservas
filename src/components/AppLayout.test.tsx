import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from '@/components/AppLayout';
import type { AppRole, CompanyPanelPermission } from '@/lib/companyPermissions';

const mocks = vi.hoisted(() => ({
  roles: ['admin'] as AppRole[],
  permissions: null as Set<CompanyPanelPermission> | null,
  features: {
    advanced_reports: true,
    reservation_prepayment: true,
    whatsapp_integration: true,
    nps_surveys: true,
  } as Record<string, boolean>,
  company: { companyId: 'company-1', companyName: 'Casa de teste', slug: 'casa' } as {
    companyId: string;
    companyName: string;
    slug: string;
  } | null,
  billingModuleEnabled: true,
  billing: {
    companyBillingEnabled: true,
    overdueCount: 0,
    overdueTotal: 0,
    oldestOverdueDays: 0,
    showOverduePopup: false,
  },
  showOverdueWarning: false,
  auditMetadata: {},
  trackAccessAudit: vi.fn(async () => undefined),
  pendingWithdrawals: 0,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    profile: { full_name: 'Pessoa de teste', email: 'person@example.test' },
    roles: mocks.roles,
    loading: false,
    signOut: vi.fn(),
  }),
}));
vi.mock('@/contexts/CompanySlugContext', () => ({ useMaybeCompanySlug: () => mocks.company }));
vi.mock('@/hooks/useCompanyPermissions', () => ({
  useCompanyPermissions: () => ({
    activeRoles: mocks.roles,
    hasPermission: (permission: CompanyPanelPermission) => mocks.permissions === null || mocks.permissions.has(permission),
    permissionsLoading: false,
  }),
}));
vi.mock('@/hooks/useImpersonation', () => ({
  useImpersonation: () => ({
    isImpersonatingCompany: false,
    effectiveRole: mocks.roles[0],
    effectiveRoles: mocks.roles,
    auditMetadata: mocks.auditMetadata,
    stopImpersonation: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSettings', () => ({
  useSystemBranding: () => ({ data: { system_name: 'Plug Guest' }, isLoading: false }),
}));
vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatureFlags: () => ({ data: { features: mocks.features }, isLoading: false }),
}));
vi.mock('@/hooks/usePlatformBilling', () => ({
  usePlatformBillingModuleStatus: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? { enabled: mocks.billingModuleEnabled } : undefined,
  }),
  useCompanyBillingSummary: (_companyId: string | undefined, { enabled }: { enabled: boolean }) => ({
    data: enabled ? mocks.billing : undefined,
  }),
  useCompanyBillingOverdueWarning: (_companyId: string | undefined, { enabled }: { enabled: boolean }) => ({
    data: enabled ? { showOverdueWarning: mocks.showOverdueWarning } : undefined,
  }),
}));
vi.mock('@/lib/publicCompanyIcons', () => ({ useFaviconOverride: vi.fn() }));
vi.mock('@/hooks/useAdminSettlements', () => ({
  usePendingWithdrawalCount: ({ enabled }: { enabled: boolean }) => ({ data: enabled ? mocks.pendingWithdrawals : undefined }),
}));
vi.mock('@/lib/accessAudit', () => ({
  trackAccessAudit: mocks.trackAccessAudit,
  reportAccessAuditFailure: vi.fn(),
}));
vi.mock('@/components/WhatsAppStatusAlert', () => ({ default: () => null }));
vi.mock('@/components/CompanyNotificationsPopover', () => ({ default: () => null }));
vi.mock('@/components/CompanyGlobalSearch', () => ({
  default: ({ companyId, companyName, slug }: { companyId: string; companyName: string; slug: string }) => (
    <button type="button" aria-label="Buscar clientes e reservas" data-company-id={companyId} data-slug={slug}>{companyName}</button>
  ),
}));
vi.mock('@/components/NotificationBanner', () => ({ default: () => null }));
vi.mock('@/components/billing/OverdueBillingDialog', () => ({
  default: ({ open, onViewInvoices }: { open: boolean; onViewInvoices: () => void }) => open ? (
    <div role="dialog" aria-label="Pagamento em atraso">
      <button type="button" onClick={onViewInvoices}>Abrir faturas da assinatura</button>
    </div>
  ) : null,
}));

function PageProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output aria-label="Rota atual">{location.pathname}</output>
    <button type="button" onClick={() => navigate('/casa/admin/configuracoes/pagina-publica')}>Ir à configuração pública</button>
    <button type="button" onClick={() => navigate('/casa/admin/eventos')}>Ir ao rastreamento</button>
    <button type="button" onClick={() => navigate('/casa/admin/servico?tab=fila')}>Ir à fila nos serviços</button>
  </>;
}

function renderLayout(path = '/casa/admin') {
  render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/:slug/admin/*" element={<AppLayout><PageProbe /></AppLayout>} />
        <Route path="/*" element={<AppLayout><PageProbe /></AppLayout>} />
      </Routes>
    </MemoryRouter>,
  );
  return within(screen.getByRole('navigation'));
}

function expectLink(nav: ReturnType<typeof within>, label: string, path: string) {
  expect(nav.getByRole('link', { name: label })).toHaveAttribute('href', path);
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    key: index => [...values.keys()][index] ?? null,
  };
}

describe('AppLayout: navegação administrativa da unidade', () => {
  it('closes the mobile navigation when the service tab changes without changing the pathname', () => {
    renderLayout('/casa/admin/servico?tab=chegadas');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir menu de navegação' }));
    expect(screen.getByRole('navigation').closest('aside')).toHaveClass('translate-x-0');
    fireEvent.click(screen.getByRole('button', { name: 'Ir à fila nos serviços' }));
    expect(screen.getByRole('navigation').closest('aside')).toHaveClass('-translate-x-full');
  });
  it('consolidates the queue into the released service area and preserves the existing check-in shortcut', () => {
    mocks.roles = ['operator'];
    const nav = renderLayout('/casa/admin/servico');
    expectLink(nav, 'Check-ins', '/casa/admin/check-ins');
    expect(nav.queryByRole('link', { name: 'Lista de Espera' })).not.toBeInTheDocument();
    expect(nav.getByRole('link', { name: /Serviços de Hoje/ })).toHaveAttribute('href', '/casa/admin/servico');
    expect(nav.getByRole('link', { name: /Serviços de Hoje/ })).toHaveAttribute('aria-current', 'page');
    expect(nav.queryByText('Em teste')).not.toBeInTheDocument();
  });
  it('allows the administrator and a queue-only operator into the service area', () => {
    const nav = renderLayout();
    expect(nav.getByRole('link', { name: /Serviços de Hoje/ })).toBeInTheDocument();
    cleanup(); mocks.roles = ['operator']; mocks.permissions = new Set(['waitlist_view']);
    const queueNav = renderLayout();
    expect(queueNav.getByRole('link', { name: /Serviços de Hoje/ })).toBeInTheDocument();
    expect(queueNav.queryByRole('link', { name: 'Check-ins' })).not.toBeInTheDocument();
  });
  it('does not offer the service area when no whole operational permission set is authorized', () => {
    mocks.roles = ['operator']; mocks.permissions = new Set(['tables_view']);
    const nav = renderLayout();
    expect(nav.queryByRole('link', { name: /Serviços de Hoje/ })).not.toBeInTheDocument();
  });
  it('offers the consolidated service area in production even with an obsolete disabled pilot value', () => {
    vi.stubEnv('DEV', false); vi.stubEnv('VITE_SERVICE_TODAY_ENABLED', 'false');
    try {
      const nav = renderLayout();
      expect(nav.queryByRole('link', { name: 'Lista de Espera' })).not.toBeInTheDocument();
      expectLink(nav, 'Serviços de Hoje', '/casa/admin/servico');
      expect(nav.queryByText('Em teste')).not.toBeInTheDocument();
    } finally { vi.unstubAllEnvs(); }
  });
  beforeEach(() => {
    mocks.roles = ['admin'];
    mocks.permissions = null;
    mocks.features = {
      advanced_reports: true,
      reservation_prepayment: true,
      whatsapp_integration: true,
      nps_surveys: true,
    };
    mocks.company = { companyId: 'company-1', companyName: 'Casa de teste', slug: 'casa' };
    mocks.billingModuleEnabled = true;
    mocks.billing = {
      companyBillingEnabled: true,
      overdueCount: 0,
      overdueTotal: 0,
      oldestOverdueDays: 0,
      showOverduePopup: false,
    };
    mocks.showOverdueWarning = false;
    mocks.trackAccessAudit.mockClear();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() });
  });

  afterEach(cleanup);

  it('oferece a busca no cabeçalho com o contexto da unidade e a omite no painel global', () => {
    renderLayout();
    const search = within(screen.getByRole('banner')).getByRole('button', { name: 'Buscar clientes e reservas' });
    expect(search).toHaveAttribute('data-company-id', 'company-1');
    expect(search).toHaveAttribute('data-slug', 'casa');
    expect(search).toHaveTextContent('Casa de teste');
    cleanup();
    mocks.roles = ['superadmin'];
    mocks.company = null;
    renderLayout('/dashboard');
    expect(screen.queryByRole('button', { name: 'Buscar clientes e reservas' })).not.toBeInTheDocument();
  });

  it('dá acesso direto a Clientes e Pagamentos e mantém Minha assinatura fora dos grupos e ao final', () => {
    const nav = renderLayout();
    expectLink(nav, 'Clientes', '/casa/admin/leads');
    expectLink(nav, 'Pagamentos', '/casa/admin/pagamentos-antecipados');
    expectLink(nav, 'Parceiros', '/casa/admin/filiados');
    const subscription = nav.getByRole('link', { name: 'Minha assinatura' });
    expect(subscription).toHaveAttribute('href', '/casa/admin/financeiro');
    expect(subscription.closest('[data-state]')).toBeNull();
    expect(nav.getAllByRole('link').at(-1)).toBe(subscription);
    expect(nav.queryByRole('button', { name: /gestão|configurações|automações/i })).not.toBeInTheDocument();
    expect(nav.getByRole('button', { name: 'Expandir empresa' })).toHaveAttribute('aria-expanded', 'false');
    expect(nav.queryByLabelText(/fatura vencida/)).not.toBeInTheDocument();
  });

  it('agrupa comunicação, operação e empresa com nomes curtos e destinos anteriores', () => {
    const nav = renderLayout();
    fireEvent.click(nav.getByRole('button', { name: 'Expandir comunicação' }));
    expectLink(nav, 'Mensagens', '/casa/admin/automacoes');
    expectLink(nav, 'Avaliações', '/casa/admin/avaliacoes');

    fireEvent.click(nav.getByRole('button', { name: 'Expandir operação' }));
    for (const [label, path] of [
      ['Horários', 'configuracoes/agenda'],
      ['Regras', 'configuracoes/reservas'],
      ['Disponibilidade', 'configuracoes/disponibilidade'],
      ['Mesas', 'mesas'],
      ['Página pública', 'configuracoes/pagina-publica'],
    ]) expectLink(nav, label, `/casa/admin/${path}`);

    fireEvent.click(nav.getByRole('button', { name: 'Expandir empresa' }));
    expectLink(nav, 'Cadastro', '/casa/admin/configuracoes/empresa');
    expectLink(nav, 'Equipe', '/casa/admin/usuarios');
    expectLink(nav, 'Rastreamento', '/casa/admin/eventos');
    expect(nav.queryByRole('link', { name: 'Leads' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Eventos' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Financeiro' })).not.toBeInTheDocument();
  });

  it('abre o grupo da rota atual e abre o grupo correspondente após trocar de página', () => {
    const nav = renderLayout('/casa/admin/avaliacoes');
    expect(nav.getByRole('button', { name: 'Recolher comunicação' })).toHaveAttribute('aria-expanded', 'true');
    expect(nav.getByRole('link', { name: 'Avaliações' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Ir à configuração pública' }));
    expect(nav.getByRole('button', { name: 'Recolher operação' })).toHaveAttribute('aria-expanded', 'true');
    expect(nav.getByRole('link', { name: 'Página pública' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('button', { name: 'Expandir empresa' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Ir ao rastreamento' }));
    expect(nav.getByRole('button', { name: 'Recolher empresa' })).toHaveAttribute('aria-expanded', 'true');
    expect(nav.getByRole('link', { name: 'Rastreamento' })).toHaveAttribute('aria-current', 'page');
  });

  it('mantém o aviso vermelho da assinatura ativo mesmo com Empresa recolhida e com o link selecionado', () => {
    mocks.billing = {
      companyBillingEnabled: true,
      overdueCount: 2,
      overdueTotal: 300,
      oldestOverdueDays: 5,
      showOverduePopup: true,
    };
    mocks.showOverdueWarning = true;
    const nav = renderLayout('/casa/admin/financeiro');
    const subscription = nav.getByRole('link', { name: /Minha assinatura/ });
    expect(subscription).toHaveAttribute('aria-current', 'page');
    const overdue = within(subscription).getByLabelText('2 faturas vencidas');
    expect(overdue).toHaveClass('bg-destructive');
    expect(nav.getByRole('button', { name: 'Expandir empresa' })).toHaveAttribute('aria-expanded', 'false');
    // Um aviso por vez: com o popup da fatura aberto, a faixa do topo espera.
    expect(screen.getByRole('dialog', { name: 'Pagamento em atraso' })).toBeInTheDocument();
    expect(screen.queryByText(/Há faturas vencidas há 3 dias ou mais/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir menu de navegação' }));
    expect(within(nav.getByRole('link', { name: /Minha assinatura/ })).getByLabelText('2 faturas vencidas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir faturas da assinatura' }));
    expect(screen.getByLabelText('Rota atual')).toHaveTextContent('/casa/admin/financeiro');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Há faturas vencidas há 3 dias ou mais/)).toBeInTheDocument();
  });

  it('oculta recursos desabilitados e grupos sem itens sem ampliar permissões', () => {
    mocks.roles = ['operator'];
    mocks.permissions = new Set<CompanyPanelPermission>(['leads_view', 'tables_view']);
    mocks.features.whatsapp_integration = false;
    mocks.features.nps_surveys = false;
    const nav = renderLayout();
    expectLink(nav, 'Clientes', '/casa/admin/leads');
    expect(nav.queryByRole('link', { name: 'Pagamentos' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: /Minha assinatura/ })).not.toBeInTheDocument();
    expect(nav.queryByRole('button', { name: /comunicação|empresa/i })).not.toBeInTheDocument();
    expect(nav.queryByRole('button', { name: 'Expandir operação' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Mesas' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Horários' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: 'Página pública' })).not.toBeInTheDocument();
  });

  it('preserva o aviso geral para operador sem expor faturas ou popup financeiro', () => {
    mocks.roles = ['operator'];
    mocks.billing.overdueCount = 1;
    mocks.billing.showOverduePopup = true;
    mocks.showOverdueWarning = true;
    const nav = renderLayout();
    expect(nav.queryByRole('link', { name: /Minha assinatura/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Há faturas vencidas há 3 dias ou mais/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ver faturas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectLink(nav, 'Check-ins', '/casa/admin/check-ins');
  });

  it('respeita feature flags da comunicação e do pagamento com permissões completas', () => {
    mocks.features.reservation_prepayment = false;
    mocks.features.whatsapp_integration = false;
    mocks.features.nps_surveys = false;
    mocks.billingModuleEnabled = false;
    const nav = renderLayout();
    expectLink(nav, 'Clientes', '/casa/admin/leads');
    expect(nav.queryByRole('link', { name: 'Pagamentos' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: /Minha assinatura/ })).not.toBeInTheDocument();
    expect(nav.queryByRole('button', { name: /comunicação/i })).not.toBeInTheDocument();
    fireEvent.click(nav.getByRole('button', { name: 'Expandir empresa' }));
    expectLink(nav, 'Rastreamento', '/casa/admin/eventos');
  });

  it('mantém Principal, Reservas e Relatórios com suas rotas e rótulos anteriores', () => {
    const nav = renderLayout();
    expectLink(nav, 'Dashboard', '/casa/admin');
    expectLink(nav, 'Serviços de Hoje', '/casa/admin/servico');
    fireEvent.click(nav.getByRole('button', { name: 'Expandir reservas' }));
    expectLink(nav, 'Visão geral', '/casa/admin/reservas');
    expectLink(nav, 'Lista', '/casa/admin/reservas/lista');
    expectLink(nav, 'Calendário', '/casa/admin/reservas/calendario');
    fireEvent.click(nav.getByRole('button', { name: 'Expandir relatórios' }));
    expectLink(nav, 'Demanda', '/casa/admin/relatorios/demanda-conversao');
    expectLink(nav, 'Perdas', '/casa/admin/relatorios/comparecimento-perdas');
    expectLink(nav, 'Capacidade', '/casa/admin/relatorios/ocupacao-capacidade');
    expectLink(nav, 'Recorrência', '/casa/admin/relatorios/recorrencia');
  });

  it('preserva Financeiro e Usuários globais no painel do superadmin', () => {
    mocks.roles = ['superadmin'];
    mocks.company = null;
    const nav = renderLayout('/financeiro');
    expectLink(nav, 'Financeiro', '/financeiro');
    expect(nav.getByRole('link', { name: 'Financeiro' })).toHaveAttribute('aria-current', 'page');
    expectLink(nav, 'Usuários', '/usuarios');
    expectLink(nav, 'Empresas', '/empresas');
    expectLink(nav, 'Avisos', '/notificacoes');
    expectLink(nav, 'Auditoria', '/logs');
    expectLink(nav, 'Configurações', '/configuracoes');
    expect(nav.queryByRole('link', { name: 'Repasses' })).not.toBeInTheDocument();
    expect(nav.queryByRole('link', { name: /Integrações/ })).not.toBeInTheDocument();
    expect(nav.getByText('Principal')).toBeInTheDocument();
    expect(nav.getByText('Gestão')).toBeInTheDocument();
    expect(nav.getByText('Plataforma')).toBeInTheDocument();
    expect(nav.queryByRole('link', { name: /Minha assinatura|Clientes|Parceiros/ })).not.toBeInTheDocument();
    expect(nav.queryByRole('button', { name: /operação|empresa|comunicação/i })).not.toBeInTheDocument();
  });

  it('mostra no Financeiro do superadmin quantos saques aguardam análise', () => {
    mocks.roles = ['superadmin'];
    mocks.company = null;
    mocks.pendingWithdrawals = 3;
    const nav = renderLayout('/dashboard');
    expect(nav.getByLabelText('3 saques aguardando análise')).toBeInTheDocument();
    mocks.pendingWithdrawals = 0;
  });
});
