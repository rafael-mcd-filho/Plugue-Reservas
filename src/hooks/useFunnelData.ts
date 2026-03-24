import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';

interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

export function useFunnelData(companyId?: string, startDate?: Date, endDate?: Date) {
  return useQuery<FunnelDataPoint[]>({
    queryKey: ['funnel-data', companyId, startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      let query = supabase
        .from('reservation_funnel_logs' as any)
        .select('step, visitor_id');

      if (companyId && companyId !== 'all') {
        query = query.eq('company_id', companyId);
      }

      if (startDate instanceof Date && !Number.isNaN(startDate.getTime())) {
        query = query.gte('date', startDate.toISOString().split('T')[0]);
      }
      if (endDate instanceof Date && !Number.isNaN(endDate.getTime())) {
        query = query.lte('date', endDate.toISOString().split('T')[0]);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[FunnelData] Query error:', error.message ?? error);
        throw error;
      }

      const rows = (data ?? []) as { step: string; visitor_id: string }[];

      // Conta visitantes únicos por etapa
      return FUNNEL_STEPS.map((step) => {
        const uniqueVisitors = new Set(
          rows.filter((r) => r.step === step).map((r) => r.visitor_id),
        );
        return { step, count: uniqueVisitors.size };
      });
    },
    // Só executa quando há algum companyId definido (evita query desnecessária)
    enabled: companyId !== undefined,
    // Atualiza a cada 30s, mas não quando a aba está oculta (economiza bateria)
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
