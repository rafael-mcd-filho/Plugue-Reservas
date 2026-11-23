import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAuditLogPage } from '@/hooks/useAuditLogPage';
import { getSettlementOverview } from '@/lib/reservation-settlements-api';

export interface CompanyAccessEvent {
  id: string;
  user_id: string | null;
  event_type: 'login' | 'panel_access' | string;
  path: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** Saldos, taxas e pedidos de saque da empresa (mesma raiz invalidada pelos repasses). */
export function useCompanySettlement(companyId: string | undefined) {
  return useQuery({
    queryKey: ['reservation-settlements', companyId, 'company-detail'],
    queryFn: () => getSettlementOverview(companyId!),
    enabled: !!companyId,
    retry: false,
  });
}

/** Acessos ao painel e ações da auditoria ligadas à empresa, os mais recentes primeiro. */
export function useCompanyHistory(companyId: string | undefined) {
  return useQuery({
    queryKey: ['company-history', companyId],
    queryFn: async () => {
      const [accessResult, auditResult] = await Promise.all([
        supabase
          .from('access_audit_logs' as any)
          .select('id, user_id, event_type, path, created_at, metadata')
          .eq('company_id', companyId!)
          .order('created_at', { ascending: false })
          .limit(300),
        fetchAuditLogPage({
          page: 1,
          pageSize: 40,
          days: null,
          category: null,
          companyId: companyId!,
          actorId: null,
          search: '',
        }),
      ]);
      if (accessResult.error) throw accessResult.error;
      return {
        access: (accessResult.data ?? []) as unknown as CompanyAccessEvent[],
        audit: auditResult.logs,
        auditTotal: auditResult.total,
      };
    },
    enabled: !!companyId,
    retry: false,
  });
}
