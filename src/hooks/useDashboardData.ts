import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, eachDayOfInterval } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useMemo } from 'react';

export interface DailyStats {
  date: string;
  label: string;
  reservations: number;
  completed: number;
  confirmed: number;
  pending: number;
  cancellations: number;
  noShows: number;
}

interface RawReservation {
  date: string;
  status: string;
}

export function useDashboardData(
  companyId: string | undefined,
  startDate: Date,
  endDate: Date,
) {
  const startStr = format(startDate, 'yyyy-MM-dd');
  const endStr = format(endDate, 'yyyy-MM-dd');

  const { data: rawReservations = [], isLoading } = useQuery({
    queryKey: ['dashboard-reservations', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, status')
        .gte('date', startStr)
        .lte('date', endStr);

      if (companyId) {
        query = query.eq('company_id', companyId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawReservation[];
    },
  });

  const dailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, RawReservation[]> = {};
    for (const r of rawReservations) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    }

    return days.map((day): DailyStats => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayRes = byDate[dateStr] || [];
      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        reservations: dayRes.length,
        completed: dayRes.filter(r => r.status === 'completed').length,
        confirmed: dayRes.filter(r => r.status === 'confirmed').length,
        pending: dayRes.filter(r => r.status === 'pending').length,
        cancellations: dayRes.filter(r => r.status === 'cancelled').length,
        noShows: dayRes.filter(r => r.status === 'no-show').length,
      };
    });
  }, [rawReservations, startDate, endDate]);

  const totals = useMemo(() => {
    return dailyStats.reduce(
      (acc, d) => ({
        reservations: acc.reservations + d.reservations,
        completed: acc.completed + d.completed,
        confirmed: acc.confirmed + d.confirmed,
        pending: acc.pending + d.pending,
        cancellations: acc.cancellations + d.cancellations,
        noShows: acc.noShows + d.noShows,
      }),
      { reservations: 0, completed: 0, confirmed: 0, pending: 0, cancellations: 0, noShows: 0 },
    );
  }, [dailyStats]);

  return { dailyStats, totals, isLoading };
}
