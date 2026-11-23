import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Último acesso ao painel de cada pessoa, a partir do histórico de acessos
 * (access_audit_logs). Consulta só as pessoas da página aberta. Na ficha de
 * uma empresa, o escopo impede atribuir a ela acessos a outra unidade.
 */
export function useLastPanelAccess(userIds: string[], companyId?: string) {
  const ids = [...new Set(userIds)].sort();
  return useQuery({
    queryKey: ['last-panel-access', ids, companyId ?? null],
    queryFn: async () => {
      const entries = await Promise.all(ids.map(async (userId) => {
        let query = supabase
          .from('access_audit_logs' as any)
          .select('created_at')
          .eq('user_id', userId)
          .eq('event_type', 'panel_access');
        if (companyId) query = query.eq('company_id', companyId);
        const { data, error } = await query
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) throw error;
        const row = (data as unknown as Array<{ created_at: string }> | null)?.[0];
        return [userId, row?.created_at ?? null] as const;
      }));
      return Object.fromEntries(entries) as Record<string, string | null>;
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}
