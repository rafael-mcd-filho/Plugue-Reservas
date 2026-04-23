import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { supabase } from '@/integrations/supabase/client';
import { resolveCompanyPanelPermissions, type CompanyPanelPermission } from '@/lib/companyPermissions';

const COMPANY_PANEL_PERMISSION_CACHE_KEY_PREFIX = 'company-panel-permission-overrides';

function getCompanyPermissionCacheKey(companyId: string | null, userId: string | null) {
  if (!companyId || !userId) return null;
  return `${COMPANY_PANEL_PERMISSION_CACHE_KEY_PREFIX}:${companyId}:${userId}`;
}

function isPermissionOverrideRecord(value: unknown): value is Partial<Record<CompanyPanelPermission, boolean>> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readCachedPermissionOverrides(cacheKey: string | null) {
  if (!cacheKey || typeof window === 'undefined') return undefined;

  const raw = window.sessionStorage.getItem(cacheKey);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || isPermissionOverrideRecord(parsed)) {
      return parsed as Partial<Record<CompanyPanelPermission, boolean>> | null;
    }
  } catch {
    // Ignore stale cache and fall through to a clean miss.
  }

  window.sessionStorage.removeItem(cacheKey);
  return undefined;
}

function writeCachedPermissionOverrides(
  cacheKey: string | null,
  overrides: Partial<Record<CompanyPanelPermission, boolean>> | null,
) {
  if (!cacheKey || typeof window === 'undefined') return;
  window.sessionStorage.setItem(cacheKey, JSON.stringify(overrides));
}

export function useCompanyPermissions() {
  const { user, profile, roles } = useAuth();
  const companyContext = useMaybeCompanySlug();
  const {
    isImpersonatingCompany,
    effectiveRoles,
    impersonatedUserId,
    scopeCompanyId,
  } = useImpersonation();

  const activeRoles = isImpersonatingCompany ? effectiveRoles : roles;
  const activeCompanyId = isImpersonatingCompany
    ? scopeCompanyId
    : companyContext?.companyId ?? profile?.company_id ?? null;
  const targetUserId = isImpersonatingCompany ? impersonatedUserId : user?.id ?? null;
  const shouldLoadOverrides = !!activeCompanyId
    && !!targetUserId
    && activeRoles.includes('operator')
    && !activeRoles.includes('admin')
    && !activeRoles.includes('superadmin');
  const cacheKey = getCompanyPermissionCacheKey(activeCompanyId, targetUserId);
  const cachedPermissionOverrides = useMemo(
    () => readCachedPermissionOverrides(shouldLoadOverrides ? cacheKey : null),
    [cacheKey, shouldLoadOverrides],
  );

  const {
    data: permissionOverrides,
    error: permissionsError,
    isLoading: permissionsLoading,
  } = useQuery({
    queryKey: ['company-panel-permission-overrides', activeCompanyId, targetUserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_user_panel_permissions' as any)
        .select('permission_overrides')
        .eq('company_id', activeCompanyId!)
        .eq('user_id', targetUserId!)
        .maybeSingle();

      if (error) throw error;
      return (data?.permission_overrides ?? null) as Partial<Record<CompanyPanelPermission, boolean>> | null;
    },
    enabled: shouldLoadOverrides,
    initialData: shouldLoadOverrides ? cachedPermissionOverrides : undefined,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!shouldLoadOverrides) return;
    if (permissionOverrides === undefined) return;
    writeCachedPermissionOverrides(cacheKey, permissionOverrides);
  }, [cacheKey, permissionOverrides, shouldLoadOverrides]);

  const effectivePermissionOverrides = permissionOverrides ?? cachedPermissionOverrides ?? null;
  const permissions = useMemo(
    () => resolveCompanyPanelPermissions(activeRoles, effectivePermissionOverrides),
    [activeRoles, effectivePermissionOverrides],
  );

  const hasPermission = (permission: CompanyPanelPermission) => permissions.has(permission);

  return {
    activeRoles,
    permissions,
    permissionOverrides: effectivePermissionOverrides,
    permissionsError,
    permissionsLoading,
    hasPermission,
    isImpersonatingCompany,
    activeCompanyId,
  };
}
