import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Ban, CheckCircle2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import ReservationDetailsDialog from '@/components/ReservationDetailsDialog';
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
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeBrazilPhoneDigits,
  normalizeEmail,
} from '@/lib/validation';
import { cn } from '@/lib/utils';

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

interface ReservationEditForm {
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  date: string;
  time: string;
  party_size: string;
  occasion: string;
  notes: string;
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

function createReservationEditForm(reservation: Reservation): ReservationEditForm {
  return {
    guest_name: reservation.guest_name,
    guest_phone: formatBrazilPhone(reservation.guest_phone),
    guest_email: reservation.guest_email ?? '',
    date: reservation.date,
    time: reservation.time.slice(0, 5),
    party_size: String(reservation.party_size),
    occasion: reservation.occasion ?? '',
    notes: reservation.notes ?? '',
  };
}

export default function CalendarView() {
  const { companyId, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [detailsReservation, setDetailsReservation] = useState<Reservation | null>(null);
  const [statusDialogReservation, setStatusDialogReservation] = useState<Reservation | null>(null);
  const [editDialogReservation, setEditDialogReservation] = useState<Reservation | null>(null);
  const [cancelReservation, setCancelReservation] = useState<Reservation | null>(null);
  const [editStatus, setEditStatus] = useState<ReservationStatus>('confirmed');
  const [checkedInPartySize, setCheckedInPartySize] = useState('1');
  const [editForm, setEditForm] = useState<ReservationEditForm | null>(null);

  const invalidateReservationQueries = () => {
    qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
    qc.invalidateQueries({ queryKey: ['reservation-companions'] });
  };

  const syncReservationInDialogs = (updated: Reservation) => {
    setDetailsReservation((current) => (current?.id === updated.id ? updated : current));
    setStatusDialogReservation((current) => (current?.id === updated.id ? updated : current));
    setEditDialogReservation((current) => (current?.id === updated.id ? updated : current));
  };

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['calendar-reservations', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select(
          'id, company_id, source, guest_name, guest_phone, guest_email, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at',
        )
        .eq('company_id', companyId)
        .order('date', { ascending: true })
        .order('time', { ascending: true });

      if (error) throw error;
      return ((data ?? []) as Reservation[]).map(normalizeReservationRecord);
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  const updateReservationMutation = useMutation({
    mutationFn: async () => {
      if (!editDialogReservation || !editForm) {
        throw new Error('Reserva nao selecionada.');
      }

      const parsedPartySize = Number.parseInt(editForm.party_size, 10);

      const { data, error } = await supabase
        .from('reservations' as any)
        .update({
          guest_name: editForm.guest_name.trim(),
          guest_phone: normalizeBrazilPhoneDigits(editForm.guest_phone),
          guest_email: normalizeEmail(editForm.guest_email) || null,
          date: editForm.date,
          time: `${editForm.time}:00`,
          party_size: parsedPartySize,
          occasion: editForm.occasion.trim() || null,
          notes: editForm.notes.trim() || null,
        })
        .eq('id', editDialogReservation.id)
        .select(
          'id, company_id, source, guest_name, guest_phone, guest_email, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at',
        )
        .single();

      if (error) throw error;
      return normalizeReservationRecord(data as Reservation);
    },
    onSuccess: (updated) => {
      invalidateReservationQueries();
      syncReservationInDialogs(updated);
      setEditDialogReservation(null);
      setEditForm(null);
      toast.success('Reserva atualizada.');
    },
    onError: () => {
      toast.error('Nao foi possivel atualizar a reserva.');
    },
  });

  const saveStatusMutation = useMutation({
    mutationFn: async ({ reservationId, status, checkedInCount }: {
      reservationId: string;
      status: ReservationStatus;
      checkedInCount?: number;
    }) => {
      if (status === 'checked_in') {
        const { data, error } = await (supabase as any).rpc('check_in_reservation', {
          _reservation_id: reservationId,
          _checked_in_party_size: checkedInCount,
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
      setStatusDialogReservation(null);
      setEditStatus('confirmed');
      setCheckedInPartySize('1');
      toast.success(updated.status === 'checked_in' ? 'Check-in registrado.' : 'Status atualizado.');
    },
    onError: () => {
      toast.error('Nao foi possivel atualizar a reserva.');
    },
  });

  const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';
  const reservationDates = useMemo(
    () => new Set(reservations.map((reservation) => reservation.date)),
    [reservations],
  );
  const dayReservations = useMemo(
    () => reservations
      .filter((reservation) => reservation.date === selectedDateStr)
      .sort((left, right) => left.time.localeCompare(right.time)),
    [reservations, selectedDateStr],
  );

  const openDetails = (reservation: Reservation) => {
    setDetailsReservation(reservation);
    setDetailsDialogOpen(true);
  };

  const openStatusDialog = (reservation: Reservation, status?: ReservationStatus) => {
    setStatusDialogReservation(reservation);
    setEditStatus(status ?? reservation.status);
    setCheckedInPartySize(String(reservation.checked_in_party_size ?? reservation.party_size));
  };

  const openEditDialog = (reservation: Reservation) => {
    setEditDialogReservation(reservation);
    setEditForm(createReservationEditForm(reservation));
  };

  const handleStatusDialogChange = (open: boolean) => {
    if (open) {
      return;
    }

    setStatusDialogReservation(null);
    setEditStatus('confirmed');
    setCheckedInPartySize('1');
  };

  const handleEditDialogChange = (open: boolean) => {
    if (open) {
      return;
    }

    setEditDialogReservation(null);
    setEditForm(null);
  };

  const handleSaveStatus = () => {
    if (!statusDialogReservation) {
      return;
    }

    if (editStatus === 'checked_in') {
      const parsedCheckedInCount = Number.parseInt(checkedInPartySize, 10);

      if (Number.isNaN(parsedCheckedInCount) || parsedCheckedInCount < 1 || parsedCheckedInCount > 50) {
        toast.error('Informe uma quantidade presente valida.');
        return;
      }

      saveStatusMutation.mutate({
        reservationId: statusDialogReservation.id,
        status: editStatus,
        checkedInCount: parsedCheckedInCount,
      });
      return;
    }

    saveStatusMutation.mutate({
      reservationId: statusDialogReservation.id,
      status: editStatus,
    });
  };

  const handleSaveReservation = () => {
    if (!editForm) {
      return;
    }

    if (!editForm.guest_name.trim()) {
      toast.error('Informe o nome do cliente.');
      return;
    }

    const phoneError = getPhoneValidationMessage(editForm.guest_phone, 'o WhatsApp do cliente', true);
    if (phoneError) {
      toast.error(phoneError);
      return;
    }

    const emailError = getEmailValidationMessage(editForm.guest_email, 'o e-mail do cliente');
    if (emailError) {
      toast.error(emailError);
      return;
    }

    const parsedPartySize = Number.parseInt(editForm.party_size, 10);
    if (Number.isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 50) {
      toast.error('Informe uma quantidade valida de pessoas.');
      return;
    }

    if (!editForm.date || !editForm.time) {
      toast.error('Informe a data e o horario da reserva.');
      return;
    }

    updateReservationMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-5 w-56 animate-pulse rounded bg-muted" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <Card className="w-fit border-none shadow-sm">
            <CardContent className="pt-6">
              <div className="h-[330px] w-[310px] animate-pulse rounded-md bg-muted" />
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <div className="h-7 w-72 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="h-28 animate-pulse rounded-2xl bg-muted" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Calendario</h1>
          <p className="mt-1 text-muted-foreground">Visualize reservas por data e abra os detalhes com um clique.</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <Card className="w-fit border-none shadow-sm">
            <CardContent className="pt-6">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                className={cn('pointer-events-auto p-3')}
                modifiers={{ hasReservation: (date) => reservationDates.has(format(date, 'yyyy-MM-dd')) }}
                modifiersClassNames={{ hasReservation: 'bg-primary/15 font-bold text-primary' }}
              />
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">
                {selectedDate
                  ? `Reservas em ${format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}`
                  : 'Selecione uma data'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dayReservations.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma reserva nesta data</p>
              ) : (
                <div className="space-y-3">
                  {dayReservations.map((reservation) => {
                    const detail = reservation.occasion || reservation.notes;

                    return (
                      <button
                        key={reservation.id}
                        type="button"
                        onClick={() => openDetails(reservation)}
                        className="group w-full rounded-2xl border border-border bg-card/90 p-4 text-left shadow-sm transition hover:border-primary/35 hover:bg-accent/30"
                      >
                        <div className="flex flex-col gap-4 md:flex-row md:items-center">
                          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-2xl font-semibold text-primary">
                            {reservation.time.slice(0, 5)}
                          </div>

                          <div className="min-w-0 flex-1 space-y-3">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0">
                                <p className="truncate text-lg font-semibold text-foreground">{reservation.guest_name}</p>
                                <p className="text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</p>
                              </div>

                              <div className="flex items-center gap-2 self-start">
                                <ReservationStatusBadge status={reservation.status} />
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-2 text-sm">
                              <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
                                {reservation.party_size} pessoas
                              </span>
                              {detail && (
                                <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
                                  {detail}
                                </span>
                              )}
                              <span className="rounded-full border border-dashed border-primary/30 px-3 py-1 font-medium text-primary/80">
                                Clique para ver detalhes
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ReservationDetailsDialog
        open={detailsDialogOpen}
        onOpenChange={setDetailsDialogOpen}
        reservation={detailsReservation}
        slug={slug}
        actions={
          detailsReservation ? (
            <>
              {detailsReservation.status === 'confirmed' && (
                <Button type="button" className="gap-2" onClick={() => openStatusDialog(detailsReservation, 'checked_in')}>
                  <CheckCircle2 className="h-4 w-4" />
                  Realizar check-in
                </Button>
              )}
              <Button type="button" variant="outline" className="gap-2" onClick={() => openEditDialog(detailsReservation)}>
                <Pencil className="h-4 w-4" />
                Editar reserva
              </Button>
              <Button type="button" variant="outline" onClick={() => openStatusDialog(detailsReservation)}>
                Alterar status
              </Button>
              {detailsReservation.status !== 'cancelled' && (
                <Button
                  type="button"
                  variant="destructive"
                  className="gap-2"
                  onClick={() => setCancelReservation(detailsReservation)}
                >
                  <Ban className="h-4 w-4" />
                  Cancelar reserva
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <Dialog open={!!statusDialogReservation} onOpenChange={handleStatusDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editStatus === 'checked_in' ? 'Realizar check-in' : 'Alterar status'}</DialogTitle>
          </DialogHeader>

          {statusDialogReservation && (
            <div className="space-y-4 pt-2">
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <p className="font-medium text-foreground">{statusDialogReservation.guest_name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {format(new Date(`${statusDialogReservation.date}T12:00:00`), 'dd/MM/yyyy')} as {statusDialogReservation.time.slice(0, 5)}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="calendar-reservation-status">Status</Label>
                <Select value={editStatus} onValueChange={(value) => setEditStatus(value as ReservationStatus)}>
                  <SelectTrigger id="calendar-reservation-status" aria-label="Selecionar status da reserva">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="confirmed">Confirmada</SelectItem>
                    <SelectItem value="checked_in">Check-in realizado</SelectItem>
                    <SelectItem value="cancelled">Cancelada</SelectItem>
                    <SelectItem value="no-show">Nao compareceu</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editStatus === 'checked_in' && (
                <div className="space-y-2 rounded-2xl border border-border bg-muted/20 p-4">
                  <Label htmlFor="calendar-checked-in-party-size">Total presente</Label>
                  <Input
                    id="calendar-checked-in-party-size"
                    type="number"
                    min="1"
                    max="50"
                    value={checkedInPartySize}
                    onChange={(event) => setCheckedInPartySize(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use essa quantidade para registrar quantas pessoas realmente chegaram.
                  </p>
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => handleStatusDialogChange(false)}>
                  Fechar
                </Button>
                <Button type="button" onClick={handleSaveStatus} disabled={saveStatusMutation.isPending}>
                  {saveStatusMutation.isPending ? 'Salvando...' : editStatus === 'checked_in' ? 'Confirmar check-in' : 'Salvar'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editDialogReservation} onOpenChange={handleEditDialogChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Editar reserva</DialogTitle>
          </DialogHeader>

          {editDialogReservation && editForm && (
            <div className="space-y-4 pt-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-name">Nome</Label>
                  <Input
                    id="calendar-edit-name"
                    value={editForm.guest_name}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_name: event.target.value } : current)
                    }
                    autoComplete="name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-phone">WhatsApp</Label>
                  <Input
                    id="calendar-edit-phone"
                    value={editForm.guest_phone}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_phone: formatBrazilPhone(event.target.value) } : current)
                    }
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={15}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-email">E-mail</Label>
                  <Input
                    id="calendar-edit-email"
                    type="email"
                    value={editForm.guest_email}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, guest_email: event.target.value } : current)
                    }
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-party-size">Pessoas</Label>
                  <Input
                    id="calendar-edit-party-size"
                    type="number"
                    min="1"
                    max="50"
                    value={editForm.party_size}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, party_size: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-date">Data</Label>
                  <Input
                    id="calendar-edit-date"
                    type="date"
                    value={editForm.date}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, date: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="calendar-edit-time">Horario</Label>
                  <Input
                    id="calendar-edit-time"
                    type="time"
                    value={editForm.time}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, time: event.target.value } : current)
                    }
                  />
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="calendar-edit-occasion">Ocasiao</Label>
                  <Input
                    id="calendar-edit-occasion"
                    value={editForm.occasion}
                    onChange={(event) =>
                      setEditForm((current) => current ? { ...current, occasion: event.target.value } : current)
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="calendar-edit-notes">Observacoes</Label>
                <Textarea
                  id="calendar-edit-notes"
                  value={editForm.notes}
                  onChange={(event) =>
                    setEditForm((current) => current ? { ...current, notes: event.target.value } : current)
                  }
                  rows={4}
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => handleEditDialogChange(false)}>
                  Fechar
                </Button>
                <Button type="button" onClick={handleSaveReservation} disabled={updateReservationMutation.isPending}>
                  {updateReservationMutation.isPending ? 'Salvando...' : 'Salvar alteracoes'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!cancelReservation} onOpenChange={(open) => !open && setCancelReservation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar reserva?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelReservation
                ? `A reserva de ${cancelReservation.guest_name} sera marcada como cancelada.`
                : 'Confirme o cancelamento da reserva.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const reservation = cancelReservation;
                setCancelReservation(null);

                if (!reservation) {
                  return;
                }

                saveStatusMutation.mutate({
                  reservationId: reservation.id,
                  status: 'cancelled',
                });
              }}
            >
              Confirmar cancelamento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
