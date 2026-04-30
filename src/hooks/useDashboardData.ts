import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { getAttributionString, hasMetaClickAttribution, isPaidTrafficMarker, normalizeTrackingTextValue } from '@/lib/trackingAttribution';
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
  totalGuests: number;
}

interface RawReservation {
  date: string;
  time: string | null;
  status: string | null;
  party_size: number | null;
  checked_in_party_size: number | null;
  created_at: string;
  source: string | null;
  tracking_session?: {
    utm_medium?: string | null;
    fbclid?: string | null;
    fbc?: string | null;
  } | null;
  origin_tracking_session_id?: string | null;
  origin_anonymous_id?: string | null;
  origin_affiliate_link_id?: string | null;
  origin_fbc?: string | null;
  attribution_snapshot?: Record<string, unknown> | null;
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
  direct_organic: number;
  ads: number;
  affiliate: number;
  manual: number;
  waitlist: number;
  direct_organicPeople: number;
  adsPeople: number;
  affiliatePeople: number;
  manualPeople: number;
  waitlistPeople: number;
}

const RESERVATION_ORIGIN_CONFIG: Record<ReservationOriginKey, { label: string; color: string }> = {
  direct_organic: {
    label: 'Direta/Orgânica',
    color: 'hsl(202, 89%, 48%)',
  },
  ads: {
    label: 'Ads',
    color: 'hsl(28, 85%, 55%)',
  },
  affiliate: {
    label: 'Filiado',
    color: 'hsl(145, 63%, 42%)',
  },
  manual: {
    label: 'Manual',
    color: 'hsl(0, 0%, 35%)',
  },
  waitlist: {
    label: 'Fila de Espera',
    color: 'hsl(338, 78%, 55%)',
  },
};

function normalizeReservationSource(source: string | null | undefined) {
  return source === 'waitlist' ? 'waitlist' : 'reservation';
}

function isPublicReservation(reservation: RawReservation) {
  if (normalizeTrackingTextValue(reservation.origin_tracking_session_id)) return true;
  if (normalizeTrackingTextValue(reservation.origin_anonymous_id)) return true;
  return getAttributionString(reservation.attribution_snapshot, 'tracking_source') === 'public_web';
}

function classifyReservationOrigin(reservation: RawReservation): ReservationOriginKey {
  if (normalizeReservationSource(reservation.source) === 'waitlist') {
    return 'waitlist';
  }

  if (!isPublicReservation(reservation)) {
    return 'manual';
  }

  if (normalizeTrackingTextValue(reservation.origin_affiliate_link_id)) {
    return 'affiliate';
  }

  const utmMedium = getAttributionString(reservation.attribution_snapshot, 'utm_medium')
    ?? normalizeTrackingTextValue(reservation.tracking_session?.utm_medium);
  if (
    isPaidTrafficMarker(utmMedium)
    || hasMetaClickAttribution({
      snapshot: reservation.attribution_snapshot,
      fbclid: reservation.tracking_session?.fbclid,
      fbc: normalizeTrackingTextValue(reservation.origin_fbc)
        ?? normalizeTrackingTextValue(reservation.tracking_session?.fbc),
    })
  ) {
    return 'ads';
  }

  return 'direct_organic';
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
        .select('date, time, status, party_size, checked_in_party_size, created_at, source, origin_tracking_session_id, origin_anonymous_id, origin_affiliate_link_id, origin_fbc, attribution_snapshot, tracking_session:origin_tracking_session_id(utm_medium,fbclid,fbc)')
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
        .select('date, time, status, party_size, checked_in_party_size, created_at, source, origin_tracking_session_id, origin_anonymous_id, origin_affiliate_link_id, origin_fbc, attribution_snapshot, tracking_session:origin_tracking_session_id(utm_medium,fbclid,fbc)')
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
        .select('date, time, status, party_size, checked_in_party_size, created_at, source, origin_tracking_session_id, origin_anonymous_id, origin_affiliate_link_id, origin_fbc, attribution_snapshot, tracking_session:origin_tracking_session_id(utm_medium,fbclid,fbc)')
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
          totalGuests: 0,
        };
      }

      const dayStats = byDate[reservation.date];
      dayStats.reservations += 1;
      dayStats.totalGuests += reservation.party_size || 1;
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
        totalGuests: 0,
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

    const totalGuests = rawReservations.reduce((sum, r) => sum + (r.party_size || 1), 0);
    const checkedInGuests = rawReservations.reduce((sum, r) => {
      if (normalizeReservationStatus(r.status) !== 'checked_in') return sum;
      return sum + (r.checked_in_party_size ?? r.party_size ?? 1);
    }, 0);
    return { ...base, totalGuests, checkedInGuests };
  }, [dailyStats, rawReservations]);

  const reservationOriginBreakdown = useMemo(() => {
    const counts: Record<ReservationOriginKey, number> = {
      direct_organic: 0, ads: 0, affiliate: 0, manual: 0, waitlist: 0,
    };
    const people: Record<ReservationOriginKey, number> = {
      direct_organic: 0, ads: 0, affiliate: 0, manual: 0, waitlist: 0,
    };

    for (const reservation of createdReservations) {
      const key = classifyReservationOrigin(reservation);
      counts[key] += 1;
      people[key] += reservation.party_size || 1;
    }

    const total = createdReservations.length;
    const totalPeople = createdReservations.reduce((s, r) => s + (r.party_size || 1), 0);
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
  }, [createdReservations]);

  const reservationOriginDailyStats = useMemo(() => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const byDate: Record<string, ReservationOriginDailyStat> = {};

    for (const reservation of createdReservations) {
      const createdDate = format(new Date(reservation.created_at), 'yyyy-MM-dd');
      const originKey = classifyReservationOrigin(reservation);
      const partySize = reservation.party_size || 1;

      if (!byDate[createdDate]) {
        byDate[createdDate] = {
          date: createdDate,
          label: format(new Date(`${createdDate}T12:00:00`), 'dd/MM', { locale: ptBR }),
          totalReservations: 0,
          totalPeople: 0,
          direct_organic: 0,
          ads: 0,
          affiliate: 0,
          manual: 0,
          waitlist: 0,
          direct_organicPeople: 0,
          adsPeople: 0,
          affiliatePeople: 0,
          manualPeople: 0,
          waitlistPeople: 0,
        };
      }

      const bucket = byDate[createdDate];
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
        direct_organic: 0,
        ads: 0,
        affiliate: 0,
        manual: 0,
        waitlist: 0,
        direct_organicPeople: 0,
        adsPeople: 0,
        affiliatePeople: 0,
        manualPeople: 0,
        waitlistPeople: 0,
      };
    });
  }, [createdReservations, startDate, endDate]);

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
