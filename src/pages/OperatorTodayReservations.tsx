import { type KeyboardEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInMinutes, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Ban, CheckCircle2, Clock3, Loader2, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import PhoneWhatsAppLink from '@/components/PhoneWhatsAppLink';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';
import type { ReservationStatus } from '@/types/restaurant';
import { normalizePhoneDigits } from '@/lib/validation';

interface Reservation {
  id: string;
  company_id: string;
  source: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  public_tracking_code: string;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  created_at: string;
  updated_at: string;
}

interface ReservationSlotGroup {
  key: string;
  startMinutes: number;
  endMinutes: number;
  label: string;
  reservations: Reservation[];
  totalGuests: number;
}

function normalizeReservationRecord(reservation: Reservation) {
  return {
    ...reservation,
    status: normalizeReservationStatus(reservation.status),
  };
}

function sortReservations(left: Reservation, right: Reservation) {
  if (left.status === 'confirmed' && right.status !== 'confirmed') return -1;
  if (left.status !== 'confirmed' && right.status === 'confirmed') return 1;
  return left.time.localeCompare(right.time);
}

function getReservationDateTime(reservation: Reservation) {
  return new Date(`${reservation.date}T${reservation.time}`);
}

function getLateMinutes(reservation: Reservation, now: Date) {
  if (reservation.status !== 'confirmed') return null;

  const delayInMinutes = differenceInMinutes(now, getReservationDateTime(reservation));
  return delayInMinutes > 0 ? delayInMinutes : null;
}

function formatLateLabel(minutes: number) {
  if (minutes < 60) {
    return `Atrasada ha ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `Atrasada ha ${hours}h`;
  }

  return `Atrasada ha ${hours}h${String(remainingMinutes).padStart(2, '0')}`;
}

function getPresentGuestCount(reservation: Reservation) {
  if (reservation.status !== 'checked_in') return 0;
  return reservation.checked_in_party_size ?? reservation.party_size;
}

function getVisibleOccasionLabel(occasion: string | null | undefined) {
  const normalizedOccasion = occasion?.trim();
  if (!normalizedOccasion) return null;
  return normalizedOccasion.toLowerCase() === 'outro' ? null : normalizedOccasion;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(':').map((part) => Number(part));
  return hours * 60 + minutes;
}

function formatMinutesLabel(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildSlotLabel(startMinutes: number, durationInMinutes: number) {
  return `${formatMinutesLabel(startMinutes)} - ${formatMinutesLabel(startMinutes + durationInMinutes)}`;
}

function groupReservationsBySlot(reservations: Reservation[], durationInMinutes: number) {
  const groups = new Map<string, ReservationSlotGroup>();

  reservations.forEach((reservation) => {
    const startMinutes = timeToMinutes(reservation.time);
    const key = String(startMinutes);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        startMinutes,
        endMinutes: startMinutes + durationInMinutes,
        label: buildSlotLabel(startMinutes, durationInMinutes),
        reservations: [],
        totalGuests: 0,
      });
    }

    const group = groups.get(key)!;
    group.reservations.push(reservation);
    group.totalGuests += reservation.party_size;
  });

  return Array.from(groups.values()).sort((left, right) => left.startMinutes - right.startMinutes);
}

function isNowWithinSlot(group: ReservationSlotGroup, now: Date) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= group.startMinutes && currentMinutes < group.endMinutes;
}

export default function OperatorTodayReservations() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const [search, setSearch] = useState('');
  const [detailsReservation, setDetailsReservation] = useState<ReservationDetails | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyDetailsReservation, setHistoryDetailsReservation] = useState<ReservationDetails | null>(null);
  const [historyDetailsOpen, setHistoryDetailsOpen] = useState(false);
  const [checkInReservation, setCheckInReservation] = useState<Reservation | null>(null);
  const [noShowReservation, setNoShowReservation] = useState<Reservation | null>(null);
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');

  const invalidateReservationQueries = () => {
    qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservation-companions'] });
    qc.invalidateQueries({ queryKey: ['reservation-event-history'] });
    qc.invalidateQueries({ queryKey: ['reservation-lead-history'] });
  };

  const syncReservationInDialogs = (updated: Reservation) => {
    setDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setHistoryDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setCheckInReservation((current) => (current?.id === updated.id ? updated : current));
  };

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['today-reservations', companyId, todayKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select(
          'id, company_id, source, guest_name, guest_phone, guest_email, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at',
        )
        .eq('company_id', companyId)
        .eq('date', todayKey)
        .order('time', { ascending: true });

      if (error) throw error;
      return ((data ?? []) as Reservation[]).map(normalizeReservationRecord).sort(sortReservations);
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  const { data: reservationSettings } = useQuery({
    queryKey: ['operator-reservation-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as never)
        .select('reservation_duration')
        .eq('id', companyId!)
        .maybeSingle();

      if (error) throw error;
      return (data as { reservation_duration: number | null } | null) ?? null;
    },
    enabled: !!companyId,
  });

  const statusMutation = useMutation({
    mutationFn: async ({
      reservationId,
      status,
      totalPresent,
    }: {
      reservationId: string;
      status: ReservationStatus;
      totalPresent?: number;
    }) => {
      if (status === 'checked_in') {
        const { data, error } = await (supabase as any).rpc('check_in_reservation', {
          _reservation_id: reservationId,
          _checked_in_party_size: totalPresent,
          _companions: [],
        });

        if (error) throw error;
        return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
      }

      const { data, error } = await (supabase as any).rpc('update_reservation_status', {
        _reservation_id: reservationId,
        _status: status,
      });

      if (error) throw error;
      return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
    },
    onSuccess: (updated) => {
      invalidateReservationQueries();
      syncReservationInDialogs(updated);
      toast.success(updated.status === 'checked_in' ? 'Check-in registrado.' : 'Reserva marcada como No-Show.');
      if (updated.status === 'checked_in') {
        setCheckInReservation(null);
        setCheckedInPartySize('1');
      }
      if (updated.status === 'no-show') {
        setNoShowReservation(null);
      }
      supabase.functions.invoke('reservation-events', {
        body: { event: updated.status === 'cancelled' ? 'reservation_cancelled' : 'status_changed', reservation: { id: updated.id } },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: (_error, variables) => {
      const errorMessage = variables.status === 'no-show'
        ? 'Nao foi possivel marcar a reserva como No-Show.'
        : 'Nao foi possivel registrar o check-in.';

      toast.error(errorMessage);
      return;
      toast.error('Não foi possível registrar o check-in.');
    },
  });

  const pendingReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status === 'confirmed'),
    [reservations],
  );
  const processedReservations = useMemo(
    () => reservations.filter((reservation) => reservation.status !== 'confirmed'),
    [reservations],
  );
  const summary = useMemo(
    () => ({
      total: reservations.length,
      guests: reservations.reduce((totalGuests, reservation) => totalGuests + reservation.party_size, 0),
      pending: pendingReservations.length,
      pendingGuests: pendingReservations.reduce((totalGuests, reservation) => totalGuests + reservation.party_size, 0),
      checkedIn: reservations.filter((reservation) => reservation.status === 'checked_in').length,
      checkedInGuests: reservations.reduce((totalGuests, reservation) => totalGuests + getPresentGuestCount(reservation), 0),
      issues: reservations.filter((reservation) => reservation.status === 'cancelled' || reservation.status === 'no-show').length,
    }),
    [pendingReservations, reservations],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const normalizedSearchDigits = normalizePhoneDigits(search);
  const matchesSearch = (reservation: Reservation) => {
    if (!normalizedSearch && !normalizedSearchDigits) return true;

    const matchesName = reservation.guest_name.toLowerCase().includes(normalizedSearch);
    const matchesPhone = normalizedSearchDigits.length > 0
      && normalizePhoneDigits(reservation.guest_phone).includes(normalizedSearchDigits);

    return matchesName || matchesPhone;
  };
  const filteredPendingReservations = useMemo(
    () => pendingReservations.filter(matchesSearch),
    [pendingReservations, normalizedSearch, normalizedSearchDigits],
  );
  const filteredProcessedReservations = useMemo(
    () => processedReservations.filter(matchesSearch),
    [processedReservations, normalizedSearch, normalizedSearchDigits],
  );
  const now = new Date();
  const slotDuration = Math.max(reservationSettings?.reservation_duration ?? 30, 5);
  const pendingReservationGroups = useMemo(
    () => groupReservationsBySlot(filteredPendingReservations, slotDuration),
    [filteredPendingReservations, slotDuration],
  );
  const processedReservationGroups = useMemo(
    () => groupReservationsBySlot(filteredProcessedReservations, slotDuration),
    [filteredProcessedReservations, slotDuration],
  );
  const summaryItems = [
    {
      label: 'Reservas do dia',
      value: summary.total,
      hint: 'total previsto',
      className: 'bg-muted/20 text-foreground',
    },
    {
      label: 'Pendentes',
      value: summary.pending,
      hint: 'grupos que faltam chegar',
      className: 'bg-primary-soft text-primary',
    },
    {
      label: 'Pessoas previstas',
      value: summary.guests,
      hint: 'reservadas para hoje',
      className: 'bg-emerald-50 text-emerald-700',
    },
    {
      label: 'Check-ins',
      value: summary.checkedIn,
      hint: 'grupos que ja chegaram',
      className: 'bg-info-soft text-info',
    },
    {
      label: 'Ocorrencias',
      value: summary.issues,
      hint: 'canceladas ou No Show',
      className: 'bg-destructive-soft text-destructive',
    },
  ];

  const openDetails = (reservation: ReservationDetails) => {
    setDetailsReservation(reservation);
    setDetailsOpen(true);
  };

  const openHistoryDetails = (reservation: ReservationDetails) => {
    setHistoryDetailsReservation(reservation);
    setHistoryDetailsOpen(true);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, reservation: Reservation) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetails(reservation);
    }
  };

  const openCheckIn = (reservation: Reservation) => {
    setDetailsOpen(false);
    setHistoryDetailsOpen(false);
    setCheckInReservation(reservation);
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
  };

  const handleCheckInDialogChange = (open: boolean) => {
    if (open) return;
    setCheckInReservation(null);
    setCheckedInPartySize('1');
  };

  const handleConfirmCheckIn = () => {
    if (!checkInReservation) return;

    const parsedCheckedInCount = Number.parseInt(checkedInPartySize, 10);
    if (Number.isNaN(parsedCheckedInCount) || parsedCheckedInCount < 1 || parsedCheckedInCount > 50) {
      toast.error('Informe uma quantidade presente valida.');
      return;
    }

    statusMutation.mutate({
      reservationId: checkInReservation.id,
      status: 'checked_in',
      totalPresent: parsedCheckedInCount,
    });
  };

  const handleMarkNoShow = (reservation: Reservation) => {
    setNoShowReservation(null);
    statusMutation.mutate({
      reservationId: reservation.id,
      status: 'no-show',
    });
  };

  const renderPendingReservationItem = (reservation: Reservation) => {
    const lateMinutes = getLateMinutes(reservation, now);
    const visibleOccasion = getVisibleOccasionLabel(reservation.occasion);
    const hasSecondaryMeta = Boolean(visibleOccasion || reservation.notes);
    const reservationActionPending = statusMutation.isPending
      && statusMutation.variables?.reservationId === reservation.id;
    const pendingStatus = reservationActionPending ? statusMutation.variables?.status : null;

    return (
      <div
        key={reservation.id}
        role="button"
        tabIndex={0}
        onClick={() => openDetails(reservation)}
        onKeyDown={(event) => handleCardKeyDown(event, reservation)}
        className={cn(
          'group grid grid-cols-[3.5rem_minmax(0,1fr)] items-start px-3 py-3 text-left transition hover:bg-accent/10 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto] sm:items-center sm:px-4',
          hasSecondaryMeta ? 'gap-3' : 'gap-2',
        )}
      >
        <div className="flex h-11 w-14 items-center justify-center rounded-xl bg-primary/10 text-base font-semibold tracking-tight text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          {reservation.time.slice(0, 5)}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{reservation.guest_name}</p>
            {lateMinutes && (
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                {formatLateLabel(lateMinutes)}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <PhoneWhatsAppLink
              phone={reservation.guest_phone}
              companyId={reservation.company_id}
              slug={slug}
              reservation={reservation}
              phoneClassName="text-xs text-muted-foreground sm:text-sm"
            />
            <span
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground sm:text-xs"
              aria-label={`${reservation.party_size} pessoas`}
              title={`${reservation.party_size} pessoas`}
            >
              <span className="tabular-nums">{reservation.party_size}</span>
              <Users className="h-3.5 w-3.5" />
            </span>
            {visibleOccasion && (
              <span
                className="max-w-[11rem] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:max-w-[14rem] sm:text-xs"
                title={visibleOccasion}
              >
                {visibleOccasion}
              </span>
            )}
            {reservation.notes && (
              <span
                className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:text-xs"
                title="Observacao registrada"
              >
                Obs.
              </span>
            )}
          </div>
        </div>

        <div
          className={cn(
            'col-span-2 flex gap-2 sm:col-span-1 sm:min-w-[98px] sm:justify-end sm:pt-0',
            hasSecondaryMeta ? 'pt-1' : 'pt-0',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            size="icon"
            aria-label={pendingStatus === 'checked_in' ? 'Registrando check-in' : 'Realizar check-in'}
            title={pendingStatus === 'checked_in' ? 'Registrando check-in' : 'Realizar check-in'}
            className="h-10 flex-1 rounded-xl sm:h-11 sm:w-11 sm:flex-none"
            onClick={() => openCheckIn(reservation)}
            disabled={reservationActionPending}
          >
            {pendingStatus === 'checked_in' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-5 w-5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={pendingStatus === 'no-show' ? 'Marcando como no-show' : 'Marcar como no-show'}
            title={pendingStatus === 'no-show' ? 'Marcando como no-show' : 'Marcar como no-show'}
            className="h-10 flex-1 rounded-xl border-destructive/25 text-destructive hover:border-destructive/35 hover:bg-destructive/5 hover:text-destructive sm:h-11 sm:w-11 sm:flex-none"
            onClick={() => setNoShowReservation(reservation)}
            disabled={reservationActionPending}
          >
            {pendingStatus === 'no-show' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Ban className="h-5 w-5" />
            )}
          </Button>
        </div>
      </div>
    );
  };

  const renderProcessedReservationItem = (reservation: Reservation) => {
    const visibleOccasion = getVisibleOccasionLabel(reservation.occasion);
    const hasSecondaryMeta = Boolean(visibleOccasion || reservation.notes);

    return (
      <div
        key={reservation.id}
        role="button"
        tabIndex={0}
        onClick={() => openDetails(reservation)}
        onKeyDown={(event) => handleCardKeyDown(event, reservation)}
        className={cn(
          'grid grid-cols-[3.5rem_minmax(0,1fr)] items-start px-3 py-3 text-left transition hover:bg-accent/10 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:items-center sm:px-4',
          hasSecondaryMeta ? 'gap-3' : 'gap-2',
        )}
      >
        <div className="flex h-11 w-14 items-center justify-center rounded-xl bg-muted text-sm font-semibold tracking-tight text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          {reservation.time.slice(0, 5)}
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground sm:text-[15px]">{reservation.guest_name}</p>
            <ReservationStatusBadge status={reservation.status} />
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <PhoneWhatsAppLink
              phone={reservation.guest_phone}
              companyId={reservation.company_id}
              slug={slug}
              reservation={reservation}
              phoneClassName="text-xs text-muted-foreground sm:text-sm"
            />

            <span
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground sm:text-xs"
              aria-label={`${reservation.party_size} pessoas`}
              title={`${reservation.party_size} pessoas`}
            >
              <span className="tabular-nums">{reservation.party_size}</span>
              <Users className="h-3.5 w-3.5" />
            </span>

            {visibleOccasion && (
              <span
                className="max-w-[11rem] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:max-w-[14rem] sm:text-xs"
                title={visibleOccasion}
              >
                {visibleOccasion}
              </span>
            )}

            {reservation.notes && (
              <span
                className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:text-xs"
                title="Observacao registrada"
              >
                Obs.
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderReservationGroups = (
    groups: ReservationSlotGroup[],
    options: {
      emptyTitle: string;
      emptyDescription: string;
      renderItem: (reservation: Reservation) => JSX.Element;
      accent?: 'primary' | 'neutral';
    },
  ) => {
    if (groups.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed border-border/45 bg-muted/15 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{options.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{options.emptyDescription}</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {groups.map((group) => {
          const slotIsCurrent = options.accent === 'primary' && isNowWithinSlot(group, now);

          return (
            <section
              key={group.key}
              className={cn(
                'overflow-hidden rounded-2xl border bg-background/86 shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
                slotIsCurrent ? 'border-primary/35 ring-1 ring-primary/10' : 'border-border/35',
              )}
            >
              <div
                className={cn(
                  'flex items-start justify-between gap-3 border-b px-4 py-3',
                  slotIsCurrent ? 'border-primary/15 bg-primary/[0.06]' : 'border-border/35 bg-muted/10',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold tracking-tight text-foreground">{group.label}</p>
                    {slotIsCurrent && (
                      <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
                        Agora
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {group.reservations.length} reservas · {group.totalGuests} pessoas
                  </p>
                </div>

                <div className="rounded-full border border-border/50 bg-background/85 px-2.5 py-1 text-xs font-semibold text-foreground">
                  {group.reservations.length}
                </div>
              </div>

              <div className="divide-y divide-border/35">
                {group.reservations.map((reservation) => options.renderItem(reservation))}
              </div>
            </section>
          );
        })}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-10 w-48 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-5 w-80 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-28 animate-pulse rounded-2xl bg-muted" />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
          <div className="h-[420px] animate-pulse rounded-2xl bg-muted" />
          <div className="h-[360px] animate-pulse rounded-2xl bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reservas de hoje</h1>
          <p className="mt-1 text-muted-foreground">
            Confira os atendimentos de {format(new Date(`${todayKey}T12:00:00`), "EEEE, dd 'de' MMMM", { locale: ptBR })} e registre os check-ins rapidamente.
          </p>
        </div>

        <div className="rounded-2xl bg-card/95 p-3 shadow-sm">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {summaryItems.map((item) => (
              <div key={item.label} className="rounded-xl border border-border/35 bg-background/75 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      {item.label}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">{item.hint}</p>
                  </div>
                  <div className={cn('inline-flex min-w-12 items-center justify-center rounded-lg px-2.5 py-2 text-2xl font-semibold tracking-tight', item.className)}>
                    {item.value}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-card/95 p-3 shadow-sm">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar reserva por nome ou telefone..."
              className="h-11 rounded-xl border-border/50 bg-background/80 pl-10"
              autoComplete="off"
              inputMode="search"
            />
          </div>
          {search.trim() && (
            <p className="mt-2 text-xs text-muted-foreground">
              Filtrando as reservas de hoje por nome ou telefone.
            </p>
          )}
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
          <Card className="border-none bg-card/95 shadow-sm">
            <CardHeader className="flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="text-lg">Aguardando chegada</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Visualização compacta por blocos de {slotDuration} min. Toque em uma reserva para abrir os detalhes.
                </p>
              </div>
              <span className="inline-flex min-w-10 items-center justify-center rounded-full bg-primary-soft px-3 py-1 text-sm font-semibold text-primary">
                {filteredPendingReservations.length}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-muted/15 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva pendente de check-in.</p>
                  <p className="mt-1 text-sm text-muted-foreground">As proximas reservas confirmadas de hoje aparecerao aqui.</p>
                </div>
              ) : filteredPendingReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-muted/15 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva encontrada para essa busca.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Tente buscar por outro nome ou telefone.</p>
                </div>
              ) : (
                renderReservationGroups(pendingReservationGroups, {
                  emptyTitle: 'Nenhuma reserva pendente de check-in.',
                  emptyDescription: 'As próximas reservas confirmadas de hoje aparecerão aqui.',
                  renderItem: renderPendingReservationItem,
                  accent: 'primary',
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-none bg-card/80 shadow-sm">
            <CardHeader className="flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="text-lg">Ja atualizadas</CardTitle>
                <p className="text-sm text-muted-foreground">Histórico do dia agrupado pelos mesmos blocos de horário.</p>
              </div>
              <span className="inline-flex min-w-10 items-center justify-center rounded-full bg-background px-3 py-1 text-sm font-semibold text-foreground">
                {filteredProcessedReservations.length}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              {processedReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-background/70 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva atualizada hoje.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Check-ins, cancelamentos e No Show do dia aparecem aqui.</p>
                </div>
              ) : filteredProcessedReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-background/70 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhum resultado encontrado.</p>
                  <p className="mt-1 text-sm text-muted-foreground">A busca atual não encontrou reservas nesta lista.</p>
                </div>
              ) : (
                renderReservationGroups(processedReservationGroups, {
                  emptyTitle: 'Nenhuma reserva atualizada hoje.',
                  emptyDescription: 'Check-ins, cancelamentos e No Show do dia aparecem aqui.',
                  renderItem: renderProcessedReservationItem,
                  accent: 'neutral',
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
 
      <ReservationDetailsDialog
        open={detailsOpen}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (!open) {
            setDetailsReservation(null);
            setHistoryDetailsOpen(false);
            setHistoryDetailsReservation(null);
          }
        }}
        reservation={detailsReservation}
        slug={slug}
        companyId={companyId}
        showEventHistory={false}
        showLeadHistory
        onReservationSelect={openHistoryDetails}
      />

      <ReservationDetailsDialog
        open={historyDetailsOpen}
        onOpenChange={(open) => {
          setHistoryDetailsOpen(open);
          if (!open) {
            setHistoryDetailsReservation(null);
          }
        }}
        reservation={historyDetailsReservation}
        slug={slug}
        companyId={companyId}
        showEventHistory={false}
        onBackToList={() => setHistoryDetailsOpen(false)}
        backLabel="Voltar para a reserva atual"
      />

      <Dialog open={!!checkInReservation} onOpenChange={handleCheckInDialogChange}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-md overflow-x-hidden sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Realizar check-in</DialogTitle>
          </DialogHeader>

          {checkInReservation && (
            <div className="space-y-4 pt-2">
              <div className="rounded-2xl border border-border/35 bg-muted/15 p-4">
                <p className="font-medium text-foreground">{checkInReservation.guest_name}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-4 w-4" />
                    {checkInReservation.time.slice(0, 5)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-4 w-4" />
                    Reserva para {checkInReservation.party_size} pessoas
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="operator-checked-in-party-size">Total presente</Label>
                <Input
                  id="operator-checked-in-party-size"
                  type="number"
                  min="1"
                  max="50"
                  value={checkedInPartySize}
                  onChange={(event) => setCheckedInPartySize(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Ajuste somente se a quantidade que chegou for diferente da reserva original.
                </p>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => handleCheckInDialogChange(false)}>
                  Cancelar
                </Button>
                <Button className="w-full sm:w-auto" onClick={handleConfirmCheckIn} disabled={statusMutation.isPending}>
                  {statusMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Registrando...
                    </>
                  ) : (
                    'Confirmar check-in'
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!noShowReservation} onOpenChange={(open) => !open && setNoShowReservation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marcar reserva como No-Show?</AlertDialogTitle>
            <AlertDialogDescription>
              {noShowReservation
                ? `${noShowReservation.guest_name} sera marcado como No-Show para a reserva das ${noShowReservation.time.slice(0, 5)}.`
                : 'Confirme a marcacao de No-Show para esta reserva.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const reservation = noShowReservation;

                if (!reservation) {
                  return;
                }

                handleMarkNoShow(reservation);
              }}
            >
              {statusMutation.isPending && statusMutation.variables?.status === 'no-show'
                ? 'Marcando...'
                : 'Confirmar No-Show'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
