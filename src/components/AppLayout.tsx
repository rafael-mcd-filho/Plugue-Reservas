import { type ReactNode, type SVGProps, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Clock,
  Contact,
  CreditCard,
  ExternalLink,
  Grid3X3,
  Info,
  LayoutDashboard,
  Link2,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquareQuote,
  Pin,
  PinOff,
  ReceiptText,
  Repeat2,
  type LucideIcon,
  ScrollText,
  Settings,
  ShieldAlert,
  User,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import { isCompanyNavGroupActive } from '@/lib/company-nav-groups';
import { SERVICE_TODAY_PERMISSION_SETS } from '@/lib/service-today';
import { cn } from '@/lib/utils';
import { buildWhatsAppMessageUrl } from '@/lib/whatsapp-links';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { useSystemBranding } from '@/hooks/useSettings';
import { useFaviconOverride } from '@/lib/publicCompanyIcons';
import WhatsAppStatusAlert from '@/components/WhatsAppStatusAlert';
import CompanyNotificationsPopover from '@/components/CompanyNotificationsPopover';
import CompanyGlobalSearch from '@/components/CompanyGlobalSearch';
import NotificationBanner from '@/components/NotificationBanner';
import { reportAccessAuditFailure, trackAccessAudit } from '@/lib/accessAudit';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { useImpersonation } from '@/hooks/useImpersonation';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import {
  type AppRole,
  type CompanyPanelPermission,
} from '@/lib/companyPermissions';
import type { CompanyFeatureKey } from '@/lib/companyFeatures';
import {
  useCompanyBillingOverdueWarning,
  useCompanyBillingSummary,
  usePlatformBillingModuleStatus,
} from '@/hooks/usePlatformBilling';
import { usePendingWithdrawalCount } from '@/hooks/useAdminSettlements';
import OverdueBillingBanner from '@/components/billing/OverdueBillingBanner';
import OverdueBillingDialog from '@/components/billing/OverdueBillingDialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  COMPANY_OPERATION_SETTINGS_SECTIONS,
  COMPANY_PROFILE_SETTINGS_SECTIONS,
  COMPANY_SETTINGS_SECTION_DESCRIPTIONS,
  COMPANY_SETTINGS_SECTION_NAV_LABELS,
  getCompanySettingsSectionPath,
  type CompanySettingsSection,
} from '@/lib/company-settings-sections';

interface NavItem {
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
  showFor: AppRole[];
  requiredPermission?: CompanyPanelPermission;
  requiredPermissionSets?: CompanyPanelPermission[][];
  requiredFeature?: CompanyFeatureKey;
  matchPrefix?: boolean;
  badgeCount?: number;
  /** Texto lido por leitores de tela para o contador; padrão: faturas vencidas. */
  badgeLabel?: [string, string];
  badgeTone?: 'danger' | 'warning';
  statusLabel?: string;
  /** Grupo visual do menu global do superadmin. */
  group?: SuperadminNavGroup;
}

type SuperadminNavGroup = 'principal' | 'gestao' | 'plataforma';

const SUPERADMIN_NAV_GROUPS: Array<{ id: SuperadminNavGroup; label: string }> = [
  { id: 'principal', label: 'Principal' },
  { id: 'gestao', label: 'Gestão' },
  { id: 'plataforma', label: 'Plataforma' },
];

const ROLE_LABELS: Record<AppRole, string> = {
  superadmin: 'Superadmin',
  support: 'Suporte',
  admin: 'Admin',
  operator: 'Operador',
};

const DESKTOP_SIDEBAR_PINNED_STORAGE_KEY = 'app-layout:desktop-sidebar-pinned';

const COMPANY_SETTINGS_SECTION_ICONS: Record<CompanySettingsSection, LucideIcon> = {
  empresa: Info,
  agenda: Clock,
  reservas: CalendarCheck,
  disponibilidade: CalendarClock,
  'pagina-publica': Megaphone,
};

function getFortalezaDateKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatRoleLabel(role: AppRole) {
  return ROLE_LABELS[role] ?? role;
}

// Numero fixo da equipe de suporte; nao vem do cadastro da empresa.
const SUPPORT_WHATSAPP_NUMBER = '5584991079919';

function buildSupportWhatsAppUrl(companyName: string) {
  const message = `Olá, gostaria de suporte para minha conta: ${companyName}`;
  return buildWhatsAppMessageUrl(SUPPORT_WHATSAPP_NUMBER, message);
}

