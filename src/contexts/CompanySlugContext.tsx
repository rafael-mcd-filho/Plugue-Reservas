import { createContext, useContext, ReactNode, useMemo } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface CompanySlugContextType {
  slug: string;
  companyId: string;
  companyName: string;
}

const CompanySlugContext = createContext<CompanySlugContextType | undefined>(undefined);

export function CompanySlugProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const { profile, roles, loading: authLoading } = useAuth();

  const { data: company, isLoading, error } = useQuery({
    queryKey: ['company-by-slug', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('id, name, slug, status')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!slug,
  });

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !company) {
    return <Navigate to="/acesso-negado" replace />;
  }

  // Check access: superadmin can access any company, others only their own
  const isSuperadmin = roles.includes('superadmin');
  if (!isSuperadmin && profile?.company_id !== company.id) {
    return <Navigate to="/acesso-negado" replace />;
  }

  return (
    <CompanySlugContext.Provider value={{ slug: company.slug, companyId: company.id, companyName: company.name }}>
      {children}
    </CompanySlugContext.Provider>
  );
}

export function useCompanySlug() {
  const context = useContext(CompanySlugContext);
  if (!context) throw new Error('useCompanySlug must be used within CompanySlugProvider');
  return context;
}
