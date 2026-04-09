import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { differenceInCalendarDays, differenceInDays, eachDayOfInterval, endOfDay, format, startOfDay, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface DailyStats {
  date: string;
  label: string;
  reservations: number;
  scheduledReservations: number;
  waitlistReservations: number;
  completed: number;
  scheduledCompleted: number;
  waitlistCompleted: number;
  confirmed: number;
  cancellations: number;
  noShows: number;
}

interface RawReservation {
  date: string;
  time: string | null;
  status: string | null;
  party_size: number | null;
  created_at: string;
  source: string | null;
}

interface RawWaitlistEntry {
  status: string;
  created_at: string;
  seated_at: string | null;
  expired_at: string | null;
  removed_at: string | null;
}

const EMPTY_RESERVATIONS: RawReservation[] = [];
const EMPTY_WAITLIST: RawWaitlistEntry[] = [];

export interface CreatedReservationDailyStat {
  date: string;
  label: string;
  createdReservations: number;
  scheduledCreatedReservations: number;
  waitlistCreatedReservations: number;
}

export interface ReservationLeadTrendPoint {
  date: string;
  label: string;
  createdReservations: number;
  avgLeadDays: number;
  sameDayReservations: number;
}

export interface WaitlistDailyStat {
  date: string;
  label: string;
  entries: number;
  seated: number;
  dropped: number;
}

export interface HeatmapCellBreakdown {
  total: number;
  scheduled: number;
  waitlist: number;
}

function normalizeReservationSource(source: string | null | undefined) {
  return source === 'waitlist' ? 'waitlist' : 'reservation';
}

export function useDashboardData(
  companyId: string | undefined,
  startDate: Date,
  endDate: Date,
) {
  const startStr = format(startDate, 'yyyy-MM-dd');
  const endStr = format(endDate, 'yyyy-MM-dd');
  const rangeStartIso = startOfDay(startDate).toISOString();
  const rangeEndIso = endOfDay(endDate).toISOString();

  const periodDays = differenceInDays(endDate, startDate) + 1;
  const prevEndDate = subDays(startDate, 1);
  const prevStartDate = subDays(prevEndDate, periodDays - 1);
  const prevStartStr = format(prevStartDate, 'yyyy-MM-dd');
  const prevEndStr = format(prevEndDate, 'yyyy-MM-dd');

  const reservationsQuery = useQuery({
    queryKey: ['dashboard-reservations', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, time, status, party_size, created_at, source')
        .gte('date', startStr)
        .lte('date', endStr);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawReservation[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistQuery = useQuery({
    queryKey: ['dashboard-waitlist', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('waitlist' as any)
        .select('status, created_at, seated_at, expired_at, removed_at')
        .gte('created_at', rangeStartIso)
        .lte('created_at', rangeEndIso);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawWaitlistEntry[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistSeatedQuery = useQuery({
    queryKey: ['dashboard-waitlist-seated', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('waitlist' as any)
        .select('status, created_at, seated_at, expired_at, removed_at')
        .eq('status', 'seated')
        .gte('seated_at', rangeStartIso)
        .lte('seated_at', rangeEndIso);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawWaitlistEntry[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistDroppedQuery = useQuery({
    queryKey: ['dashboard-waitlist-dropped', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('waitlist' as any)
        .select('status, created_at, seated_at, expired_at, removed_at')
        .in('status', ['expired', 'removed'])
        .or(`and(status.eq.expired,expired_at.gte.${rangeStartIso},expired_at.lte.${rangeEndIso}),and(status.eq.removed,removed_at.gte.${rangeStartIso},removed_at.lte.${rangeEndIso})`);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawWaitlistEntry[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const previousReservationsQuery = useQuery({
    queryKey: ['dashboard-reservations-prev', companyId, prevStartStr, prevEndStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, time, status, party_size, created_at, source')
        .gte('date', prevStartStr)
        .lte('date', prevEndStr);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawReservation[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const createdReservationsQuery = useQuery({
    queryKey: ['dashboard-reservations-created', companyId, startStr, endStr],
    queryFn: async () => {
      let query = supabase
        .from('reservations' as any)
        .select('date, time, status, party_size, created_at, source')
        .gte('created_at', rangeStartIso)
        .lte('created_at', rangeEndIso);

      if (companyId) query = query.eq('company_id', companyId);

      const { data, error } = await query;
      if (error) throw error;
      return (data as any[]) as RawReservation[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const rawReservations = reservationsQuery.data ?? EMPTY_RESERVATIONS;
  const rawWaitlist = waitlistQuery.data ?? EMPTY_WAITLIST;
  const rawWaitlistSeated = waitlistSeatedQuery.data ?? EMPTY_WAITLIST;
  const rawWaitlistDropped = waitlistDroppedQuery.data ?? EMPTY_WAITLIST;
  const prevReservations = previousReservationsQuery.data ?? EMPTY_RESERVATIONS;
  const createdReservations = createdReservationsQuery.data ?? EMPTY_RESERVATIONS;

  const dailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, Omit<DailyStats, 'date' | 'label'>> = {};

    for (const reservation of rawReservations) {
      const normalizedStatus = normalizeReservationStatus(reservation.status);
      const normalizedSource = normalizeReservationSource(reservation.source);
      if (!byDate[reservation.date]) {
        byDate[reservation.date] = {
          reservations: 0,
          scheduledReservations: 0,
          waitlistReservations: 0,
          completed: 0,
          scheduledCompleted: 0,
          waitlistCompleted: 0,
          confirmed: 0,
          cancellations: 0,
          noShows: 0,
        };
      }

      const dayStats = byDate[reservation.date];
      dayStats.reservations += 1;
      if (normalizedSource === 'waitlist') {
        dayStats.waitlistReservations += 1;
      } else {
        dayStats.scheduledReservations += 1;
      }

      if (normalizedStatus === 'checked_in') {
        dayStats.completed += 1;
        if (normalizedSource === 'waitlist') {
          dayStats.waitlistCompleted += 1;
        } else {
          dayStats.scheduledCompleted += 1;
        }
      } else if (normalizedSource === 'reservation') {
        if (normalizedStatus === 'confirmed') dayStats.confirmed += 1;
        else if (normalizedStatus === 'cancelled') dayStats.cancellations += 1;
        else if (normalizedStatus === 'no-show') dayStats.noShows += 1;
      }
    }

    return days.map((day): DailyStats => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayStats = byDate[dateStr] ?? {
        reservations: 0,
        scheduledReservations: 0,
        waitlistReservations: 0,
        completed: 0,
        scheduledCompleted: 0,
        waitlistCompleted: 0,
        confirmed: 0,
        cancellations: 0,
        noShows: 0,
      };

      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        ...dayStats,
      };
    });
  }, [rawReservations, startDate, endDate]);

  const totals = useMemo(() => {
    const base = dailyStats.reduce(
      (acc, day) => ({
        reservations: acc.reservations + day.reservations,
        scheduledReservations: acc.scheduledReservations + day.scheduledReservations,
        waitlistReservations: acc.waitlistReservations + day.waitlistReservations,
        completed: acc.completed + day.completed,
        scheduledCompleted: acc.scheduledCompleted + day.scheduledCompleted,
        waitlistCompleted: acc.waitlistCompleted + day.waitlistCompleted,
        confirmed: acc.confirmed + day.confirmed,
        cancellations: acc.cancellations + day.cancellations,
        noShows: acc.noShows + day.noShows,
      }),
      {
        reservations: 0,
        scheduledReservations: 0,
        waitlistReservations: 0,
        completed: 0,
        scheduledCompleted: 0,
        waitlistCompleted: 0,
        confirmed: 0,
        cancellations: 0,
        noShows: 0,
      },
    );

    const totalGuests = rawReservations.reduce((sum, reservation) => sum + (reservation.party_size || 1), 0);
    return { ...base, totalGuests };
  }, [dailyStats, rawReservations]);

  const prevTotals = useMemo(() => {
    const acc = {
      reservations: 0,
      scheduledReservations: 0,
      waitlistReservations: 0,
      completed: 0,
      scheduledCompleted: 0,
      waitlistCompleted: 0,
      confirmed: 0,
      cancellations: 0,
      noShows: 0,
      totalGuests: 0,
    };

    for (const reservation of prevReservations) {
      const normalizedStatus = normalizeReservationStatus(reservation.status);
      const normalizedSource = normalizeReservationSource(reservation.source);
      acc.reservations++;
      acc.totalGuests += reservation.party_size || 1;
      if (normalizedSource === 'waitlist') {
        acc.waitlistReservations++;
      } else {
        acc.scheduledReservations++;
      }

      if (normalizedStatus === 'checked_in') {
        acc.completed++;
        if (normalizedSource === 'waitlist') {
          acc.waitlistCompleted++;
        } else {
          acc.scheduledCompleted++;
        }
      } else if (normalizedSource === 'reservation') {
        if (normalizedStatus === 'confirmed') acc.confirmed++;
        else if (normalizedStatus === 'cancelled') acc.cancellations++;
        else if (normalizedStatus === 'no-show') acc.noShows++;
      }
    }

    return acc;
  }, [prevReservations]);

  const waitlistTotals = useMemo(() => {
    const totalWaitMs = rawWaitlistSeated.reduce((sum, entry) => {
      if (!entry.seated_at) {
        return sum;
      }

      return sum + Math.max(new Date(entry.seated_at).getTime() - new Date(entry.created_at).getTime(), 0);
    }, 0);

    const avgWaitMin = rawWaitlistSeated.length > 0
      ? Math.round(totalWaitMs / rawWaitlistSeated.length / 60000)
      : 0;

    return {
      total: rawWaitlist.length,
      seated: rawWaitlistSeated.length,
      expired: rawWaitlistDropped.length,
      avgWaitMin,
    };
  }, [rawWaitlist, rawWaitlistDropped.length, rawWaitlistSeated]);

  const waitlistDailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const entriesByDate: Record<string, number> = {};
    const seatedByDate: Record<string, number> = {};
    const droppedByDate: Record<string, number> = {};

    for (const entry of rawWaitlist) {
      const dateKey = format(new Date(entry.created_at), 'yyyy-MM-dd');
      entriesByDate[dateKey] = (entriesByDate[dateKey] || 0) + 1;
    }

    for (const entry of rawWaitlistSeated) {
      if (!entry.seated_at) continue;
      const dateKey = format(new Date(entry.seated_at), 'yyyy-MM-dd');
      seatedByDate[dateKey] = (seatedByDate[dateKey] || 0) + 1;
    }

    for (const entry of rawWaitlistDropped) {
      const eventTimestamp = entry.status === 'removed' ? entry.removed_at : entry.expired_at;
      if (!eventTimestamp) continue;
      const dateKey = format(new Date(eventTimestamp), 'yyyy-MM-dd');
      droppedByDate[dateKey] = (droppedByDate[dateKey] || 0) + 1;
    }

    return days.map((day): WaitlistDailyStat => {
      const dateStr = format(day, 'yyyy-MM-dd');
      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        entries: entriesByDate[dateStr] || 0,
        seated: seatedByDate[dateStr] || 0,
        dropped: droppedByDate[dateStr] || 0,
      };
    });
  }, [endDate, rawWaitlist, rawWaitlistDropped, rawWaitlistSeated, startDate]);

  const heatmapData = useMemo(() => {
    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
    const counts: Record<string, number> = {};
    const breakdown: Record<string, HeatmapCellBreakdown> = {};
    let maxCount = 0;

    const validReservations = rawReservations.filter((reservation) => {
      const normalizedStatus = normalizeReservationStatus(reservation.status);
      return normalizedStatus !== 'cancelled' && !!reservation.time;
    });

    for (const reservation of validReservations) {
      const dayOfWeek = new Date(`${reservation.date}T12:00:00`).getDay();
      const hour = reservation.time!.slice(0, 5);
      const key = `${dayOfWeek}_${hour}`;
      const normalizedSource = normalizeReservationSource(reservation.source);

      if (!breakdown[key]) {
        breakdown[key] = {
          total: 0,
          scheduled: 0,
          waitlist: 0,
        };
      }

      breakdown[key].total += 1;
      if (normalizedSource === 'waitlist') {
        breakdown[key].waitlist += 1;
      } else {
        breakdown[key].scheduled += 1;
      }

      counts[key] = breakdown[key].total;
      maxCount = Math.max(maxCount, counts[key]);
    }

    const hours = [...new Set(validReservations.map((reservation) => reservation.time!.slice(0, 5)))].sort();
    return { counts, breakdown, maxCount, hours, dayNames };
  }, [rawReservations]);

  const createdReservationDailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, { total: number; scheduled: number; waitlist: number }> = {};

    for (const reservation of createdReservations) {
      const createdDate = format(new Date(reservation.created_at), 'yyyy-MM-dd');
      const normalizedSource = normalizeReservationSource(reservation.source);

      if (!byDate[createdDate]) {
        byDate[createdDate] = { total: 0, scheduled: 0, waitlist: 0 };
      }

      byDate[createdDate].total += 1;
      if (normalizedSource === 'waitlist') {
        byDate[createdDate].waitlist += 1;
      } else {
        byDate[createdDate].scheduled += 1;
      }
    }

    return days.map((day): CreatedReservationDailyStat => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayStats = byDate[dateStr] ?? { total: 0, scheduled: 0, waitlist: 0 };
      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        createdReservations: dayStats.total,
        scheduledCreatedReservations: dayStats.scheduled,
        waitlistCreatedReservations: dayStats.waitlist,
      };
    });
  }, [createdReservations, startDate, endDate]);

  const reservationLeadTrend = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, { totalLeadDays: number; createdReservations: number; sameDayReservations: number }> = {};

    for (const reservation of createdReservations) {
      if (normalizeReservationSource(reservation.source) === 'waitlist') {
        continue;
      }

      const createdDate = new Date(reservation.created_at);
      const createdDateKey = format(createdDate, 'yyyy-MM-dd');
      const reservationDate = new Date(`${reservation.date}T12:00:00`);
      const leadDays = Math.max(differenceInCalendarDays(reservationDate, createdDate), 0);

      if (!byDate[createdDateKey]) {
        byDate[createdDateKey] = {
          totalLeadDays: 0,
          createdReservations: 0,
          sameDayReservations: 0,
        };
      }

      byDate[createdDateKey].createdReservations += 1;
      byDate[createdDateKey].totalLeadDays += leadDays;
      if (leadDays === 0) {
        byDate[createdDateKey].sameDayReservations += 1;
      }
    }

    return days.map((day): ReservationLeadTrendPoint => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const bucket = byDate[dateStr];
      const createdCount = bucket?.createdReservations || 0;

      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        createdReservations: createdCount,
        avgLeadDays: createdCount > 0 ? Number((bucket.totalLeadDays / createdCount).toFixed(1)) : 0,
        sameDayReservations: bucket?.sameDayReservations || 0,
      };
    });
  }, [createdReservations, startDate, endDate]);

  const createdReservationTotals = useMemo(() => {
    const scheduledCreatedReservations = createdReservations.filter(
      (reservation) => normalizeReservationSource(reservation.source) === 'reservation',
    );
    const waitlistCreated = createdReservations.length - scheduledCreatedReservations.length;
    const totalCreated = createdReservations.length;

    if (scheduledCreatedReservations.length === 0) {
      return {
        totalCreated,
        scheduledCreated: 0,
        waitlistCreated,
        avgLeadDays: 0,
        sameDayReservations: 0,
      };
    }

    let totalLeadDays = 0;
    let sameDayReservations = 0;

    for (const reservation of scheduledCreatedReservations) {
      const createdDate = new Date(reservation.created_at);
      const reservationDate = new Date(`${reservation.date}T12:00:00`);
      const leadDays = Math.max(differenceInCalendarDays(reservationDate, createdDate), 0);
      totalLeadDays += leadDays;
      if (leadDays === 0) {
        sameDayReservations += 1;
      }
    }

    return {
      totalCreated,
      scheduledCreated: scheduledCreatedReservations.length,
      waitlistCreated,
      avgLeadDays: Number((totalLeadDays / scheduledCreatedReservations.length).toFixed(1)),
      sameDayReservations,
    };
  }, [createdReservations]);

  return {
    dailyStats,
    createdReservationDailyStats,
    reservationLeadTrend,
    createdReservationTotals,
    waitlistDailyStats,
    totals,
    prevTotals,
    waitlistTotals,
    heatmapData,
    isLoading: reservationsQuery.isLoading || waitlistQuery.isLoading || waitlistSeatedQuery.isLoading || waitlistDroppedQuery.isLoading || previousReservationsQuery.isLoading || createdReservationsQuery.isLoading,
    isFetching: reservationsQuery.isFetching || waitlistQuery.isFetching || waitlistSeatedQuery.isFetching || waitlistDroppedQuery.isFetching || previousReservationsQuery.isFetching || createdReservationsQuery.isFetching,
    lastUpdatedAt: Math.max(
      reservationsQuery.dataUpdatedAt || 0,
      waitlistQuery.dataUpdatedAt || 0,
      waitlistSeatedQuery.dataUpdatedAt || 0,
      waitlistDroppedQuery.dataUpdatedAt || 0,
      previousReservationsQuery.dataUpdatedAt || 0,
      createdReservationsQuery.dataUpdatedAt || 0,
    ),
  };
}
