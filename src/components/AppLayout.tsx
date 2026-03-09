import { ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, UtensilsCrossed, Grid3X3, Menu, Building2, LogOut, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

type AppRole = 'superadmin' | 'admin' | 'operator';

interface NavItem {
  label: string;
  icon: any;
  path: string;
  showFor: AppRole[] | 'all-except-superadmin';
}

const navItems: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/', showFor: 'all-except-superadmin' },
  { label: 'Reservas', icon: CalendarDays, path: '/reservas', showFor: 'all-except-superadmin' },
  { label: 'Mesas', icon: Grid3X3, path: '/mesas', showFor: 'all-except-superadmin' },
  { label: 'Calendário', icon: CalendarDays, path: '/calendario', showFor: 'all-except-superadmin' },
  { label: 'Empresas', icon: Building2, path: '/empresas', showFor: ['superadmin'] },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { profile, roles, loading, signOut } = useAuth();

  const isSuperadmin = roles.includes('superadmin');

  const visibleNavItems = navItems.filter(item => {
    if (item.showFor === 'all-except-superadmin') {
      return !isSuperadmin;
    }
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
          <UtensilsCrossed className="h-7 w-7 text-sidebar-primary" />
          <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
            Reserva<span className="text-sidebar-primary">Fácil</span>
          </h1>
        </div>

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
          <h1 className="text-lg font-bold" style={{ fontFamily: 'var(--font-display)' }}>ReservaFácil</h1>
        </header>
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
