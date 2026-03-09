import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';

interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

export function useFunnelData(companyId?: string, startDate?: Date, endDate?: Date) {
  return useQuery({
    queryKey: ['funnel-data', companyId, startDate?.toISOString(), endDate?.toISOString()],
    queryFn: async () => {
      let query = supabase
        .from('reservation_funnel_logs' as any)
        .select('step, visitor_id');

      if (companyId && companyId !== 'all') {
        query = query.eq('company_id', companyId);
      }

      if (startDate) {
        query = query.gte('date', startDate.toISOString().split('T')[0]);
      }
      if (endDate) {
        query = query.lte('date', endDate.toISOString().split('T')[0]);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = (data as any[]) || [];
      
      // Count unique visitors per step
      const result: FunnelDataPoint[] = FUNNEL_STEPS.map(step => {
        const uniqueVisitors = new Set(
          rows.filter((r: any) => r.step === step).map((r: any) => r.visitor_id)
        );
        return { step, count: uniqueVisitors.size };
      });

      return result;
    },
    enabled: true,
  });
}
