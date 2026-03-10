import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, eachDayOfInterval, subDays, differenceInDays } from 'date-fns';
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
  time: string;
  status: string;
  party_size: number;
}

interface RawWaitlistEntry {
  status: string;
  created_at: string;
  seated_at: string | null;
}

export function useDashboardData(
  companyId: string | undefined,
  startDate: Date,
  endDate: Date,
) {
  const startStr = format(startDate, 'yyyy-MM-dd');
  const endStr = format(endDate, 'yyyy-MM-dd');

  // Calculate previous period range (same duration, immediately before)
  const periodDays = differenceInDays(endDate, startDate) + 1;
  const prevEndDate = subDays(startDate, 1);
  const prevStartDate = subDays(prevEndDate, periodDays - 1);
  const prevStartStr = format(prevStartDate, 'yyyy-MM-dd');
  const prevEndStr = format(prevEndDate, 'yyyy-MM-dd');

  const { data: rawReservations = [], isLoading } = useQuery({
    queryKey: ['dashboard-reservations', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, time, status')
        .gte('date', startStr)
        .lte('date', endStr);
      if (companyId) query = query.eq('company_id', companyId);
      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawReservation[];
    },
  });

  // Fetch previous period data for comparison
  const { data: prevReservations = [] } = useQuery({
    queryKey: ['dashboard-reservations-prev', companyId, prevStartStr, prevEndStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, time, status')
        .gte('date', prevStartStr)
        .lte('date', prevEndStr);
      if (companyId) query = query.eq('company_id', companyId);
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

  // Previous period totals for comparison
  const prevTotals = useMemo(() => {
    const acc = { reservations: 0, completed: 0, confirmed: 0, pending: 0, cancellations: 0, noShows: 0 };
    for (const r of prevReservations) {
      acc.reservations++;
      if (r.status === 'completed') acc.completed++;
      else if (r.status === 'confirmed') acc.confirmed++;
      else if (r.status === 'pending') acc.pending++;
      else if (r.status === 'cancelled') acc.cancellations++;
      else if (r.status === 'no-show') acc.noShows++;
    }
    return acc;
  }, [prevReservations]);

  // Heatmap
  const heatmapData = useMemo(() => {
    const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const counts: Record<string, number> = {};
    let maxCount = 0;
    for (const r of rawReservations) {
      if (r.status === 'cancelled') continue;
      const dayOfWeek = new Date(r.date + 'T12:00:00').getDay();
      const hour = r.time?.slice(0, 5) || '00:00';
      const key = `${dayOfWeek}_${hour}`;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > maxCount) maxCount = counts[key];
    }
    const hours = [...new Set(rawReservations.map(r => r.time?.slice(0, 5)).filter(Boolean))].sort();
    return { counts, maxCount, hours, dayNames: DAY_NAMES };
  }, [rawReservations]);

  return { dailyStats, totals, prevTotals, heatmapData, isLoading };
}
