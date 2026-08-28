import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import {
  isOperationalActiveReservationStatus,
  isOperationalLostReservationStatus,
} from '@/lib/reservation-operational-filter';
import {
  RESERVATION_ORIGIN_CONFIG,
  classifyReservationOrigin,
  normalizeReservationSource,
  type ReservationOriginKey,
} from '@/lib/reservation-origin';
import { fetchAllSupabasePages } from '@/lib/supabase-pagination';
import { differenceInCalendarDays, differenceInDays, eachDayOfInterval, endOfDay, format, startOfDay, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface DailyStats {
  date: string;
  label: string;
  reservations: number;
  activeReservations: number;
  lostReservations: number;
  scheduledReservations: number;
  waitlistReservations: number;
  completed: number;
  scheduledCompleted: number;
  waitlistCompleted: number;
  confirmed: number;
  cancellations: number;
  noShows: number;
  totalGuests: number;
  activeGuests: number;
  lostGuests: number;
  completedGuests: number;
  noShowGuests: number;
  cancelledGuests: number;
}

export interface DashboardDailyReservationInput {
  date: string;
  status: string | null;
  party_size: number | null;
  checked_in_party_size: number | null;
  source: string | null;
}

interface RawReservation extends DashboardDailyReservationInput {
  id: string;
  time: string | null;
  created_at: string;
  origin_tracking_session_id?: string | null;
  origin_anonymous_id?: string | null;
  origin_affiliate_link_id?: string | null;
  attribution_snapshot?: Record<string, unknown> | null;
}

interface RawWaitlistEntry {
  id: string;
  status: string;
  created_at: string;
  seated_at: string | null;
  expired_at: string | null;
  removed_at: string | null;
}

interface RawDailyCapacity {
  capacity_date: string;
  total_capacity: number | null;
  slot_count: number | null;
}

const EMPTY_RESERVATIONS: RawReservation[] = [];
const EMPTY_WAITLIST: RawWaitlistEntry[] = [];
const EMPTY_DAILY_CAPACITY: RawDailyCapacity[] = [];
const DASHBOARD_OPERATIONAL_RESERVATION_SELECT = 'id, date, status, party_size, checked_in_party_size, source';
const DASHBOARD_RESERVATION_SELECT = 'id, date, time, status, party_size, checked_in_party_size, created_at, source, origin_tracking_session_id, origin_anonymous_id, origin_affiliate_link_id, attribution_snapshot';
const DASHBOARD_WAITLIST_SELECT = 'id, status, created_at, seated_at, expired_at, removed_at';

export interface DashboardDataOptions {
  /**
   * Carrega os conjuntos usados apenas pelo resumo das páginas de relatório:
   * capacidade, demanda/origem/antecedência e fila de espera.
   *
   * O padrão permanece `true` para preservar os consumidores existentes.
   */
  includeReportOverview?: boolean;
}

function createEmptyDailyStats(): Omit<DailyStats, 'date' | 'label'> {
  return {
    reservations: 0,
    activeReservations: 0,
    lostReservations: 0,
    scheduledReservations: 0,
    waitlistReservations: 0,
    completed: 0,
    scheduledCompleted: 0,
    waitlistCompleted: 0,
    confirmed: 0,
    cancellations: 0,
    noShows: 0,
    totalGuests: 0,
    activeGuests: 0,
    lostGuests: 0,
    completedGuests: 0,
    noShowGuests: 0,
    cancelledGuests: 0,
  };
}

export function buildDashboardDailyStats(
  reservations: DashboardDailyReservationInput[],
  startDate: Date,
  endDate: Date,
) {
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  const byDate: Record<string, Omit<DailyStats, 'date' | 'label'>> = {};

  for (const reservation of reservations) {
    const normalizedStatus = normalizeReservationStatus(reservation.status);
    const normalizedSource = normalizeReservationSource(reservation.source);
    const dayStats = byDate[reservation.date] ?? createEmptyDailyStats();
    byDate[reservation.date] = dayStats;

    const partySize = reservation.party_size || 1;
    const attendedSize = reservation.checked_in_party_size ?? partySize;
    dayStats.reservations += 1;
    dayStats.totalGuests += partySize;
    if (isOperationalActiveReservationStatus(normalizedStatus)) {
      dayStats.activeReservations += 1;
      dayStats.activeGuests += partySize;
    } else if (isOperationalLostReservationStatus(normalizedStatus)) {
      dayStats.lostReservations += 1;
      dayStats.lostGuests += partySize;
    }
    if (normalizedSource === 'waitlist') {
      dayStats.waitlistReservations += 1;
    } else {
      dayStats.scheduledReservations += 1;
    }

    if (normalizedStatus === 'checked_in') {
      dayStats.completed += 1;
      dayStats.completedGuests += attendedSize;
      if (normalizedSource === 'waitlist') {
        dayStats.waitlistCompleted += 1;
      } else {
        dayStats.scheduledCompleted += 1;
      }
    } else if (normalizedStatus === 'cancelled') {
      dayStats.cancellations += 1;
      dayStats.cancelledGuests += partySize;
    } else if (normalizedStatus === 'no-show') {
      dayStats.noShows += 1;
      dayStats.noShowGuests += partySize;
    } else if (normalizedSource === 'reservation' && normalizedStatus === 'confirmed') {
      dayStats.confirmed += 1;
    }
  }

  return days.map((day): DailyStats => {
    const date = format(day, 'yyyy-MM-dd');
    return {
      date,
      label: format(day, 'dd/MM', { locale: ptBR }),
      ...(byDate[date] ?? createEmptyDailyStats()),
    };
  });
}

export interface CreatedReservationDailyStat {
  date: string;
  label: string;
  createdReservations: number;
  scheduledCreatedReservations: number;
  waitlistCreatedReservations: number;
}

export interface ReservationGuestDailyStat {
  date: string;
  label: string;
  totalGuests: number;
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
  avgWaitMin: number | null;
}

export type DailyCapacityStatus = 'below' | 'full' | 'over' | 'no_capacity';

export interface DailyCapacityStat {
  date: string;
  label: string;
  totalCapacity: number;
  slotCount: number;
  checkedInGuests: number;
  occupancyRate: number;
  overCapacityGuests: number;
  status: DailyCapacityStatus;
}

export interface DailyCapacityTotals {
  totalCapacity: number;
  checkedInGuests: number;
  occupancyRate: number;
  daysWithCapacity: number;
  fullDays: number;
  overCapacityDays: number;
  noCapacityDays: number;
}

export interface HeatmapCellBreakdown {
  total: number;
  scheduled: number;
  waitlist: number;
}

export interface ReservationOriginBreakdownItem {
  key: ReservationOriginKey;
  label: string;
  value: number;
  people: number;
  percentage: number;
  color: string;
}

export interface ReservationOriginDailyStat {
  date: string;
  label: string;
  totalReservations: number;
  totalPeople: number;
  online: number;
  affiliate: number;
  manual: number;
  waitlist: number;
  onlinePeople: number;
  affiliatePeople: number;
  manualPeople: number;
  waitlistPeople: number;
}

export function useDashboardData(
  companyId: string | undefined,
  startDate: Date,
  endDate: Date,
  comparisonStartDate?: Date,
  comparisonEndDate?: Date,
  options: DashboardDataOptions = {},
) {
  const includeReportOverview = options.includeReportOverview ?? true;
  const startStr = format(startDate, 'yyyy-MM-dd');
  const endStr = format(endDate, 'yyyy-MM-dd');
  const rangeStartIso = startOfDay(startDate).toISOString();
  const rangeEndIso = endOfDay(endDate).toISOString();

  const periodDays = differenceInDays(endDate, startDate) + 1;
  const prevEndDate = comparisonEndDate ?? subDays(startDate, 1);
  const prevStartDate = comparisonStartDate ?? subDays(prevEndDate, periodDays - 1);
  const prevStartStr = format(prevStartDate, 'yyyy-MM-dd');
  const prevEndStr = format(prevEndDate, 'yyyy-MM-dd');

  const reservationsQuery = useQuery({
    queryKey: includeReportOverview
      ? ['dashboard-reservations', companyId, startStr, endStr]
      : ['dashboard-reservations', companyId, startStr, endStr, 'operational'],
    queryFn: async () => {
      return fetchAllSupabasePages<RawReservation>((from, to) => {
        let query = supabase
          .from('reservations' as any)
          .select(includeReportOverview ? DASHBOARD_RESERVATION_SELECT : DASHBOARD_OPERATIONAL_RESERVATION_SELECT)
          .gte('date', startStr)
          .lte('date', endStr)
          .order('date', { ascending: true })
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistQuery = useQuery({
    queryKey: ['dashboard-waitlist', companyId, startStr, endStr],
    enabled: includeReportOverview,
    queryFn: async () => {
      return fetchAllSupabasePages<RawWaitlistEntry>((from, to) => {
        let query = supabase
          .from('waitlist' as any)
          .select(DASHBOARD_WAITLIST_SELECT)
          .gte('created_at', rangeStartIso)
          .lte('created_at', rangeEndIso)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistSeatedQuery = useQuery({
    queryKey: ['dashboard-waitlist-seated', companyId, startStr, endStr],
    enabled: includeReportOverview,
    queryFn: async () => {
      return fetchAllSupabasePages<RawWaitlistEntry>((from, to) => {
        let query = supabase
          .from('waitlist' as any)
          .select(DASHBOARD_WAITLIST_SELECT)
          .eq('status', 'seated')
          .gte('seated_at', rangeStartIso)
          .lte('seated_at', rangeEndIso)
          .order('seated_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const waitlistDroppedQuery = useQuery({
    queryKey: ['dashboard-waitlist-dropped', companyId, startStr, endStr],
    enabled: includeReportOverview,
    queryFn: async () => {
      return fetchAllSupabasePages<RawWaitlistEntry>((from, to) => {
        let query = supabase
          .from('waitlist' as any)
          .select(DASHBOARD_WAITLIST_SELECT)
          .in('status', ['expired', 'removed'])
          .or(`and(status.eq.expired,expired_at.gte.${rangeStartIso},expired_at.lte.${rangeEndIso}),and(status.eq.removed,removed_at.gte.${rangeStartIso},removed_at.lte.${rangeEndIso})`)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const previousReservationsQuery = useQuery({
    queryKey: ['dashboard-reservations-prev', companyId, prevStartStr, prevEndStr],
    queryFn: async () => {
      return fetchAllSupabasePages<RawReservation>((from, to) => {
        let query = supabase
          .from('reservations' as any)
          .select(DASHBOARD_OPERATIONAL_RESERVATION_SELECT)
          .gte('date', prevStartStr)
          .lte('date', prevEndStr)
          .order('date', { ascending: true })
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const createdReservationsQuery = useQuery({
    queryKey: ['dashboard-reservations-created', companyId, startStr, endStr],
    enabled: includeReportOverview,
    queryFn: async () => {
      return fetchAllSupabasePages<RawReservation>((from, to) => {
        let query = supabase
          .from('reservations' as any)
          .select(DASHBOARD_RESERVATION_SELECT)
          .gte('created_at', rangeStartIso)
          .lte('created_at', rangeEndIso)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });

        if (companyId) query = query.eq('company_id', companyId);

        return query.range(from, to);
      });
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const dailyCapacityQuery = useQuery({
    queryKey: ['dashboard-daily-capacity', companyId ?? 'all', startStr, endStr],
    enabled: includeReportOverview,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_dashboard_daily_capacity', {
        _company_id: companyId ?? null,
        _start_date: startStr,
        _end_date: endStr,
      });

      if (error) throw error;
      return (data ?? []) as RawDailyCapacity[];
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });

  const rawReservations = reservationsQuery.data ?? EMPTY_RESERVATIONS;
  const rawWaitlist = includeReportOverview ? waitlistQuery.data ?? EMPTY_WAITLIST : EMPTY_WAITLIST;
  const rawWaitlistSeated = includeReportOverview ? waitlistSeatedQuery.data ?? EMPTY_WAITLIST : EMPTY_WAITLIST;
  const rawWaitlistDropped = includeReportOverview ? waitlistDroppedQuery.data ?? EMPTY_WAITLIST : EMPTY_WAITLIST;
  const prevReservations = previousReservationsQuery.data ?? EMPTY_RESERVATIONS;
  const createdReservations = includeReportOverview
    ? createdReservationsQuery.data ?? EMPTY_RESERVATIONS
    : EMPTY_RESERVATIONS;
  const rawDailyCapacity = includeReportOverview
    ? dailyCapacityQuery.data ?? EMPTY_DAILY_CAPACITY
    : EMPTY_DAILY_CAPACITY;

  const dailyStats = useMemo(
    () => buildDashboardDailyStats(rawReservations, startDate, endDate),
    [rawReservations, startDate, endDate],
  );

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

    const totalGuests = rawReservations.reduce((sum, r) => sum + (r.party_size || 1), 0);
    const checkedInGuests = rawReservations.reduce((sum, r) => {
      if (normalizeReservationStatus(r.status) !== 'checked_in') return sum;
      return sum + (r.checked_in_party_size ?? r.party_size ?? 1);
    }, 0);
    const noShowGuests = rawReservations.reduce((sum, r) => {
      if (normalizeReservationStatus(r.status) !== 'no-show') return sum;
      return sum + (r.party_size || 1);
    }, 0);
    const cancelledGuests = rawReservations.reduce((sum, r) => {
      if (normalizeReservationStatus(r.status) !== 'cancelled') return sum;
      return sum + (r.party_size || 1);
    }, 0);
    return { ...base, totalGuests, checkedInGuests, noShowGuests, cancelledGuests };
  }, [dailyStats, rawReservations]);

  const reservationOriginBreakdown = useMemo(() => {
    if (!includeReportOverview) {
      return { total: 0, totalPeople: 0, items: [] };
    }

    const counts: Record<ReservationOriginKey, number> = {
      online: 0, affiliate: 0, manual: 0, waitlist: 0,
    };
    const people: Record<ReservationOriginKey, number> = {
      online: 0, affiliate: 0, manual: 0, waitlist: 0,
    };

    for (const reservation of rawReservations) {
      const key = classifyReservationOrigin(reservation);
      counts[key] += 1;
      people[key] += reservation.party_size || 1;
    }

    const total = rawReservations.length;
    const totalPeople = rawReservations.reduce((s, r) => s + (r.party_size || 1), 0);
    const items = (Object.keys(RESERVATION_ORIGIN_CONFIG) as ReservationOriginKey[]).map((key) => {
      const value = counts[key];
      return {
        key,
        label: RESERVATION_ORIGIN_CONFIG[key].label,
        color: RESERVATION_ORIGIN_CONFIG[key].color,
        value,
        people: people[key],
        percentage: total > 0 ? Number(((value / total) * 100).toFixed(1)) : 0,
      };
    });

    return { total, totalPeople, items };
  }, [includeReportOverview, rawReservations]);

  const reservationOriginDailyStats = useMemo(() => {
    if (!includeReportOverview) return [];

    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, ReservationOriginDailyStat> = {};

    for (const reservation of rawReservations) {
      const reservationDate = reservation.date;
      const originKey = classifyReservationOrigin(reservation);
      const partySize = reservation.party_size || 1;

      if (!byDate[reservationDate]) {
        byDate[reservationDate] = {
          date: reservationDate,
          label: format(new Date(`${reservationDate}T12:00:00`), 'dd/MM', { locale: ptBR }),
          totalReservations: 0,
          totalPeople: 0,
          online: 0,
          affiliate: 0,
          manual: 0,
          waitlist: 0,
          onlinePeople: 0,
          affiliatePeople: 0,
          manualPeople: 0,
          waitlistPeople: 0,
        };
      }

      const bucket = byDate[reservationDate];
      bucket.totalReservations += 1;
      bucket.totalPeople += partySize;
      bucket[originKey] += 1;

      const peopleKey = `${originKey}People` as const;
      bucket[peopleKey] += partySize;
    }

    return days.map((day): ReservationOriginDailyStat => {
      const dateStr = format(day, 'yyyy-MM-dd');
      return byDate[dateStr] ?? {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        totalReservations: 0,
        totalPeople: 0,
        online: 0,
        affiliate: 0,
        manual: 0,
        waitlist: 0,
        onlinePeople: 0,
        affiliatePeople: 0,
        manualPeople: 0,
        waitlistPeople: 0,
      };
    });
  }, [includeReportOverview, rawReservations, startDate, endDate]);

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
      checkedInGuests: 0,
      noShowGuests: 0,
      cancelledGuests: 0,
    };

    for (const reservation of prevReservations) {
      const normalizedStatus = normalizeReservationStatus(reservation.status);
      const normalizedSource = normalizeReservationSource(reservation.source);
      const partySize = reservation.party_size || 1;
      const attendedSize = reservation.checked_in_party_size ?? partySize;
      acc.reservations++;
      acc.totalGuests += partySize;
      if (normalizedSource === 'waitlist') {
        acc.waitlistReservations++;
      } else {
        acc.scheduledReservations++;
      }

      if (normalizedStatus === 'checked_in') {
        acc.completed++;
        acc.checkedInGuests += attendedSize;
        if (normalizedSource === 'waitlist') {
          acc.waitlistCompleted++;
        } else {
          acc.scheduledCompleted++;
        }
      } else if (normalizedStatus === 'cancelled') {
        acc.cancelledGuests += partySize;
        acc.cancellations++;
      } else if (normalizedStatus === 'no-show') {
        acc.noShowGuests += partySize;
        acc.noShows++;
      } else if (normalizedSource === 'reservation') {
        if (normalizedStatus === 'confirmed') {
          acc.confirmed++;
        }
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
    if (!includeReportOverview) return [];

    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const entriesByDate: Record<string, number> = {};
    const seatedByDate: Record<string, number> = {};
    const droppedByDate: Record<string, number> = {};
    const totalWaitMsByDate: Record<string, number> = {};
    const seatedWithWaitByDate: Record<string, number> = {};

    for (const entry of rawWaitlist) {
      const dateKey = format(new Date(entry.created_at), 'yyyy-MM-dd');
      entriesByDate[dateKey] = (entriesByDate[dateKey] || 0) + 1;
    }

    for (const entry of rawWaitlistSeated) {
      if (!entry.seated_at) continue;
      const dateKey = format(new Date(entry.seated_at), 'yyyy-MM-dd');
      seatedByDate[dateKey] = (seatedByDate[dateKey] || 0) + 1;
      totalWaitMsByDate[dateKey] = (totalWaitMsByDate[dateKey] || 0)
        + Math.max(new Date(entry.seated_at).getTime() - new Date(entry.created_at).getTime(), 0);
      seatedWithWaitByDate[dateKey] = (seatedWithWaitByDate[dateKey] || 0) + 1;
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
        avgWaitMin: seatedWithWaitByDate[dateStr]
          ? Number((totalWaitMsByDate[dateStr] / seatedWithWaitByDate[dateStr] / 60000).toFixed(1))
          : null,
      };
    });
  }, [endDate, includeReportOverview, rawWaitlist, rawWaitlistDropped, rawWaitlistSeated, startDate]);

  const dailyCapacityStats = useMemo(() => {
    if (!includeReportOverview) return [];

    const capacityByDate = new Map(
      rawDailyCapacity.map((row) => [
        row.capacity_date,
        {
          totalCapacity: Math.max(0, Number(row.total_capacity ?? 0)),
          slotCount: Math.max(0, Number(row.slot_count ?? 0)),
        },
      ]),
    );

    return dailyStats.map((day): DailyCapacityStat => {
      const capacity = capacityByDate.get(day.date) ?? { totalCapacity: 0, slotCount: 0 };
      const checkedInGuests = day.completedGuests;
      const occupancyRate = capacity.totalCapacity > 0
        ? Math.round((checkedInGuests / capacity.totalCapacity) * 100)
        : 0;
      const overCapacityGuests = capacity.totalCapacity > 0
        ? Math.max(checkedInGuests - capacity.totalCapacity, 0)
        : 0;
      const status: DailyCapacityStatus = capacity.totalCapacity <= 0
        ? 'no_capacity'
        : checkedInGuests > capacity.totalCapacity
          ? 'over'
          : checkedInGuests === capacity.totalCapacity && checkedInGuests > 0
            ? 'full'
            : 'below';

      return {
        date: day.date,
        label: day.label,
        totalCapacity: capacity.totalCapacity,
        slotCount: capacity.slotCount,
        checkedInGuests,
        occupancyRate,
        overCapacityGuests,
        status,
      };
    });
  }, [dailyStats, includeReportOverview, rawDailyCapacity]);

  const dailyCapacityTotals = useMemo<DailyCapacityTotals>(() => {
    const totals = dailyCapacityStats.reduce(
      (acc, day) => ({
        totalCapacity: acc.totalCapacity + day.totalCapacity,
        checkedInGuests: acc.checkedInGuests + day.checkedInGuests,
        daysWithCapacity: acc.daysWithCapacity + (day.totalCapacity > 0 ? 1 : 0),
        fullDays: acc.fullDays + (day.status === 'full' ? 1 : 0),
        overCapacityDays: acc.overCapacityDays + (day.status === 'over' ? 1 : 0),
        noCapacityDays: acc.noCapacityDays + (day.status === 'no_capacity' ? 1 : 0),
      }),
      {
        totalCapacity: 0,
        checkedInGuests: 0,
        daysWithCapacity: 0,
        fullDays: 0,
        overCapacityDays: 0,
        noCapacityDays: 0,
      },
    );

    return {
      ...totals,
      occupancyRate: totals.totalCapacity > 0
        ? Math.round((totals.checkedInGuests / totals.totalCapacity) * 100)
        : 0,
    };
  }, [dailyCapacityStats]);

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
    if (!includeReportOverview) return [];

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
  }, [createdReservations, includeReportOverview, startDate, endDate]);

  const reservationGuestDailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const guestsByDate: Record<string, number> = {};

    for (const reservation of rawReservations) {
      guestsByDate[reservation.date] = (guestsByDate[reservation.date] || 0) + (reservation.party_size || 1);
    }

    return days.map((day): ReservationGuestDailyStat => {
      const dateStr = format(day, 'yyyy-MM-dd');
      return {
        date: dateStr,
        label: format(day, 'dd/MM', { locale: ptBR }),
        totalGuests: guestsByDate[dateStr] || 0,
      };
    });
  }, [endDate, rawReservations, startDate]);

  const reservationLeadTrend = useMemo(() => {
    if (!includeReportOverview) return [];

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
  }, [createdReservations, includeReportOverview, startDate, endDate]);

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

  const operationalIsError = reservationsQuery.isError || previousReservationsQuery.isError;
  const reportOverviewIsError = includeReportOverview && (
    waitlistQuery.isError
    || waitlistSeatedQuery.isError
    || waitlistDroppedQuery.isError
    || createdReservationsQuery.isError
    || dailyCapacityQuery.isError
  );
  const error = reservationsQuery.error
    ?? previousReservationsQuery.error
    ?? (includeReportOverview
      ? waitlistQuery.error
        ?? waitlistSeatedQuery.error
        ?? waitlistDroppedQuery.error
        ?? createdReservationsQuery.error
        ?? dailyCapacityQuery.error
      : null);

  const refetch = async () => {
    const requests = [
      reservationsQuery.refetch(),
      previousReservationsQuery.refetch(),
    ];

    if (includeReportOverview) {
      requests.push(
        waitlistQuery.refetch(),
        waitlistSeatedQuery.refetch(),
        waitlistDroppedQuery.refetch(),
        createdReservationsQuery.refetch(),
        dailyCapacityQuery.refetch(),
      );
    }

    await Promise.all(requests);
  };

  return {
    dailyStats,
    dailyCapacityStats,
    dailyCapacityTotals,
    createdReservationDailyStats,
    reservationGuestDailyStats,
    reservationLeadTrend,
    createdReservationTotals,
    reservationOriginBreakdown,
    reservationOriginDailyStats,
    waitlistDailyStats,
    totals,
    prevTotals,
    waitlistTotals,
    heatmapData,
    operationalIsError,
    reportOverviewIsError,
    error,
    refetch,
    isLoading: reservationsQuery.isLoading
      || previousReservationsQuery.isLoading
      || (includeReportOverview && (
        waitlistQuery.isLoading
        || waitlistSeatedQuery.isLoading
        || waitlistDroppedQuery.isLoading
        || createdReservationsQuery.isLoading
        || dailyCapacityQuery.isLoading
      )),
    isFetching: reservationsQuery.isFetching
      || previousReservationsQuery.isFetching
      || (includeReportOverview && (
        waitlistQuery.isFetching
        || waitlistSeatedQuery.isFetching
        || waitlistDroppedQuery.isFetching
        || createdReservationsQuery.isFetching
        || dailyCapacityQuery.isFetching
      )),
    lastUpdatedAt: Math.max(
      reservationsQuery.dataUpdatedAt || 0,
      previousReservationsQuery.dataUpdatedAt || 0,
      includeReportOverview ? waitlistQuery.dataUpdatedAt || 0 : 0,
      includeReportOverview ? waitlistSeatedQuery.dataUpdatedAt || 0 : 0,
      includeReportOverview ? waitlistDroppedQuery.dataUpdatedAt || 0 : 0,
      includeReportOverview ? createdReservationsQuery.dataUpdatedAt || 0 : 0,
      includeReportOverview ? dailyCapacityQuery.dataUpdatedAt || 0 : 0,
    ),
  };
}
