import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { getCompanyPanelEntryPath } from '@/lib/companyPanelEntry';

export default function CompanyPanelEntryRoute({
  children,
  loadingFallback,
}: {
  children: ReactNode;
  loadingFallback: ReactNode;
}) {
  const { slug } = useParams<{ slug: string }>();
  const { hasPermission, permissionsLoading } = useCompanyPermissions();

  if (permissionsLoading) return <>{loadingFallback}</>;

  const entryPath = slug ? getCompanyPanelEntryPath(slug, hasPermission) : null;
  if (!entryPath) return <Navigate to="/acesso-negado" replace />;
  if (entryPath !== `/${slug}/admin`) return <Navigate to={entryPath} replace />;

  return <>{children}</>;
}
