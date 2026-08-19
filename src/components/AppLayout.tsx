import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarCheck,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Contact,
  CreditCard,
  ExternalLink,
  Grid3X3,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  MessageSquareQuote,
  Pin,
  PinOff,
  Plug,
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
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { useSystemBranding } from '@/hooks/useSettings';
import WhatsAppStatusAlert from '@/components/WhatsAppStatusAlert';
import CompanyNotificationsPopover from '@/components/CompanyNotificationsPopover';
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
  useCompanyBillingSummary,
  usePlatformBillingModuleStatus,
} from '@/hooks/usePlatformBilling';
import OverdueBillingDialog from '@/components/billing/OverdueBillingDialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface NavItem {
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
  showFor: AppRole[];
  requiredPermission?: CompanyPanelPermission;
  requiredFeature?: CompanyFeatureKey;
  matchPrefix?: boolean;
  badgeCount?: number;
  statusLabel?: string;
}

const ROLE_LABELS: Record<AppRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  operator: 'Operador',
};

const DESKTOP_SIDEBAR_PINNED_STORAGE_KEY = 'app-layout:desktop-sidebar-pinned';

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

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const companyContext = useMaybeCompanySlug();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [reportsNavOpen, setReportsNavOpen] = useState(() => (
    location.pathname.includes('/admin/relatorios/')
  ));
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
  const userId = user?.id;

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
  const billingModuleQuery = usePlatformBillingModuleStatus({ enabled: canViewCompanyBilling });
  const companyBillingSummaryQuery = useCompanyBillingSummary(companyContext?.companyId, {
    enabled: canViewCompanyBilling,
  });
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
          label: 'Reservas',
          description: 'Filtros e status',
          icon: CalendarDays,
          path: `/${slug}/admin/reservas`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'reservations_view',
        },
        {
          label: 'Mesas',
          description: 'Capacidade e ocupa\u00E7\u00E3o',
          icon: Grid3X3,
          path: `/${slug}/admin/mesas`,
          requiredPermission: 'tables_view',
          showFor: ['admin', 'operator', 'superadmin'],
        },
        {
          label: 'Calend\u00E1rio',
          description: 'Agenda do dia',
          icon: CalendarDays,
          path: `/${slug}/admin/calendario`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'calendar_view',
        },
        {
          label: 'Lista de Espera',
          description: 'Fila e chamadas',
          icon: ClipboardList,
          path: `/${slug}/admin/fila`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'waitlist_view',
        },
      ]
    : [];

  const companyReportsNavItems: NavItem[] = slug
    ? [
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

  const companyManagementNavItems: NavItem[] = slug
    ? [
        {
          label: 'Automa\u00E7\u00F5es',
          description: 'Envios autom\u00E1ticos via WhatsApp',
          icon: Bot,
          path: `/${slug}/admin/automacoes`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'automations_view',
          requiredFeature: 'whatsapp_integration',
        },
        {
          label: 'Financeiro',
          description: 'Plano e faturas da unidade',
          icon: ReceiptText,
          path: `/${slug}/admin/financeiro`,
          showFor: ['admin', 'superadmin'],
          badgeCount: companyBillingSummary?.overdueCount ?? 0,
        },
        {
          label: 'Pagamentos',
          description: 'Sinal Asaas por data',
          icon: CreditCard,
          path: `/${slug}/admin/pagamentos-antecipados`,
          showFor: ['admin', 'superadmin'],
          requiredPermission: 'settings_view',
          requiredFeature: 'reservation_prepayment',
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
        {
          label: 'Usu\u00E1rios',
          description: 'Acesso da unidade',
          icon: Users,
          path: `/${slug}/admin/usuarios`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'users_view',
        },
        {
          label: 'Leads',
          description: 'Clientes e hist\u00F3rico',
          icon: Contact,
          path: `/${slug}/admin/leads`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'leads_view',
        },
        {
          label: 'Filiados',
          description: 'Links de indica\u00E7\u00E3o e origem',
          icon: Link2,
          path: `/${slug}/admin/filiados`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'affiliates_view',
        },
        {
          label: 'Eventos',
          description: 'Tracking e Meta CAPI',
          icon: Activity,
          path: `/${slug}/admin/eventos`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'events_view',
        },
        {
          label: 'Configura\u00E7\u00F5es',
          description: 'Hor\u00E1rios e p\u00E1gina',
          icon: Settings,
          path: `/${slug}/admin/configuracoes`,
          showFor: ['admin', 'operator', 'superadmin'],
          requiredPermission: 'settings_view',
        },
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
        },
        {
          label: 'Empresas',
          description: 'Cadastros e acesso',
          icon: Building2,
          path: '/empresas',
          showFor: ['superadmin'],
          matchPrefix: true,
        },
        {
          label: 'Financeiro',
          description: 'Mensalidades da plataforma',
          icon: ReceiptText,
          path: '/financeiro',
          showFor: ['superadmin'],
          matchPrefix: true,
        },
        {
          label: 'Usu\u00E1rios',
          description: 'Acesso global',
          icon: Users,
          path: '/usuarios',
          showFor: ['superadmin'],
        },
        {
          label: 'Configura\u00E7\u00F5es',
          description: 'Par\u00E2metros globais',
          icon: Settings,
          path: '/configuracoes',
          showFor: ['superadmin'],
        },
        {
          label: 'Notifica\u00E7\u00F5es',
          description: 'Avisos para as empresas',
          icon: Bell,
          path: '/notificacoes',
          showFor: ['superadmin'],
        },
        {
          label: 'Logs de A\u00E7\u00F5es',
          description: 'Hist\u00F3rico de opera\u00E7\u00F5es',
          icon: ScrollText,
          path: '/logs',
          showFor: ['superadmin'],
        },
        {
          label: 'Integra\u00E7\u00F5es',
          description: 'Conex\u00F5es externas',
          icon: Plug,
          path: '/integracoes',
          showFor: ['superadmin'],
        },
        {
          label: 'Sa\u00FAde do Sistema',
          description: 'Filas e monitoramento',
          icon: Activity,
          path: '/saude',
          showFor: ['superadmin'],
        },
      ]
    : [];

  const visiblePrimaryNavItems = [...companyPrimaryNavItems, ...superadminNavItems].filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
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

  const visibleManagementNavItems = companyManagementNavItems.filter((item) => {
    if (!rolesLoaded) return false;
    if (!item.showFor.some((role) => activeRoles.includes(role))) return false;
    if (permissionsLoading && item.requiredPermission) return false;
    if (!hasCompanyPermission(item.requiredPermission)) return false;
    if (
      slug
      && item.path === `/${slug}/admin/financeiro`
      && (
        !billingModuleQuery.data?.enabled
        || !companyBillingSummary?.companyBillingEnabled
      )
    ) return false;
    if (item.requiredFeature && (companyFeatureFlagsLoading || !companyFeatureFlags)) return false;
    if (companyFeatureFlags) {
      const f = companyFeatureFlags.features;
      if (item.requiredFeature && f[item.requiredFeature] === false) return false;
    }
    return true;
  });

  const visibleNavItems = [
    ...visiblePrimaryNavItems,
    ...visibleReportsNavItems,
    ...visibleManagementNavItems,
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
  }, [location.pathname]);

  useEffect(() => {
    if (!slug) return;
    const reportsPath = `/${slug}/admin/relatorios`;
    if (location.pathname === reportsPath || location.pathname.startsWith(`${reportsPath}/`)) {
      setReportsNavOpen(true);
    }
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
        area: slug ? 'company_panel' : 'superadmin_panel',
        ...auditMetadata,
      },
    }).catch((error) => {
      reportAccessAuditFailure('panel access', error);
    });
  }, [auditMetadata, loading, location.pathname, location.search, slug, userId]);

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
    stopImpersonation();
    await signOut();
    navigate('/login');
  };

  const handleExitImpersonation = () => {
    stopImpersonation();
    navigate('/dashboard');
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
            aria-label={`${item.badgeCount} ${item.badgeCount === 1 ? 'fatura vencida' : 'faturas vencidas'}`}
            className={cn(
              'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
              isActive
                ? 'bg-primary-foreground text-primary'
                : 'bg-destructive text-destructive-foreground',
            )}
          >
            {item.badgeCount > 99 ? '99+' : item.badgeCount}
          </span>
        )}
      </Link>
    );
  };

  const renderReportsNavGroup = () => {
    if (visibleReportsNavItems.length === 0) return null;

    return (
      <Collapsible open={reportsNavOpen} onOpenChange={setReportsNavOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={`${reportsNavOpen ? 'Recolher' : 'Expandir'} relat\u00F3rios`}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-[color,background-color,border-color]',
              isReportsNavActive
                ? 'bg-sidebar-accent/70 text-sidebar-foreground'
                : 'text-sidebar-foreground/72 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
            )}
          >
            <BarChart3
              className={cn(
                'h-4 w-4 shrink-0 transition-colors',
                isReportsNavActive
                  ? 'text-sidebar-foreground/80'
                  : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/80',
              )}
            />
            <span className="min-w-0 flex-1 truncate">{'Relat\u00F3rios'}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-sidebar-foreground/45 transition-transform duration-200',
                reportsNavOpen && 'rotate-180',
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-5 mt-1 space-y-1 border-l border-sidebar-border/80 pl-2">
            {visibleReportsNavItems.map(renderNavLink)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

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

        <nav className="flex-1 overflow-y-auto px-4 pb-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border hover:[&::-webkit-scrollbar-thumb]:bg-sidebar-foreground/30">
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
                  {renderReportsNavGroup()}
                  {visibleCompanyPrimaryNavItemsWithoutDashboard.map(renderNavLink)}
                </div>
              </div>

              {visibleManagementNavItems.length > 0 && (
                <div className="space-y-2">
                  <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/32">
                    Gestão
                  </p>
                  <div className="space-y-1">
                    {visibleManagementNavItems.map(renderNavLink)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/32">
                Navegação
              </p>
              <div className="space-y-1">
                {visiblePrimaryNavItems.map(renderNavLink)}
              </div>
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
                <p className="text-[10px] uppercase tracking-wide text-sidebar-foreground/40">{'Sess\u00E3o atual'}</p>
                <p className="mt-0.5 text-xs text-sidebar-foreground/75">{rolesLabel}</p>
              </div>

              <Button
                asChild
                variant="ghost"
                className="mt-2 w-full justify-start gap-2 rounded-md text-sidebar-foreground/75 hover:bg-sidebar-border hover:text-sidebar-foreground"
              >
                <Link to={profilePath}>
                  <User className="h-4 w-4" />
                  Meu perfil
                </Link>
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

            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
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
              {slug && canViewCompanyHeaderSignals && <WhatsAppStatusAlert />}
              {isImpersonatingCompany && (
                <Button variant="outline" size="sm" onClick={handleExitImpersonation}>
                  {'Sair da impersona\u00E7\u00E3o'}
                </Button>
              )}
            </div>
          </div>
        </header>


        {/* Notificações do superadmin — só para admin/operator com empresa ativa */}
        {companyContext?.companyId && !activeRoles.includes('superadmin') && (
          activeRoles.includes('admin') || activeRoles.includes('operator')
        ) && <NotificationBanner companyId={companyContext.companyId} />}

        <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:px-5 lg:py-4 animate-fade-in">
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