function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.25a9.75 9.75 0 0 0-8.35 14.78L2.3 21.7l4.84-1.27A9.75 9.75 0 1 0 12 2.25Z"
      />
      <path
        fill="white"
        d="M9.25 6.65c-.23 0-.45.11-.63.31-.31.33-.82.83-.82 1.94s.81 2.18.92 2.33c.11.14 1.58 2.52 3.83 3.44 1.87.75 2.25.6 2.66.56.41-.04 1.32-.54 1.51-1.06.19-.53.19-.97.13-1.06-.05-.09-.19-.15-.39-.25-.2-.1-1.16-.57-1.34-.64-.18-.06-.31-.09-.45.12-.13.2-.52.63-.63.77-.12.13-.24.15-.43.05-.2-.1-.84-.31-1.6-1-.59-.53-.99-1.19-1.12-1.39-.12-.2-.02-.3.09-.4.09-.09.2-.23.3-.34.1-.11.13-.2.2-.32.07-.13.03-.25-.01-.34-.05-.1-.44-1.12-.61-1.53-.16-.39-.33-.4-.45-.4h-.38Z"
      />
    </svg>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const companyContext = useMaybeCompanySlug();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [reportsNavOpen, setReportsNavOpen] = useState(() => isCompanyNavGroupActive(location.pathname, 'reports'));
  const [reservationsNavOpen, setReservationsNavOpen] = useState(() => isCompanyNavGroupActive(location.pathname, 'reservations'));
  const [operationsNavOpen, setOperationsNavOpen] = useState(() => isCompanyNavGroupActive(location.pathname, 'operations'));
  const [companyNavOpen, setCompanyNavOpen] = useState(() => isCompanyNavGroupActive(location.pathname, 'company'));
  const [communicationNavOpen, setCommunicationNavOpen] = useState(() => isCompanyNavGroupActive(location.pathname, 'communication'));
  const [overdueBillingDialogOpen, setOverdueBillingDialogOpen] = useState(false);
  const [desktopSidebarPinned, setDesktopSidebarPinned] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DESKTOP_SIDEBAR_PINNED_STORAGE_KEY) === 'true';
  });
  const { user, profile, roles, loading, signOut } = useAuth();
  const { data: systemBranding } = useSystemBranding();
  const systemName = systemBranding?.system_name || DEFAULT_SYSTEM_NAME;
  const { data: companyFeatureFlags, isLoading: companyFeatureFlagsLoading } = useCompanyFeatureFlags(companyContext?.companyId);
  const systemLogo = systemBranding?.system_logo_url || '';
  useFaviconOverride(systemBranding?.system_logo_url);
  const userId = user?.id;
  const isSupportAccount = roles.includes('support');

  const {
    isImpersonatingCompany,
    impersonatedSlug,
    effectiveRole,
    effectiveRoles,
    auditMetadata,
    stopImpersonation,
  } = useImpersonation();

  const { activeRoles, hasPermission, permissionsLoading } = useCompanyPermissions();
  const rolesLoaded = !loading && activeRoles.length > 0;
  const canViewCompanyBilling = !!slug && (activeRoles.includes('admin') || activeRoles.includes('superadmin'));
  const canReadCompanyBillingWarning = !!companyContext?.companyId
    && rolesLoaded
    && activeRoles.some((role) => (
      role === 'admin' || role === 'operator' || role === 'superadmin'
    ));
  const billingModuleQuery = usePlatformBillingModuleStatus({ enabled: canViewCompanyBilling });
  const companyBillingWarningQuery = useCompanyBillingOverdueWarning(
    companyContext?.companyId,
    { enabled: canReadCompanyBillingWarning },
  );
  const companyBillingSummaryQuery = useCompanyBillingSummary(companyContext?.companyId, {
    enabled: canViewCompanyBilling,
  });
  const pendingWithdrawalQuery = usePendingWithdrawalCount({
    enabled: !slug && rolesLoaded && activeRoles.includes('superadmin'),
  });
  const pendingWithdrawalCount = pendingWithdrawalQuery.data ?? 0;
  const companyBillingSummary = companyBillingSummaryQuery.data;
  const sidebarContextLabel = slug ? 'Painel da unidade' : 'Painel global';
  const companyName = companyContext?.companyName || slug || 'Unidade';
  const hasCompanyPermission = (permission?: CompanyPanelPermission) => !permission || hasPermission(permission);

  const companyPrimaryNavItems: NavItem[] = slug
    ? [
        {
          label: 'Dashboard',
          description: 'Resumo operacional',
          icon: LayoutDashboard,
          path: `/${slug}/admin`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'dashboard_view',
        },
        {
          label: 'Check-ins',
          description: 'Reservas do dia e atendimento',
          icon: CalendarCheck,
          path: `/${slug}/admin/check-ins`,
          showFor: ['operator'],
          requiredPermission: 'checkins_view',
        },
        {
          label: 'Serviços de Hoje',
          description: 'Chegadas, salão e fila',
          icon: UtensilsCrossed,
          path: `/${slug}/admin/servico`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermissionSets: SERVICE_TODAY_PERMISSION_SETS,
        },
      ]
    : [];

  const companyReservationsNavItems: NavItem[] = slug
    ? [
        {
          label: 'Vis\u00E3o geral',
          description: 'Pr\u00F3ximos 15 dias',
          icon: CalendarDays,
          path: `/${slug}/admin/reservas`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'reservations_view',
        },
        {
          label: 'Lista',
          description: 'Filtros e hist\u00F3rico',
          icon: ClipboardList,
          path: `/${slug}/admin/reservas/lista`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'reservations_view',
        },
        {
          label: 'Calend\u00E1rio',
          description: 'Agenda do dia',
          icon: CalendarDays,
          path: `/${slug}/admin/reservas/calendario`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'calendar_view',
        },
      ]
    : [];

  const companyReportsNavItems: NavItem[] = slug
    ? [
        {
          label: 'Demanda',
          description: 'Procura, jornada e perfil dos grupos',
          icon: Activity,
          path: `/${slug}/admin/relatorios/demanda-conversao`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'dashboard_view',
          requiredFeature: 'advanced_reports',
        },
        {
          label: 'Perdas',
          description: 'Check-ins, faltas e cancelamentos',
          icon: ShieldAlert,
          path: `/${slug}/admin/relatorios/comparecimento-perdas`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'dashboard_view',
          requiredFeature: 'advanced_reports',
        },
        {
          label: 'Capacidade',
          description: 'Demanda planejada e pressão por horário',
          icon: Grid3X3,
          path: `/${slug}/admin/relatorios/ocupacao-capacidade`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'dashboard_view',
          requiredFeature: 'advanced_reports',
        },
        {
          label: 'Recorr\u00EAncia',
          description: 'Retorno e frequ\u00EAncia dos clientes',
          icon: Repeat2,
          path: `/${slug}/admin/relatorios/recorrencia`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'leads_view',
          requiredFeature: 'advanced_reports',
        },
      ]
    : [];

  const companyDirectNavItems: NavItem[] = slug
    ? [
        {
          label: 'Clientes',
          description: 'Contatos e histórico de presenças',
          icon: Contact,
          path: `/${slug}/admin/leads`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'leads_view',
        },
        {
          label: 'Pagamentos',
          description: 'Recebimentos das reservas',
          icon: CreditCard,
          path: `/${slug}/admin/pagamentos-antecipados`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'settings_view',
          requiredFeature: 'reservation_prepayment',
        },
      ]
    : [];

  const companyCommunicationNavItems: NavItem[] = slug
    ? [
        {
          label: 'Mensagens',
          description: 'Envios automáticos via WhatsApp',
          icon: MessageCircle,
          path: `/${slug}/admin/automacoes`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'automations_view',
          requiredFeature: 'whatsapp_integration',
        },
        {
          label: 'Avaliações',
          description: 'NPS e satisfação pós-visita',
          icon: MessageSquareQuote,
          path: `/${slug}/admin/avaliacoes`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'nps_view',
          requiredFeature: 'nps_surveys',
        },
      ]
    : [];

  const companySubscriptionNavItems: NavItem[] = slug
    ? [
        {
          label: 'Minha assinatura',
          description: 'Plano e faturas da unidade',
          icon: ReceiptText,
          path: `/${slug}/admin/financeiro`,
          showFor: ['admin', 'superadmin'],
          badgeCount: companyBillingSummary?.overdueCount ?? 0,
        },
      ]
    : [];

  const companyPartnerNavItems: NavItem[] = slug
    ? [
        {
          label: 'Parceiros',
          description: 'Links de indicação e origem',
          icon: Link2,
          path: `/${slug}/admin/filiados`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'affiliates_view',
        },
      ]
    : [];

  const buildSettingsNavItem = (section: CompanySettingsSection): NavItem => ({
    label: COMPANY_SETTINGS_SECTION_NAV_LABELS[section],
    description: COMPANY_SETTINGS_SECTION_DESCRIPTIONS[section],
    icon: COMPANY_SETTINGS_SECTION_ICONS[section],
    path: getCompanySettingsSectionPath(slug ?? '', section),
    showFor: ['admin', 'operator', 'superadmin'],
    requiredPermission: 'settings_view',
  });

  const companyAccountNavItems: NavItem[] = slug
    ? [
        ...COMPANY_PROFILE_SETTINGS_SECTIONS.map(buildSettingsNavItem),
        {
          label: 'Equipe',
          description: 'Pessoas e acessos da unidade',
          icon: Users,
          path: `/${slug}/admin/usuarios`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'users_view',
        },
        {
          label: 'Rastreamento',
          description: 'Rastreamento e integrações de marketing',
          icon: Activity,
          path: `/${slug}/admin/eventos`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'events_view',
        },
      ]
    : [];

  const companyOperationsNavItems: NavItem[] = slug
    ? [
        ...COMPANY_OPERATION_SETTINGS_SECTIONS
          .filter((section) => section !== 'pagina-publica')
          .map(buildSettingsNavItem),
        {
          label: 'Mesas',
          description: 'Mapas, seções e capacidade',
          icon: Grid3X3,
          path: `/${slug}/admin/mesas`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'tables_view',
        },
        buildSettingsNavItem('pagina-publica'),
      ]
    : [];

  const superadminNavItems: NavItem[] = !slug
    ? [
        {
          label: 'Dashboard',
          description: 'Vis\u00E3o consolidada',
          icon: BarChart3,
          path: '/dashboard',
          showFor: ['superadmin'],
          group: 'principal',
        },
        {
          label: 'Empresas',
          description: 'Cadastros e acesso',
          icon: Building2,
          path: '/empresas',
          showFor: ['superadmin', 'support'],
          matchPrefix: true,
          group: 'principal',
        },
        {
          label: 'Usu\u00E1rios',
          description: 'Acesso global',
          icon: Users,
          path: '/usuarios',
          showFor: ['superadmin'],
          group: 'principal',
        },
        {
          label: 'Financeiro',
          description: 'Mensalidades e repasses',
          icon: ReceiptText,
          path: '/financeiro',
          showFor: ['superadmin'],
          matchPrefix: true,
          group: 'gestao',
          badgeCount: pendingWithdrawalCount,
          badgeLabel: ['saque aguardando an\u00E1lise', 'saques aguardando an\u00E1lise'],
          badgeTone: 'warning',
        },
        {
          label: 'Avisos',
          description: 'Avisos para as empresas',
          icon: Bell,
          path: '/notificacoes',
          showFor: ['superadmin'],
          group: 'gestao',
        },
        {
          label: 'Sa\u00FAde',
          description: 'Filas e monitoramento',
          icon: Activity,
          path: '/saude',
          showFor: ['superadmin'],
          group: 'plataforma',
        },
        {
          label: 'Configura\u00E7\u00F5es',
          description: 'Identidade e integra\u00E7\u00F5es',
          icon: Settings,
          path: '/configuracoes',
          showFor: ['superadmin'],
          group: 'plataforma',
        },
        {
          label: 'Auditoria',
          description: 'Hist\u00F3rico de a\u00E7\u00F5es',
          icon: ScrollText,
          path: '/logs',
          showFor: ['superadmin'],
          group: 'plataforma',
        },
      ]
    : [];

  const visiblePrimaryNavItems = [...companyPrimaryNavItems, ...superadminNavItems].filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
    if (item.requiredPermissionSets && (permissionsLoading || !item.requiredPermissionSets.some(set => set.every(hasPermission)))) return false;
    if (item.requiredFeature && (companyFeatureFlagsLoading || !companyFeatureFlags)) return false;
    if (companyFeatureFlags) {
      const f = companyFeatureFlags.features;
      if (item.label === 'Dashboard' && f.advanced_reports === false) return false;
      if (item.requiredFeature && f[item.requiredFeature] === false) return false;
    }
    return true;
  });

  const visibleReportsNavItems = companyReportsNavItems.filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
    if (item.requiredFeature && (companyFeatureFlagsLoading || !companyFeatureFlags)) return false;
    if (companyFeatureFlags) {
      const f = companyFeatureFlags.features;
      if (item.requiredFeature && f[item.requiredFeature] === false) return false;
    }
    return true;
  });

  const visibleReservationsNavItems = companyReservationsNavItems.filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
    return true;
  });

  // Mesma regra de papel, permissao e feature flag dos demais grupos.
  const filterCompanyNavItems = (items: NavItem[]) => items.filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
    if (item.requiredFeature && (companyFeatureFlagsLoading || !companyFeatureFlags)) return false;
    if (companyFeatureFlags && item.requiredFeature) {
      if (companyFeatureFlags.features[item.requiredFeature] === false) return false;
    }
    return true;
  });

  const visibleAccountNavItems = filterCompanyNavItems(companyAccountNavItems);
  const visibleOperationsNavItems = filterCompanyNavItems(companyOperationsNavItems);
  const visibleDirectNavItems = filterCompanyNavItems(companyDirectNavItems);
  const visibleCommunicationNavItems = filterCompanyNavItems(companyCommunicationNavItems);
  const visiblePartnerNavItems = filterCompanyNavItems(companyPartnerNavItems);
  const visibleSubscriptionNavItems = filterCompanyNavItems(companySubscriptionNavItems).filter(() => (
    billingModuleQuery.data?.enabled && companyBillingSummary?.companyBillingEnabled
  ));

  const visibleNavItems = [
    ...visiblePrimaryNavItems,
    ...visibleReportsNavItems,
    ...visibleReservationsNavItems,
    ...visibleDirectNavItems,
    ...visibleCommunicationNavItems,
    ...visiblePartnerNavItems,
    ...visibleOperationsNavItems,
    ...visibleAccountNavItems,
    ...visibleSubscriptionNavItems,
  ];
  const companyDashboardPath = slug ? `/${slug}/admin` : null;
  const visibleCompanyDashboardItem = companyDashboardPath
    ? visiblePrimaryNavItems.find((item) => item.path === companyDashboardPath)
    : undefined;
  const visibleCompanyPrimaryNavItemsWithoutDashboard = companyDashboardPath
    ? visiblePrimaryNavItems.filter((item) => item.path !== companyDashboardPath)
    : [];
  const profilePath = slug ? `/${slug}/admin/perfil` : '/perfil';

  const isNavItemActive = (item: NavItem) => {
    if (item.matchPrefix) {
      return location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
    }
    return location.pathname === item.path;
  };

  const activeNavItem = visibleNavItems.find((item) => isNavItemActive(item)) ?? null;
  const isReportsNavActive = visibleReportsNavItems.some((item) => isNavItemActive(item));
  const isReservationsNavActive = visibleReservationsNavItems.some((item) => isNavItemActive(item));
  const isOperationsNavActive = visibleOperationsNavItems.some((item) => isNavItemActive(item));
  const isCompanyNavActive = visibleAccountNavItems.some((item) => isNavItemActive(item));
  const isCommunicationNavActive = visibleCommunicationNavItems.some((item) => isNavItemActive(item));
  const isProfileRoute = location.pathname === profilePath;
  const isOperatorPanel = !!slug && activeRoles.length === 1 && activeRoles[0] === 'operator';
  const showHeaderContextBadges = !isOperatorPanel;
  const showHeaderMeta = showHeaderContextBadges || isImpersonatingCompany;
  const canViewCompanyHeaderSignals = activeRoles.includes('admin') || activeRoles.includes('superadmin');

  const headerTitle = isProfileRoute
    ? 'Meu Perfil'
    : activeNavItem?.label || (slug ? 'Painel da unidade' : 'Painel administrativo');
  const headerDescription = isProfileRoute
    ? 'Atualize seus dados de acesso e senha.'
    : activeNavItem?.description || (
    slug
      ? 'Acompanhe a opera\u00E7\u00E3o da unidade com navega\u00E7\u00E3o centralizada.'
      : 'Gerencie a plataforma a partir do painel global.'
  );
  const rolesLabel = activeRoles.length > 0
    ? activeRoles.map((role) => formatRoleLabel(role)).join(' / ')
    : 'Sem papel definido';

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, location.search]);

  // No painel o título é só a marca; a chamada de marketing do index.html vale para o site.
  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  // Abrir o grupo correto sem mudar as URLs já usadas por links e favoritos.
  useEffect(() => {
    if (!slug) return;
    if (isCompanyNavGroupActive(location.pathname, 'reports')) setReportsNavOpen(true);
    if (isCompanyNavGroupActive(location.pathname, 'reservations')) setReservationsNavOpen(true);
    if (isCompanyNavGroupActive(location.pathname, 'company')) setCompanyNavOpen(true);
    if (isCompanyNavGroupActive(location.pathname, 'operations')) setOperationsNavOpen(true);
    if (isCompanyNavGroupActive(location.pathname, 'communication')) setCommunicationNavOpen(true);
  }, [location.pathname, slug]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DESKTOP_SIDEBAR_PINNED_STORAGE_KEY, String(desktopSidebarPinned));
  }, [desktopSidebarPinned]);

  useEffect(() => {
    if (loading || !userId) return;

    trackAccessAudit({
      eventType: 'panel_access',
      slug: slug ?? null,
      path: `${location.pathname}${location.search || ''}`,
      metadata: {
        area: slug ? 'company_panel' : (isSupportAccount ? 'support_panel' : 'superadmin_panel'),
        ...auditMetadata,
      },
    }).catch((error) => {
      reportAccessAuditFailure('panel access', error);
    });
  }, [auditMetadata, isSupportAccount, loading, location.pathname, location.search, slug, userId]);

  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  useEffect(() => {
    const companyId = companyContext?.companyId;
    if (
      !canViewCompanyBilling
      || !billingModuleQuery.data?.enabled
      || !companyBillingSummary?.companyBillingEnabled
      || !companyId
      || !companyBillingSummary?.showOverduePopup
    ) {
      setOverdueBillingDialogOpen(false);
      return;
    }

    const storageKey = `platform-billing:overdue-popup:${companyId}:${getFortalezaDateKey()}`;
    try {
      if (window.sessionStorage.getItem(storageKey)) return;
      window.sessionStorage.setItem(storageKey, 'shown');
    } catch {
      // If session storage is unavailable, showing once per current mount is the safest fallback.
    }

    setOverdueBillingDialogOpen(true);
  }, [
    billingModuleQuery.data?.enabled,
    canViewCompanyBilling,
    companyBillingSummary?.companyBillingEnabled,
    companyBillingSummary?.showOverduePopup,
    companyContext?.companyId,
  ]);

  const handleSignOut = async () => {
    await stopImpersonation();
    await signOut();
    navigate('/login');
  };

  const handleExitImpersonation = async () => {
    try {
      await stopImpersonation();
    } finally {
      navigate(roles.includes('support') ? '/empresas' : '/dashboard', { replace: true });
    }
  };

  const renderNavLink = (item: NavItem) => {
    const isActive = isNavItemActive(item);

    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-[color,background-color,border-color]',
          isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-sidebar-foreground/72 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
        )}
      >
        <item.icon
          aria-hidden="true"
          className={cn(
            'h-4 w-4 shrink-0 transition-colors',
            isActive ? 'text-primary-foreground' : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/80',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label}</span>
          {item.statusLabel && (
            <span
              className={cn(
                'mt-1 flex w-fit max-w-full items-center gap-1.5 text-[10px] font-semibold leading-none',
                isActive
                  ? 'rounded-full bg-amber-100 px-1.5 py-1 text-amber-950'
                  : 'text-amber-400',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  isActive ? 'bg-amber-500' : 'bg-amber-400',
                )}
              />
              <span className="truncate">{item.statusLabel}</span>
            </span>
          )}
        </span>
        {!!item.badgeCount && item.badgeCount > 0 && (
          <span
            aria-label={`${item.badgeCount} ${item.badgeCount === 1
              ? (item.badgeLabel?.[0] ?? 'fatura vencida')
              : (item.badgeLabel?.[1] ?? 'faturas vencidas')}`}
            className={cn(
              'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
              item.badgeTone === 'warning'
                ? isActive
                  ? 'bg-white text-amber-900'
                  : 'bg-amber-400 text-amber-950'
                : 'bg-destructive text-destructive-foreground ring-1 ring-destructive-foreground/30',
            )}
          >
            {item.badgeCount > 99 ? '99+' : item.badgeCount}
          </span>
        )}
      </Link>
    );
  };

  const renderNavGroup = ({ label, icon: GroupIcon, items, open, onOpenChange, isActive }: {
    label: string;
    icon: LucideIcon;
    items: NavItem[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isActive: boolean;
  }) => {
    if (items.length === 0) return null;

    return (
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={`${open ? 'Recolher' : 'Expandir'} ${label.toLowerCase()}`}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-[color,background-color,border-color]',
              isActive
                ? 'bg-sidebar-accent/70 text-sidebar-foreground'
                : 'text-sidebar-foreground/72 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
            )}
          >
            <GroupIcon
              aria-hidden="true"
              className={cn(
                'h-4 w-4 shrink-0 transition-colors',
                isActive
                  ? 'text-sidebar-foreground/80'
                  : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/80',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-sidebar-foreground/45 transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-5 mt-1 space-y-1 border-l border-sidebar-border/80 pl-2">
            {items.map(renderNavLink)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderReportsNavGroup = () => renderNavGroup({
    label: 'Relat\u00F3rios',
    icon: BarChart3,
    items: visibleReportsNavItems,
    open: reportsNavOpen,
    onOpenChange: setReportsNavOpen,
    isActive: isReportsNavActive,
  });

  const renderReservationsNavGroup = () => renderNavGroup({
    label: 'Reservas',
    icon: CalendarDays,
    items: visibleReservationsNavItems,
    open: reservationsNavOpen,
    onOpenChange: setReservationsNavOpen,
    isActive: isReservationsNavActive,
  });

  const renderOperationsNavGroup = () => renderNavGroup({
    label: 'Operação',
    icon: Settings,
    items: visibleOperationsNavItems,
    open: operationsNavOpen,
    onOpenChange: setOperationsNavOpen,
    isActive: isOperationsNavActive,
  });

  const renderCompanyNavGroup = () => renderNavGroup({
    label: 'Empresa',
    icon: Building2,
    items: visibleAccountNavItems,
    open: companyNavOpen,
    onOpenChange: setCompanyNavOpen,
    isActive: isCompanyNavActive,
  });

  const renderCommunicationNavGroup = () => renderNavGroup({
    label: 'Comunicação',
    icon: MessageCircle,
    items: visibleCommunicationNavItems,
    open: communicationNavOpen,
    onOpenChange: setCommunicationNavOpen,
    isActive: isCommunicationNavActive,
  });

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {mobileOpen && (
        <div
          className={cn(
            'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm',
            desktopSidebarPinned && 'lg:hidden',
          )}
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl transition-transform duration-300',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          desktopSidebarPinned && 'lg:relative lg:translate-x-0 lg:shadow-none',
        )}
      >
        <div className="px-4 pb-3 pt-4">
          <div className="flex items-center gap-3">
            {systemLogo ? (
              <img src={systemLogo} alt={systemName} className="h-8 w-8 rounded-lg object-contain" />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <UtensilsCrossed className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-sidebar-foreground">{systemName}</h1>
              <p className="text-[10px] uppercase tracking-[0.2em] text-sidebar-foreground/45">
                {sidebarContextLabel}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border hover:[&::-webkit-scrollbar-thumb]:bg-sidebar-foreground/30">
          {!rolesLoaded ? (
            <div className="space-y-4" aria-busy="true" aria-label="Carregando menu">
              {slug && (
                <div className="h-[46px] animate-pulse rounded-lg bg-sidebar-accent/40" />
              )}
              <div className="space-y-2">
                <div className="ml-2 h-3 w-16 animate-pulse rounded bg-sidebar-accent/40" />
                <div className="space-y-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-9 animate-pulse rounded-lg bg-sidebar-accent/40" />
                  ))}
                </div>
              </div>
              {slug && (
                <div className="space-y-2">
                  <div className="ml-2 h-3 w-16 animate-pulse rounded bg-sidebar-accent/40" />
                  <div className="space-y-1">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-9 animate-pulse rounded-lg bg-sidebar-accent/40" />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : slug ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-sidebar-border/80 bg-sidebar-accent/30 px-3 py-2.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-success" />
                <span className="min-w-0 flex-1 break-words text-sm font-medium text-sidebar-foreground">
                  {companyName}
                </span>
              </div>

              <div className="space-y-2">
                <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/32">
                  Principal
                </p>
                <div className="space-y-1">
                  {visibleCompanyDashboardItem && renderNavLink(visibleCompanyDashboardItem)}
                  {renderReservationsNavGroup()}
                  {renderReportsNavGroup()}
                  {visibleCompanyPrimaryNavItemsWithoutDashboard.map(renderNavLink)}
                </div>
              </div>

              {(
                visibleDirectNavItems.length > 0
                || visibleCommunicationNavItems.length > 0
                || visiblePartnerNavItems.length > 0
                || visibleOperationsNavItems.length > 0
                || visibleAccountNavItems.length > 0
                || visibleSubscriptionNavItems.length > 0
              ) && (
                <div className="space-y-2">
                  <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/32">
                    Administração
                  </p>
                  <div className="space-y-1">
                    {visibleDirectNavItems.map(renderNavLink)}
                    {renderCommunicationNavGroup()}
                    {visiblePartnerNavItems.map(renderNavLink)}
                    {renderOperationsNavGroup()}
                    {renderCompanyNavGroup()}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {SUPERADMIN_NAV_GROUPS.map((group) => {
                const groupItems = visiblePrimaryNavItems.filter((item) => (item.group ?? 'principal') === group.id);
                if (groupItems.length === 0) return null;
                return (
                  <div key={group.id} className="space-y-2">
                    <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/50">
                      {group.label}
                    </p>
                    <div className="space-y-1">
                      {groupItems.map(renderNavLink)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
          {visibleSubscriptionNavItems.length > 0 && (
            <div className="mt-2 shrink-0 border-t border-sidebar-border bg-sidebar pt-2">
              {visibleSubscriptionNavItems.map(renderNavLink)}
            </div>
          )}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          {profile ? (
            <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/60 p-3">
              <div className="flex items-center gap-2.5">
                {companyContext?.companyLogoUrl ? (
                  <img
                    src={companyContext.companyLogoUrl}
                    alt={companyContext.companyName}
                    className="h-8 w-8 shrink-0 rounded-md border border-sidebar-border bg-sidebar object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary/15 text-sidebar-primary">
                    <User className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-sidebar-foreground">
                    {profile.full_name || profile.email}
                  </p>
                </div>
              </div>

              <div className="mt-2 rounded-md border border-sidebar-border bg-sidebar px-2.5 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-sidebar-foreground/40">{'Sessão atual'}</p>
                <p className="mt-0.5 text-xs text-sidebar-foreground/75">{rolesLabel}</p>
              </div>

              {!roles.includes('support') && <Button
                asChild
                variant="ghost"
                className="mt-2 w-full justify-start gap-2 rounded-md text-sidebar-foreground/75 hover:bg-sidebar-border hover:text-sidebar-foreground"
              >
                <Link to={profilePath}>
                  <User className="h-4 w-4" />
                  Meu perfil
                </Link>
              </Button>}

              <Button
                asChild
                variant="ghost"
                className="mt-2 w-full justify-start gap-2 rounded-md text-sidebar-foreground/75 hover:bg-emerald-500/10 hover:text-emerald-400"
              >
                <a
                  href={buildSupportWhatsAppUrl(companyName)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <WhatsAppIcon className="h-4 w-4 shrink-0 text-[#25D366]" />
                  Suporte
                </a>
              </Button>

              <Button
                variant="ghost"
                className="mt-2 w-full justify-start gap-2 rounded-md text-sidebar-foreground/75 hover:bg-destructive/10 hover:text-destructive"
                onClick={handleSignOut}
              >
                <LogOut className="h-4 w-4" />
                Sair
              </Button>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex min-h-[44px] flex-row items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3 lg:items-center">
              <button
                onClick={() => setMobileOpen((current) => !current)}
                aria-label="Abrir menu de navegação"
                className="mt-0.5 rounded-md border border-border bg-card p-2 text-foreground transition-colors hover:bg-muted"
              >
                <Menu className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setDesktopSidebarPinned((current) => !current);
                  setMobileOpen(false);
                }}
                aria-label={desktopSidebarPinned ? 'Desafixar menu lateral' : 'Fixar menu lateral'}
                title={desktopSidebarPinned ? 'Desafixar menu lateral' : 'Fixar menu lateral'}
                className="mt-0.5 hidden rounded-md border border-border bg-card p-2 text-foreground transition-colors hover:bg-muted lg:inline-flex"
              >
                {desktopSidebarPinned ? (
                  <PinOff className="h-4 w-4" />
                ) : (
                  <Pin className="h-4 w-4" />
                )}
              </button>

              {showHeaderMeta && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {isImpersonatingCompany && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      {`Impersonando ${formatRoleLabel(effectiveRole)}`}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* A busca ocupa o espaço livre do topo, até um limite confortável de leitura. */}
            {slug && companyContext?.companyId && (
              <div className="flex min-w-0 flex-1 justify-end sm:mr-auto sm:max-w-[520px] sm:justify-start">
                <CompanyGlobalSearch key={companyContext.companyId}
                  companyId={companyContext.companyId} companyName={companyName} slug={slug} />
              </div>
            )}

            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              {slug && canViewCompanyHeaderSignals && <WhatsAppStatusAlert />}
              {slug && (
                <a
                  href={`/${slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Ver página pública"
                >
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Página pública</span>
                  </Button>
                </a>
              )}
              {slug && canViewCompanyHeaderSignals && <CompanyNotificationsPopover />}
              {isImpersonatingCompany && (
                <Button variant="outline" size="sm" onClick={handleExitImpersonation}>
                  {'Sair da impersona\u00E7\u00E3o'}
                </Button>
              )}
            </div>
          </div>
        </header>

        {/* Um aviso por vez: a faixa da fatura não aparece junto com o popup da mesma fatura. */}
        <OverdueBillingBanner
          show={companyBillingWarningQuery.data?.showOverdueWarning === true && !overdueBillingDialogOpen}
          dismissKey={companyContext?.companyId}
          invoicesPath={canViewCompanyBilling
            && companyBillingSummary?.companyBillingEnabled
            && slug
            ? `/${slug}/admin/financeiro`
            : undefined}
        />


        {/* Notificações do superadmin — só para admin/operator com empresa ativa, e nunca por cima do popup da fatura */}
        {companyContext?.companyId && !activeRoles.includes('superadmin') && !overdueBillingDialogOpen && (
          activeRoles.includes('admin') || activeRoles.includes('operator')
        ) && <NotificationBanner companyId={companyContext.companyId} />}

        <main className={cn('min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:px-5 lg:py-4 animate-fade-in', slug && location.pathname === `/${slug}/admin/servico` && '[scrollbar-gutter:stable]')}>
          {children}
        </main>
      </div>

      {slug && canViewCompanyBilling && companyBillingSummary && (
        <OverdueBillingDialog
          open={overdueBillingDialogOpen}
          overdueCount={companyBillingSummary.overdueCount}
          overdueTotal={companyBillingSummary.overdueTotal}
          oldestOverdueDays={companyBillingSummary.oldestOverdueDays}
          onOpenChange={setOverdueBillingDialogOpen}
          onViewInvoices={() => {
            setOverdueBillingDialogOpen(false);
            navigate(`/${slug}/admin/financeiro`);
          }}
        />
      )}
    </div>
  );
}
