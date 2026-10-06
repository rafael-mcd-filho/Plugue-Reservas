import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const {
    isImpersonatingCompany, effectiveRoles, impersonationLoading,
    impersonationError, retryImpersonation,
  } = useImpersonation();
  const {
    hasPermission, permissionsLoading, permissionsRecoverableError,
    permissionsAuthorizationError, retryPermissions,
  } = useCompanyPermissions();
  const location = useLocation();
  const locationState = location.state as PostLoginNavigationState | null;

  if (!loading && user && (impersonationError || permissionsRecoverableError)) {
    const retry = impersonationError ? retryImpersonation : retryPermissions;
    return <div role="alert" className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-4 rounded-lg border bg-card p-8 text-center">
        <p className="font-medium">Não foi possível validar o acesso à empresa agora.</p>
        <p className="text-sm text-muted-foreground">Tente novamente para retomar a impersonação.</p>
        <Button variant="outline" onClick={() => { void retry(); }}>Tentar novamente</Button>
      </div>
    </div>;
  }

  if (loading || permissionsLoading || impersonationLoading) {
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

  if (permissionsAuthorizationError) {
    return <Navigate to={locationState?.fromLogin ? '/' : '/acesso-negado'} replace />;
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

  }

  if (requiredCompanyPermission && !hasPermission(requiredCompanyPermission)) {
    if (locationState?.fromLogin) {
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/acesso-negado" replace />;
  }

  return <>{children}</>;
}
