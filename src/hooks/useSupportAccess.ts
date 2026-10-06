import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

export interface SupportCompany {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'paused';
}

export interface SupportCandidate {
  user_id: string;
  full_name: string;
  email: string;
  effective_role: 'admin' | 'operator';
}

export interface SupportDashboardSummary {
  companyCount: number;
  reservationCount: number;
  confirmedCount: number;
  checkedInCount: number;
  cancelledCount: number;
  noShowCount: number;
  totalGuests: number;
}

export function useSupportCompanies() {
  const { user, roles } = useAuth();
  return useQuery({
    queryKey: ['support-companies', user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('support_list_companies');
      if (error) throw error;
      return (data ?? []) as SupportCompany[];
    },
    enabled: !!user && roles.includes('support'),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 30000,
  });
}

export function useSupportCandidates(companyId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['support-candidates', user?.id, companyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('support_list_impersonation_candidates', { _company_id: companyId });
      if (error) throw error;
      return (data ?? []) as SupportCandidate[];
    },
    enabled: !!companyId,
    retry: false,
  });
}

export function useSupportDashboard(companyId: string | null, startDate: string, endDate: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['support-dashboard', user?.id, companyId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('support_dashboard', {
        _company_id: companyId, _start_date: startDate, _end_date: endDate,
      });
      if (error) throw error;
      return data as SupportDashboardSummary;
    },
    retry: false,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
}
