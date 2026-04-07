import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Contact,
  ExternalLink,
  Grid3X3,
  LayoutDashboard,
  LogOut,
  Menu,
  type LucideIcon,
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
import { trackAccessAudit } from '@/lib/accessAudit';
import { useImpersonation } from '@/hooks/useImpersonation';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';

type AppRole = 'superadmin' | 'admin' | 'operator';

interface NavItem {
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
  showFor: AppRole[];
  matchPrefix?: boolean;
}

const ROLE_LABELS: Record<AppRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  operator: 'Operador',
};

function formatRoleLabel(role: AppRole) {
  return ROLE_LABELS[role] ?? role;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const companyContext = useMaybeCompanySlug();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(true);
  const { user, profile, roles, loading, signOut } = useAuth();
  const { data: systemBranding } = useSystemBranding();
  const systemName = systemBranding?.system_name || DEFAULT_SYSTEM_NAME;
  const systemLogo = systemBranding?.system_logo_url || '';
  const userId = user?.id;

  const {
    isImpersonatingCompany,
    impersonatedSlug,
    impersonatedUserName,
    impersonatedUserEmail,
    effectiveRole,
    effectiveRoles,
    auditMetadata,
    stopImpersonation,
  } = useImpersonation();

  const activeRoles = isImpersonatingCompany ? effectiveRoles : roles;
  const rolesLoaded = !loading && activeRoles.length > 0;
  const sidebarContextLabel = slug ? 'Painel da unidade' : 'Painel global';
  const companyName = companyContext?.companyName || slug || 'Unidade';

  const companyPrimaryNavItems: NavItem[] = slug
    ? [
        {
          label: 'Dashboard',
          description: 'Resumo operacional',
          icon: LayoutDashboard,
          path: `/${slug}/admin`,
          showFor: ['admin', 'operator', 'superadmin'],
        },
        {
          label: 'Reservas',
          description: 'Filtros e status',
          icon: CalendarDays,
          path: `/${slug}/admin/reservas`,
          showFor: ['admin', 'operator', 'superadmin'],
        },
        {
          label: 'Mesas',
          description: 'Capacidade e ocupa\u00E7\u00E3o',
          icon: Grid3X3,
          path: `/${slug}/admin/mesas`,
          showFor: ['admin', 'operator', 'superadmin'],
        },
        {
          label: 'Calend\u00E1rio',
          description: 'Agenda do dia',
          icon: CalendarDays,
          path: `/${slug}/admin/calendario`,
          showFor: ['admin', 'operator', 'superadmin'],
        },
        {
          label: 'Lista de Espera',
          description: 'Fila e chamadas',
          icon: ClipboardList,
          path: `/${slug}/admin/fila`,
          showFor: ['admin', 'operator', 'superadmin'],
        },
      ]
    : [];

  const companyManagementNavItems: NavItem[] = slug
    ? [
        {
          label: 'Automa\u00E7\u00F5es',
          description: 'WhatsApp e webhooks',
          icon: Bot,
          path: `/${slug}/admin/automacoes`,
          showFor: ['admin', 'superadmin'],
        },
        {
          label: 'Usu\u00E1rios',
          description: 'Acesso da unidade',
          icon: Users,
          path: `/${slug}/admin/usuarios`,
          showFor: ['admin', 'superadmin'],
        },
        {
          label: 'Leads',
          description: 'Clientes e hist\u00F3rico',
          icon: Contact,
          path: `/${slug}/admin/leads`,
          showFor: ['admin', 'superadmin'],
        },
        {
          label: 'Eventos',
          description: 'Tracking e Meta CAPI',
          icon: Activity,
          path: `/${slug}/admin/eventos`,
          showFor: ['admin', 'superadmin'],
        },
      ]
    : [];

  const companySettingsNavItem: NavItem | null = slug
    ? {
        label: 'Configura\u00E7\u00F5es',
        description: 'Hor\u00E1rios e p\u00E1gina',
        icon: Settings,
        path: `/${slug}/admin/configuracoes`,
        showFor: ['admin', 'superadmin'],
      }
    : null;

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
    return item.showFor.some((role) => activeRoles.includes(role));
  });

  const visibleManagementNavItems = companyManagementNavItems.filter((item) => {
    if (!rolesLoaded) return false;
    return item.showFor.some((role) => activeRoles.includes(role));
  });

  const visibleCompanySettingsNavItem = companySettingsNavItem && rolesLoaded
    ? companySettingsNavItem.showFor.some((role) => activeRoles.includes(role))
      ? companySettingsNavItem
      : null
    : null;

  const visibleNavItems = [
    ...visiblePrimaryNavItems,
    ...visibleManagementNavItems,
    ...(visibleCompanySettingsNavItem ? [visibleCompanySettingsNavItem] : []),
  ];

  const isNavItemActive = (item: NavItem) => {
    if (item.matchPrefix) {
      return location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
    }

    return location.pathname === item.path;
  };

  const activeNavItem = useMemo(
    () => visibleNavItems.find((item) => isNavItemActive(item)) ?? null,
    [location.pathname, visibleNavItems],
  );
  const hasCompanySettingsNav = !!visibleCompanySettingsNavItem;
  const isCompanySettingsRouteActive = visibleCompanySettingsNavItem ? isNavItemActive(visibleCompanySettingsNavItem) : false;

  const headerTitle = activeNavItem?.label || (slug ? 'Painel da unidade' : 'Painel administrativo');
  const headerDescription = activeNavItem?.description || (
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
    if (isCompanySettingsRouteActive) {
      setCompanyMenuOpen(true);
    }
  }, [isCompanySettingsRouteActive]);

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
      console.warn('Failed to audit panel access:', error);
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
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-300 lg:relative lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
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

        <nav className="flex-1 overflow-y-auto px-4 pb-4">
          {slug ? (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => {
                  if (hasCompanySettingsNav) {
                    setCompanyMenuOpen((current) => !current);
                  }
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  companyMenuOpen
                    ? 'border-primary/70 bg-primary/10 hover:bg-primary/15'
                    : 'border-sidebar-border bg-sidebar-accent/60 hover:bg-sidebar-accent',
                  hasCompanySettingsNav ? '' : 'cursor-default',
                )}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-success" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
                  {companyName}
                </span>
                {hasCompanySettingsNav && (
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 shrink-0 text-sidebar-foreground/45 transition-transform',
                      companyMenuOpen && 'rotate-180',
                    )}
                  />
                )}
              </button>

              {hasCompanySettingsNav && companyMenuOpen && (
                <div className="space-y-1">
                  {renderNavLink(visibleCompanySettingsNavItem!)}
                </div>
              )}

              <div className="space-y-2">
                <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/32">
                  Principal
                </p>
                <div className="space-y-1">
                  {visiblePrimaryNavItems.map(renderNavLink)}
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
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary/15 text-sidebar-primary">
                  <User className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-sidebar-foreground">
                    {profile.full_name || profile.email}
                  </p>
                  <p className="truncate text-xs text-sidebar-foreground/50">{profile.email}</p>
                </div>
              </div>

              <div className="mt-2 rounded-md border border-sidebar-border bg-sidebar px-2.5 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-sidebar-foreground/40">{'Sess\u00E3o atual'}</p>
                <p className="mt-0.5 text-xs text-sidebar-foreground/75">
                  {isImpersonatingCompany
                    ? `Superadmin impersonando ${formatRoleLabel(effectiveRole)}`
                    : rolesLabel}
                </p>
                {isImpersonatingCompany && (
                  <p className="truncate text-xs text-sidebar-foreground/45">
                    {impersonatedUserName || impersonatedUserEmail}
                  </p>
                )}
              </div>

              <Button
                variant="ghost"
                className="mt-2 w-full justify-start gap-2 rounded-md text-sidebar-foreground/75 hover:bg-sidebar-border hover:text-sidebar-foreground"
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
          <div className="flex flex-col gap-2 lg:min-h-[44px] lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3 lg:items-center">
              <button
                onClick={() => setMobileOpen(true)}
                aria-label="Abrir menu de navegação"
                className="mt-0.5 rounded-md border border-border bg-card p-2 text-foreground transition-colors hover:bg-muted lg:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>

              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h1 className="truncate text-base font-semibold tracking-tight text-foreground">
                    {headerTitle}
                  </h1>
                  <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    {sidebarContextLabel}
                  </span>
                  {slug && (
                    <span className="truncate rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary">
                      {companyName}
                    </span>
                  )}
                  {isImpersonatingCompany && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      {`Impersonando ${formatRoleLabel(effectiveRole)}`}
                    </span>
                  )}
                </div>

                <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground lg:hidden">
                  {headerDescription}
                </p>
                {isImpersonatingCompany && (
                  <p className="mt-1 truncate text-xs text-primary/80 lg:hidden">
                    {`${impersonatedSlug} · ${impersonatedUserName || impersonatedUserEmail}`}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
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
              {slug && <CompanyNotificationsPopover />}
              {slug && <WhatsAppStatusAlert />}
              {isImpersonatingCompany && (
                <Button variant="outline" size="sm" onClick={handleExitImpersonation}>
                  {'Sair da impersona\u00E7\u00E3o'}
                </Button>
              )}
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4 lg:px-5 lg:py-4 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
