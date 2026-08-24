import { createContext, useContext, ReactNode } from 'react';
import { useParams, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { isValidCompanySlug } from '@/lib/validation';
import { Loader2 } from 'lucide-react';
import type { PostLoginNavigationState } from '@/pages/Login';

interface CompanySlugContextType {
  slug: string;
  companyId: string;
  companyName: string;
  companyLogoUrl: string | null;
  companyTimeZone: string;
  companyTimeZoneAvailable: boolean;
  companyTimeZoneResolved: boolean;
}

interface CompanySlugRecord {
  id: string;
  name: string;
  slug: string;
  logo_url?: string | null;
  time_zone?: string;
}

interface CompanySlugQueryResult {
  company: CompanySlugRecord | null;
  timeZoneResolution: 'pending' | 'database' | 'legacy-default';
}

const CompanySlugContext = createContext<CompanySlugContextType | undefined>(undefined);

export function CompanySlugProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { slug } = useParams<{ slug: string }>();
  const { profile, roles, loading: authLoading } = useAuth();
  const {
    isImpersonatingCompany,
    impersonatedCompanyId,
    impersonatedCompanyName,
    impersonatedSlug,
  } = useImpersonation();
  const slugIsValid = isValidCompanySlug(slug);
  const locationState = location.state as PostLoginNavigationState | null;
  const impersonatedCompany = isImpersonatingCompany
    && slugIsValid
    && slug === impersonatedSlug
    && impersonatedCompanyId
    && impersonatedCompanyName
    ? {
        id: impersonatedCompanyId,
        name: impersonatedCompanyName,
        slug: impersonatedSlug,
      }
    : null;

  const { data: companyQuery, isLoading } = useQuery<CompanySlugQueryResult>({
    // The suffix prevents a legacy object cached by an earlier app version
    // from being mistaken for a confirmed timezone resolution after HMR.
    queryKey: ['company-by-slug', slug, 'time-zone-v2'],
    queryFn: async () => {
      const currentSchemaResult = await supabase
        .from('companies' as any)
        .select('id, name, slug, logo_url, time_zone')
        .eq('slug', slug!)
        .maybeSingle();

      if (!currentSchemaResult.error) {
        return {
          company: currentSchemaResult.data as CompanySlugRecord | null,
          timeZoneResolution: 'database' as const,
        };
      }

      const errorMessage = String(currentSchemaResult.error.message ?? '').toLowerCase();
      const missingTimeZoneColumn = errorMessage.includes('time_zone')
        && (
          currentSchemaResult.error.code === '42703'
          || currentSchemaResult.error.code === 'PGRST204'
        );

      if (!missingTimeZoneColumn) throw currentSchemaResult.error;

      // Keep local development compatible with the current production schema
      // until the report foundation migration is intentionally deployed.
      const legacySchemaResult = await supabase
        .from('companies' as any)
        .select('id, name, slug, logo_url')
        .eq('slug', slug!)
        .maybeSingle();

      if (legacySchemaResult.error) throw legacySchemaResult.error;
      return {
        company: legacySchemaResult.data as CompanySlugRecord | null,
        timeZoneResolution: 'legacy-default' as const,
      };
    },
    enabled: slugIsValid,
    initialData: impersonatedCompany
      ? {
          company: impersonatedCompany,
          timeZoneResolution: 'pending',
        }
      : undefined,
    initialDataUpdatedAt: impersonatedCompany ? 0 : undefined,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const company = companyQuery?.company ?? null;

  const companyTimeZoneAvailable = companyQuery?.timeZoneResolution === 'database'
    && typeof company?.time_zone === 'string'
    && company.time_zone.trim().length > 0;
  const companyTimeZoneResolved = !!company && (
    companyTimeZoneAvailable
    || companyQuery?.timeZoneResolution === 'legacy-default'
  );

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // A transient refetch/schema error must not invalidate a company that was
  // already established by the authenticated impersonation or query cache.
  // Child queries and route guards still enforce authorization server-side.
  if (!slugIsValid || !company) {
    if (locationState?.fromLogin) {
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/acesso-negado" replace />;
  }

  // Check access: superadmin can access any company, others only their own
  const isSuperadmin = roles.includes('superadmin');
  if (isSuperadmin && (!isImpersonatingCompany || impersonatedCompanyId !== company.id)) {
    if (locationState?.fromLogin) {
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/empresas" replace />;
  }

  if (!isSuperadmin && profile?.company_id !== company.id) {
    if (locationState?.fromLogin) {
      return <Navigate to="/" replace />;
    }
    return <Navigate to="/acesso-negado" replace />;
  }

  return (
    <CompanySlugContext.Provider value={{
      slug: company.slug,
      companyId: company.id,
      companyName: company.name,
      companyLogoUrl: company.logo_url ?? null,
      companyTimeZone: companyTimeZoneAvailable
        ? company.time_zone!
        : 'America/Fortaleza',
      companyTimeZoneAvailable,
      companyTimeZoneResolved,
    }}>
      {children}
    </CompanySlugContext.Provider>
  );
}

export function useCompanySlug() {
  const context = useContext(CompanySlugContext);
  if (!context) throw new Error('useCompanySlug must be used within CompanySlugProvider');
  return context;
}

export function useMaybeCompanySlug() {
  return useContext(CompanySlugContext);
}
