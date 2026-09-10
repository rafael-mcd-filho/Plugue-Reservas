import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface CompanyNpsActivation {
  company_id: string;
  enabled: boolean;
}

export function useCompanyNpsActivation(companyId?: string) {
  return useQuery<CompanyNpsActivation | null>({
    queryKey: ['company-nps-activation', companyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('company_nps_configs')
        .select('company_id, enabled')
        .eq('company_id', companyId!)
        .maybeSingle();

      if (error) throw error;
      return (data ?? null) as CompanyNpsActivation | null;
    },
    enabled: !!companyId,
  });
}
