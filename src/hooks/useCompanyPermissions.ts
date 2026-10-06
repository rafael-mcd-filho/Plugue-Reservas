import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { supabase } from '@/integrations/supabase/client';
import { resolveCompanyPanelPermissions, type CompanyPanelPermission } from '@/lib/companyPermissions';
import { isAuthorizationFailure } from '@/lib/authorizationFailure';

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
    isSupport,
    impersonationLoading,
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
    () => readCachedPermissionOverrides(shouldLoadOverrides && !isSupport ? cacheKey : null),
    [cacheKey, shouldLoadOverrides, isSupport],
  );

  const {
    data: permissionOverrides,
    error: permissionsError,
    isLoading: permissionsLoading,
    refetch: retryPermissions,
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
      const row = data as unknown as { permission_overrides?: Partial<Record<CompanyPanelPermission, boolean>> } | null;
      return row?.permission_overrides ?? null;
    },
    enabled: shouldLoadOverrides,
    initialData: shouldLoadOverrides ? cachedPermissionOverrides : undefined,
    initialDataUpdatedAt: shouldLoadOverrides && cachedPermissionOverrides !== undefined ? 0 : undefined,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: isSupport ? 15000 : false,
    // Nested guards mount after the outer guard finishes loading. Retrying a
    // failed read on each mount would make the outer guard unmount them again.
    retryOnMount: !isSupport,
  });

  useEffect(() => {
    if (!shouldLoadOverrides) return;
    if (permissionOverrides === undefined) return;
    writeCachedPermissionOverrides(cacheKey, permissionOverrides);
  }, [cacheKey, permissionOverrides, shouldLoadOverrides]);

  const effectivePermissionOverrides = permissionOverrides ?? cachedPermissionOverrides ?? null;
  const permissions = useMemo(
    () => resolveCompanyPanelPermissions(isSupport && permissionsError ? [] : activeRoles, effectivePermissionOverrides),
    [activeRoles, effectivePermissionOverrides, isSupport, permissionsError],
  );

  const hasPermission = (permission: CompanyPanelPermission) => permissions.has(permission);

  return {
    activeRoles,
    permissions,
    permissionOverrides: effectivePermissionOverrides,
    permissionsError,
    permissionsRecoverableError: isSupport && shouldLoadOverrides && permissionsError
      && !isAuthorizationFailure(permissionsError) ? permissionsError : null,
    permissionsAuthorizationError: isSupport && shouldLoadOverrides && permissionsError
      && isAuthorizationFailure(permissionsError) ? permissionsError : null,
    retryPermissions,
    permissionsLoading: permissionsLoading || impersonationLoading,
    hasPermission,
    isImpersonatingCompany,
    activeCompanyId,
  };
}
