import { type KeyboardEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CheckCircle2, Clock3, Eye, Loader2, Users } from 'lucide-react';
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
import { formatBrazilPhone } from '@/lib/validation';

type ReservationStatus = 'confirmed' | 'checked_in' | 'cancelled' | 'completed' | 'no-show';

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

function normalizeReservationStatus(status: string | null | undefined): ReservationStatus {
  if (status === 'completed') return 'checked_in';
  if (status === 'no_show') return 'no-show';
  if (status === 'checked_in' || status === 'cancelled' || status === 'no-show') return status;
  return 'confirmed';
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
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-36 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reservas de hoje</h1>
          <p className="mt-1 text-muted-foreground">
            Confira os atendimentos de {format(new Date(`${todayKey}T12:00:00`), "EEEE, dd 'de' MMMM", { locale: ptBR })} e registre os check-ins rapidamente.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Reservas do dia</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight text-foreground">{summary.total}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pendentes de check-in</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight text-foreground">{summary.pending}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Check-ins realizados</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight text-foreground">{summary.checkedIn}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Ocorrencias do dia</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tracking-tight text-foreground">{summary.issues}</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Aguardando chegada</CardTitle>
            </CardHeader>
            <CardContent>
              {pendingReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva pendente de check-in.</p>
                  <p className="mt-1 text-sm text-muted-foreground">As proximas reservas confirmadas de hoje aparecerao aqui.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingReservations.map((reservation) => (
                    <div
                      key={reservation.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetails(reservation)}
                      onKeyDown={(event) => handleCardKeyDown(event, reservation)}
                      className="group w-full rounded-2xl border border-border bg-card/90 p-4 text-left shadow-sm transition hover:border-primary/35 hover:bg-accent/30"
                    >
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-2xl font-semibold text-primary">
                          {reservation.time.slice(0, 5)}
                        </div>

                        <div className="min-w-0 flex-1 space-y-3">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-lg font-semibold text-foreground">{reservation.guest_name}</p>
                              <p className="text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</p>
                            </div>
                            <ReservationStatusBadge status={reservation.status} />
                          </div>

                          <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
                              {reservation.party_size} pessoas
                            </span>
                            {reservation.occasion && (
                              <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
                                {reservation.occasion}
                              </span>
                            )}
                            {reservation.notes && (
                              <span className="rounded-full border border-dashed border-border px-3 py-1 text-muted-foreground">
                                Observacao registrada
                              </span>
                            )}
                          </div>
                        </div>

                        <div
                          className="flex flex-wrap gap-2 xl:justify-end"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button type="button" variant="outline" className="gap-2" onClick={() => openDetails(reservation)}>
                            <Eye className="h-4 w-4" />
                            Ver detalhes
                          </Button>
                          <Button type="button" className="gap-2" onClick={() => openCheckIn(reservation)}>
                            <CheckCircle2 className="h-4 w-4" />
                            Realizar check-in
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Ja atualizadas</CardTitle>
            </CardHeader>
            <CardContent>
              {processedReservations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhuma reserva atualizada hoje.</p>
                  <p className="mt-1 text-sm text-muted-foreground">Check-ins, cancelamentos e no-show do dia aparecem aqui.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {processedReservations.map((reservation) => (
                    <div
                      key={reservation.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetails(reservation)}
                      onKeyDown={(event) => handleCardKeyDown(event, reservation)}
                      className="group w-full rounded-2xl border border-border bg-card/90 p-4 text-left shadow-sm transition hover:border-primary/35 hover:bg-accent/30"
                    >
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-muted text-lg font-semibold text-foreground">
                          {reservation.time.slice(0, 5)}
                        </div>

                        <div className="min-w-0 flex-1 space-y-3">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-base font-semibold text-foreground">{reservation.guest_name}</p>
                              <p className="text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</p>
                            </div>
                            <ReservationStatusBadge status={reservation.status} />
                          </div>

                          <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
                              {reservation.party_size} pessoas
                            </span>
                            {reservation.status === 'checked_in' && reservation.checked_in_party_size && (
                              <span className="rounded-full bg-success-soft px-3 py-1 text-success">
                                {reservation.checked_in_party_size} presentes
                              </span>
                            )}
                          </div>
                        </div>

                        <div
                          className="flex flex-wrap gap-2 lg:justify-end"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button type="button" variant="outline" className="gap-2" onClick={() => openDetails(reservation)}>
                            <Eye className="h-4 w-4" />
                            Ver detalhes
                          </Button>
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
        actions={
          detailsReservation?.status === 'confirmed' ? (
            <Button type="button" className="gap-2" onClick={() => openCheckIn(detailsReservation)}>
              <CheckCircle2 className="h-4 w-4" />
              Realizar check-in
            </Button>
          ) : undefined
        }
      />

      <Dialog open={!!checkInReservation} onOpenChange={handleCheckInDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Realizar check-in</DialogTitle>
          </DialogHeader>

          {checkInReservation && (
            <div className="space-y-4 pt-2">
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
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
