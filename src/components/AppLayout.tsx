import { ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, UtensilsCrossed, Grid3X3, Menu, Building2, LogOut, User, Settings, Users, BarChart3, Bot, Contact, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { useSystemSettings } from '@/hooks/useSettings';

type AppRole = 'superadmin' | 'admin' | 'operator';

interface NavItem {
  label: string;
  icon: any;
  path: string;
  showFor: AppRole[];
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { profile, roles, loading, signOut } = useAuth();
  const { data: systemSettings = [] } = useSystemSettings();
  const systemName = systemSettings.find(s => s.key === 'system_name')?.value || 'ReservaFácil';
  const systemLogo = systemSettings.find(s => s.key === 'system_logo_url')?.value || '';

  const isSuperadmin = roles.includes('superadmin');
  const rolesLoaded = !loading && roles.length > 0;

  // Build nav items dynamically based on whether we're in a slug context
  // In slug context: only show company items. Outside: only superadmin items.
  const companyNavItems: NavItem[] = slug
    ? [
        { label: 'Dashboard', icon: LayoutDashboard, path: `/${slug}/admin`, showFor: ['admin', 'operator', 'superadmin'] },
        { label: 'Reservas', icon: CalendarDays, path: `/${slug}/admin/reservas`, showFor: ['admin', 'operator', 'superadmin'] },
        { label: 'Mesas', icon: Grid3X3, path: `/${slug}/admin/mesas`, showFor: ['admin', 'operator', 'superadmin'] },
        { label: 'Calendário', icon: CalendarDays, path: `/${slug}/admin/calendario`, showFor: ['admin', 'operator', 'superadmin'] },
        { label: 'Lista de Espera', icon: ClipboardList, path: `/${slug}/admin/fila`, showFor: ['admin', 'operator', 'superadmin'] },
        { label: 'Automações', icon: Bot, path: `/${slug}/admin/automacoes`, showFor: ['admin', 'superadmin'] },
        
        { label: 'Usuários', icon: Users, path: `/${slug}/admin/usuarios`, showFor: ['admin', 'superadmin'] },
        { label: 'Leads', icon: Contact, path: `/${slug}/admin/leads`, showFor: ['admin', 'superadmin'] },
        { label: 'Configurações', icon: Settings, path: `/${slug}/admin/configuracoes`, showFor: ['admin', 'superadmin'] },
      ]
    : [];

  const superadminNavItems: NavItem[] = !slug
    ? [
        { label: 'Dashboard', icon: BarChart3, path: '/dashboard', showFor: ['superadmin'] },
        { label: 'Empresas', icon: Building2, path: '/empresas', showFor: ['superadmin'] },
        { label: 'Usuários', icon: Users, path: '/usuarios', showFor: ['superadmin'] },
        { label: 'Configurações', icon: Settings, path: '/configuracoes', showFor: ['superadmin'] },
      ]
    : [];

  const allNavItems = [...companyNavItems, ...superadminNavItems];

  const visibleNavItems = allNavItems.filter(item => {
    if (!rolesLoaded) return false;
    return (item.showFor as AppRole[]).some(r => roles.includes(r));
  });

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground flex flex-col transition-transform duration-300 lg:relative lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center gap-3 px-6 py-6 border-b border-sidebar-border">
          {systemLogo ? (
            <img src={systemLogo} alt={systemName} className="h-7 w-7 object-contain" />
          ) : (
            <UtensilsCrossed className="h-7 w-7 text-sidebar-primary" />
          )}
          <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
            {systemName}
          </h1>
        </div>

        {slug && (
          <div className="px-6 py-3 border-b border-sidebar-border">
            <p className="text-xs text-sidebar-foreground/50 uppercase tracking-wider">Unidade</p>
            <p className="text-sm font-semibold text-sidebar-primary truncate">{slug}</p>
          </div>
        )}

        <nav className="flex-1 px-3 py-4 space-y-1">
          {visibleNavItems.map(item => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-primary"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 space-y-3">
          {profile && (
            <div className="flex items-center gap-3 px-4 py-2">
              <div className="p-2 rounded-lg bg-sidebar-accent">
                <User className="h-4 w-4 text-sidebar-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{profile.full_name || profile.email}</p>
                <p className="text-xs text-sidebar-foreground/50 capitalize">
                  {roles.length > 0 ? roles.join(', ') : 'Sem role'}
                </p>
              </div>
            </div>
          )}
          <Button
            variant="ghost"
            className="w-full justify-start gap-3 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4" />
            Sair
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center gap-4 px-6 py-4 border-b border-border bg-card lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="p-2 rounded-lg hover:bg-muted">
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-bold" style={{ fontFamily: 'var(--font-display)' }}>{systemName}</h1>
        </header>
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
