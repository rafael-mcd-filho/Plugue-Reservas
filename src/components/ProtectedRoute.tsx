import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { Loader2 } from 'lucide-react';
import type { PostLoginNavigationState } from '@/pages/Login';
import {
  type AppRole,
  type CompanyPanelPermission,
} from '@/lib/companyPermissions';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: AppRole[];
  requiredCompanyPermission?: CompanyPanelPermission;
}

export default function ProtectedRoute({ children, allowedRoles, requiredCompanyPermission }: ProtectedRouteProps) {
  const { user, roles, loading } = useAuth();
  const { isImpersonatingCompany, effectiveRoles } = useImpersonation();
  const { hasPermission, permissionsLoading } = useCompanyPermissions();
  const location = useLocation();
  const locationState = location.state as PostLoginNavigationState | null;

  if (loading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    const redirectTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/login" replace state={{ redirectTo }} />;
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const activeRoles = isImpersonatingCompany ? effectiveRoles : roles;
    const hasAccess = allowedRoles.some(role => activeRoles.includes(role));
    if (!hasAccess) {
      if (locationState?.fromLogin) {
        return <Navigate to="/" replace />;
      }
      return <Navigate to="/acesso-negado" replace />;
    }

    if (requiredCompanyPermission && !hasPermission(requiredCompanyPermission)) {
      if (locationState?.fromLogin) {
        return <Navigate to="/" replace />;
      }
      return <Navigate to="/acesso-negado" replace />;
    }
  }

  return <>{children}</>;
}
