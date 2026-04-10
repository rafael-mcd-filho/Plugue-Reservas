import { type KeyboardEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInMinutes, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CheckCircle2, Clock3, Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import ReservationDetailsDialog from '@/components/ReservationDetailsDialog';
import { ReservationStatusBadge } from '@/components/StatusBadge';
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
import { formatBrazilPhone } from '@/lib/validation';

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

export default function OperatorTodayReservations() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const [detailsReservation, setDetailsReservation] = useState<Reservation | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [checkInReservation, setCheckInReservation] = useState<Reservation | null>(null);
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');

  const invalidateReservationQueries = () => {
    qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservation-companions'] });
  };

  const syncReservationInDialogs = (updated: Reservation) => {
    setDetailsReservation((current) => (current?.id === updated.id ? updated : current));
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

  const checkInMutation = useMutation({
    mutationFn: async ({ reservationId, totalPresent }: { reservationId: string; totalPresent: number }) => {
      const { data, error } = await (supabase as any).rpc('check_in_reservation', {
        _reservation_id: reservationId,
        _checked_in_party_size: totalPresent,
        _companions: [],
      });

      if (error) throw error;
      return normalizeReservationRecord((Array.isArray(data) ? data[0] : data) as Reservation);
    },
    onSuccess: (updated) => {
      invalidateReservationQueries();
      syncReservationInDialogs(updated);
      toast.success('Check-in registrado.');
      setCheckInReservation(null);
      supabase.functions.invoke('reservation-events', {
        body: { event: 'status_changed', reservation: { id: updated.id } },
      }).catch((error) => console.warn('Reservation events error:', error));
    },
    onError: () => {
      toast.error('Nao foi possivel registrar o check-in.');
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
      pending: pendingReservations.length,
      checkedIn: reservations.filter((reservation) => reservation.status === 'checked_in').length,
      issues: reservations.filter((reservation) => reservation.status === 'cancelled' || reservation.status === 'no-show').length,
    }),
    [pendingReservations.length, reservations],
  );
  const now = new Date();
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
      hint: 'aguardando chegada',
      className: 'bg-primary-soft text-primary',
    },
    {
      label: 'Check-ins',
      value: summary.checkedIn,
      hint: 'ja registrados',
      className: 'bg-info-soft text-info',
    },
    {
      label: 'Ocorrencias',
      value: summary.issues,
      hint: 'canceladas ou No Show',
      className: 'bg-destructive-soft text-destructive',
    },
  ];

  const openDetails = (reservation: Reservation) => {
    setDetailsReservation(reservation);
    setDetailsOpen(true);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, reservation: Reservation) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetails(reservation);
    }
  };

  const openCheckIn = (reservation: Reservation) => {
    setDetailsOpen(false);
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

    checkInMutation.mutate({
      reservationId: checkInReservation.id,
      totalPresent: parsedCheckedInCount,
    });
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
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,1fr)]">
          <Card className="border-none bg-card/95 shadow-sm">
            <CardHeader className="flex-row items-end justify-between space-y-0 pb-3">
              <div className="space-y-1">
                <CardTitle className="text-lg">Aguardando chegada</CardTitle>
                <p className="text-sm text-muted-foreground">Toque em uma reserva para abrir os detalhes.</p>
              </div>
              <span className="inline-flex min-w-10 items-center justify-center rounded-full bg-primary-soft px-3 py-1 text-sm font-semibold text-primary">
                {pendingReservations.length}
              </span>
            </CardHeader>
            <CardContent className="space-y-2">
              {pendingReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-muted/15 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva pendente de check-in.</p>
                  <p className="mt-1 text-sm text-muted-foreground">As proximas reservas confirmadas de hoje aparecerao aqui.</p>
                </div>
              ) : (
                pendingReservations.map((reservation) => {
                  const lateMinutes = getLateMinutes(reservation, now);

                  return (
                    <div
                      key={reservation.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetails(reservation)}
                      onKeyDown={(event) => handleCardKeyDown(event, reservation)}
                      className="group w-full rounded-xl border border-border/35 bg-background/88 px-3 py-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-primary/20 hover:bg-accent/15"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                        <div className="flex shrink-0 items-center gap-3 sm:w-[86px]">
                          <div className="flex h-12 w-16 items-center justify-center rounded-xl bg-primary/10 text-lg font-semibold tracking-tight text-primary">
                            {reservation.time.slice(0, 5)}
                          </div>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-base font-semibold text-foreground">{reservation.guest_name}</p>
                            {lateMinutes && (
                              <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                                {formatLateLabel(lateMinutes)}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
                              {reservation.party_size} pessoas
                            </span>
                            {reservation.occasion && (
                              <span className="rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground">
                                {reservation.occasion}
                              </span>
                            )}
                            {reservation.notes && (
                              <span className="rounded-full border border-dashed border-border px-2.5 py-1 font-medium text-muted-foreground">
                                Obs. registrada
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center sm:justify-end" onClick={(event) => event.stopPropagation()}>
                          <Button type="button" size="sm" className="min-w-28 gap-2" onClick={() => openCheckIn(reservation)}>
                            <CheckCircle2 className="h-4 w-4" />
                            Check-in
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-none bg-card/80 shadow-sm">
            <CardHeader className="flex-row items-end justify-between space-y-0 pb-3">
              <div className="space-y-1">
                <CardTitle className="text-lg">Ja atualizadas</CardTitle>
                <p className="text-sm text-muted-foreground">Historico do dia com check-ins e ocorrencias.</p>
              </div>
              <span className="inline-flex min-w-10 items-center justify-center rounded-full bg-background px-3 py-1 text-sm font-semibold text-foreground">
                {processedReservations.length}
              </span>
            </CardHeader>
            <CardContent>
              {processedReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/45 bg-background/70 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva atualizada hoje.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Check-ins, cancelamentos e No Show do dia aparecem aqui.</p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-border/35 bg-background/78 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                  {processedReservations.map((reservation, index) => (
                    <div
                      key={reservation.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetails(reservation)}
                      onKeyDown={(event) => handleCardKeyDown(event, reservation)}
                      className={cn(
                        'group w-full px-3 py-3 text-left transition hover:bg-accent/20',
                        index !== processedReservations.length - 1 && 'border-b border-border/35',
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                        <div className="flex h-11 w-14 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold tracking-tight text-muted-foreground">
                          {reservation.time.slice(0, 5)}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">{reservation.guest_name}</p>
                            <ReservationStatusBadge status={reservation.status} />
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>{formatBrazilPhone(reservation.guest_phone)}</span>
                            <span>{reservation.party_size} pessoas</span>
                            {reservation.status === 'checked_in' && reservation.checked_in_party_size && (
                              <span>{reservation.checked_in_party_size} presentes</span>
                            )}
                            {reservation.occasion && <span>{reservation.occasion}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
 
      <ReservationDetailsDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        reservation={detailsReservation}
        slug={slug}
        showEventHistory={false}
        onCheckIn={(r) => openCheckIn(r as Reservation)}
      />

      <Dialog open={!!checkInReservation} onOpenChange={handleCheckInDialogChange}>
        <DialogContent className="sm:max-w-md">
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

              <Button className="w-full" onClick={handleConfirmCheckIn} disabled={checkInMutation.isPending}>
                {checkInMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Registrando...
                  </>
                ) : (
                  'Confirmar check-in'
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
