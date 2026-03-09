import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

type AppRole = 'superadmin' | 'admin' | 'operator';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: AppRole[];
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, roles, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const hasAccess = allowedRoles.some(role => roles.includes(role));
    if (!hasAccess) {
      return <Navigate to="/acesso-negado" replace />;
    }
  }

  return <>{children}</>;
}
