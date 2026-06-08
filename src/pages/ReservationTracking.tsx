import { useEffect, useState, type SVGProps } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CheckCircle2, Clock3, CreditCard, Loader2, MapPin, Pencil, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';
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
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import { checkReservationPayment, getReservationPaymentByTrackingCode } from '@/lib/asaas-prepayment-api';
import { removePublicCompanyIcons, syncPublicCompanyIcons } from '@/lib/publicCompanyIcons';
import { normalizeReservationLateToleranceMinutes } from '@/lib/reservation-flow';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { isValidCompanySlug, toBrazilWhatsAppNumber } from '@/lib/validation';
import type { ReservationStatus } from '@/types/restaurant';

function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.25a9.75 9.75 0 0 0-8.35 14.78L2.3 21.7l4.84-1.27A9.75 9.75 0 1 0 12 2.25Z"
      />
      <path
        fill="white"
        d="M9.25 6.65c-.23 0-.45.11-.63.31-.31.33-.82.83-.82 1.94s.81 2.18.92 2.33c.11.14 1.58 2.52 3.83 3.44 1.87.75 2.25.6 2.66.56.41-.04 1.32-.54 1.51-1.06.19-.53.19-.97.13-1.06-.05-.09-.19-.15-.39-.25-.2-.1-1.16-.57-1.34-.64-.18-.06-.31-.09-.45.12-.13.2-.52.63-.63.77-.12.13-.24.15-.43.05-.2-.1-.84-.31-1.6-1-.59-.53-.99-1.19-1.12-1.39-.12-.2-.02-.3.09-.4.09-.09.2-.23.3-.34.1-.11.13-.2.2-.32.07-.13.03-.25-.01-.34-.05-.1-.44-1.12-.61-1.53-.16-.39-.33-.4-.45-.4h-.38Z"
      />
    </svg>
  );
}

interface ReservationEntry {
  id: string;
  company_id: string;
  guest_name: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
  occasion: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  public_tracking_code: string;
}

interface CancelReservationResult {
  id: string;
  public_tracking_code: string;
  status: string;
  cancelled: boolean;
}

const statusMessages: Record<ReservationStatus | 'completed' | 'no_show', { icon: typeof CheckCircle2; title: string; description: string; color: string }> = {
  pending_payment: {
    icon: Clock3,
    title: 'Aguardando pagamento',
    description: 'Sua mesa fica reservada temporariamente enquanto o pagamento aguarda confirmação.',
    color: 'text-warning',
  },
  confirmed: {
    icon: CheckCircle2,
    title: 'Reserva confirmada',
    description: 'Sua reserva está confirmada. Se precisar, você pode cancelar por esta página.',
    color: 'text-primary',
  },
  checked_in: {
    icon: CheckCircle2,
    title: 'Check-in realizado',
    description: 'Sua chegada já foi registrada pela equipe.',
    color: 'text-info',
  },
  cancelled: {
    icon: XCircle,
    title: 'Reserva cancelada',
    description: 'Esta reserva foi cancelada.',
    color: 'text-destructive',
  },
  completed: {
    icon: CheckCircle2,
    title: 'Check-in realizado',
    description: 'Sua chegada já foi registrada pela equipe.',
    color: 'text-info',
  },
  'no-show': {
    icon: AlertCircle,
    title: 'Não compareceu',
    description: 'Esta reserva foi marcada como não comparecimento.',
    color: 'text-muted-foreground',
  },
  payment_expired: {
    icon: XCircle,
    title: 'Pagamento expirado',
    description: 'O prazo de pagamento terminou e a mesa foi liberada.',
    color: 'text-muted-foreground',
  },
  payment_cancelled: {
    icon: XCircle,
    title: 'Pagamento cancelado',
    description: 'O link de pagamento desta pré-reserva foi cancelado.',
    color: 'text-destructive',
  },
  paid_after_expiration: {
    icon: AlertCircle,
    title: 'Pagamento em análise',
    description: 'O pagamento foi detectado depois do prazo e precisa de validação da equipe.',
    color: 'text-warning',
  },
  no_show: {
    icon: AlertCircle,
    title: 'Não compareceu',
    description: 'Esta reserva foi marcada como não comparecimento.',
    color: 'text-muted-foreground',
  },
};

function getStatusMessage(status: ReservationStatus | 'completed' | 'no_show') {
  return statusMessages[status === 'no_show' ? 'no-show' : status];
}

export default function ReservationTracking() {
  const { slug, code } = useParams<{ slug: string; code: string }>();
  const queryClient = useQueryClient();
  const slugIsValid = isValidCompanySlug(slug);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const { data: company, isLoading: companyLoading, error: companyError } = useQuery({
    queryKey: ['company-public-reservation', slug],
    queryFn: async () => {
      const rpcResult = await (supabase as any).rpc('get_public_company_by_slug', { _slug: slug! });

      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as Array<{
          id: string;
          name: string;
          logo_url: string | null;
          whatsapp: string | null;
          reservation_late_tolerance_minutes?: number | null;
        }>;
        return rows.length > 0 ? rows[0] : null;
      }

      const { data, error } = await supabase
        .from('companies_public' as any)
        .select('id, name, logo_url, whatsapp, reservation_late_tolerance_minutes')
        .eq('slug', slug!)
        .maybeSingle();

      if (error) throw error;
      return data as unknown as {
        id: string;
        name: string;
        logo_url: string | null;
        whatsapp: string | null;
        reservation_late_tolerance_minutes?: number | null;
      } | null;
    },
    enabled: slugIsValid,
  });

  const { data: entry, isLoading: entryLoading } = useQuery({
    queryKey: ['reservation-tracking', code],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_public_reservation_by_tracking_code', {
        _tracking_code: code!,
        _visitor_id: getVisitorId(),
      });
      if (error) throw error;
      const rows = data as ReservationEntry[];
      return rows.length > 0 ? rows[0] : null;
    },
    enabled: !!code,
    refetchInterval: 10000,
  });

  const cancelReservation = useMutation({
    mutationFn: async () => {
      if (!code) {
        throw new Error('Código de acompanhamento inválido.');
      }

      const { data, error } = await (supabase as any).rpc('cancel_public_reservation', {
        _tracking_code: code,
        _visitor_id: getVisitorId(),
      });

      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.id) {
        throw new Error('Não foi possível cancelar a reserva agora.');
      }

      return row as CancelReservationResult;
    },
    onSuccess: async (result) => {
      setCancelDialogOpen(false);

      await queryClient.invalidateQueries({ queryKey: ['reservation-tracking', code] });

      if (!result.cancelled) {
        toast.info('Essa reserva já não pode mais ser cancelada.');
        return;
      }

      toast.success('Reserva cancelada com sucesso.');

      supabase.functions.invoke('reservation-events', {
        body: {
          event: 'reservation_cancelled',
          reservation: {
            id: result.id,
            tracking_code: result.public_tracking_code,
          },
        },
      }).catch((invokeError) => {
        console.warn('Public reservation cancellation notification error:', invokeError);
      });
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível cancelar a reserva agora.');
    },
  });

  const isLoading = companyLoading || entryLoading;
  const isPendingPayment = entry?.status === 'pending_payment';

  const paymentQuery = useQuery({
    queryKey: ['reservation-tracking-payment', code],
    queryFn: () => getReservationPaymentByTrackingCode(code!),
    enabled: Boolean(code) && isPendingPayment,
    retry: false,
    refetchInterval: 10000,
  });
  const activePayment = paymentQuery.data;
  const paymentIsActive =
    !!activePayment &&
    (activePayment.status === 'pending' || activePayment.status === 'awaiting_method') &&
    new Date(activePayment.expires_at).getTime() > Date.now();
  const paymentResumeUrl = paymentIsActive ? `/pagamento/${activePayment!.payment_token}` : null;
  const paymentNeedsExpireCheck =
    !!activePayment &&
    (
      activePayment.status === 'expired'
      || activePayment.status === 'cancelled'
      || activePayment.status === 'failed'
      || ((activePayment.status === 'pending' || activePayment.status === 'awaiting_method') &&
        new Date(activePayment.expires_at).getTime() <= Date.now())
    );

  const reconcileExpiredPayment = useMutation({
    mutationFn: (token: string) => checkReservationPayment(token),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['reservation-tracking', code] });
      await queryClient.invalidateQueries({ queryKey: ['reservation-tracking-payment', code] });
    },
  });

  useEffect(() => {
    if (!isPendingPayment) return;
    if (!paymentNeedsExpireCheck) return;
    if (!activePayment?.payment_token) return;
    if (reconcileExpiredPayment.isPending) return;
    reconcileExpiredPayment.mutate(activePayment.payment_token);
  }, [isPendingPayment, paymentNeedsExpireCheck, activePayment?.payment_token, reconcileExpiredPayment]);

  useEffect(() => {
    syncPublicCompanyIcons(company?.logo_url);
    return () => removePublicCompanyIcons();
  }, [company?.logo_url]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!slugIsValid || companyError || !company || !entry || entry.company_id !== company.id) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md border border-border shadow-sm">
          <CardContent className="space-y-4 py-10 text-center">
            <MapPin className="mx-auto h-12 w-12 text-muted-foreground" />
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">Link indisponível</h1>
              <p className="text-sm text-muted-foreground">
                Esta reserva não foi encontrada ou este link não corresponde a esta unidade.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const normalizedStatus = normalizeReservationStatus(entry.status);
  const status = getStatusMessage(normalizedStatus) || statusMessages.confirmed;
  const StatusIcon = status.icon;
  const canCancel = normalizedStatus === 'confirmed';
  const canStartNewReservation =
    normalizedStatus === 'cancelled'
    || normalizedStatus === 'no-show'
    || normalizedStatus === 'payment_expired';
  const lateToleranceMinutes = normalizeReservationLateToleranceMinutes(company.reservation_late_tolerance_minutes);
  const showLateToleranceNotice = normalizedStatus === 'confirmed' && lateToleranceMinutes > 0;
  const lateToleranceUnit = lateToleranceMinutes === 1 ? 'minuto' : 'minutos';

  return (
    <>
      <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            {company.logo_url && (
              <img src={company.logo_url} alt={company.name} className="mx-auto h-12 w-12 rounded-md object-cover" />
            )}
            <h1 className="text-xl font-bold">{company.name}</h1>
            <p className="text-sm text-muted-foreground">Acompanhamento da reserva</p>
          </div>

          <Card className="overflow-hidden border border-border shadow-sm">
            <div
              className={`h-1.5 ${
                normalizedStatus === 'cancelled'
                  ? 'bg-destructive'
                  : normalizedStatus === 'confirmed'
                    ? 'bg-primary'
                    : normalizedStatus === 'checked_in'
                      ? 'bg-info'
                      : 'bg-muted-foreground/30'
              }`}
            />
            <CardContent className="space-y-4 p-6 text-center">
              <StatusIcon className={`mx-auto h-10 w-10 ${status.color}`} />

              <div>
                <h2 className={`text-lg font-bold ${status.color}`}>{status.title}</h2>
                <p className="mt-1 text-muted-foreground">{status.description}</p>
                {(normalizedStatus === 'cancelled' || normalizedStatus === 'no-show') && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {format(new Date(entry.updated_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </p>
                )}
              </div>

              {showLateToleranceNotice && (
                <div className="rounded-xl border border-primary/15 bg-primary/5 p-4 text-left">
                  <div className="flex items-start gap-3">
                    <div className="rounded-full bg-primary/10 p-2 text-primary">
                      <Clock3 className="h-4 w-4" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">Tolerância de atraso</p>
                      <p className="text-sm leading-6 text-muted-foreground">
                        Existe tolerância de até {lateToleranceMinutes} {lateToleranceUnit} de atraso no horário da sua reserva.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2 border-t border-border pt-4 text-left text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Nome</span>
                  <span className="text-right font-medium">{entry.guest_name}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Data</span>
                  <span className="text-right font-medium">
                    {format(new Date(`${entry.date}T12:00:00`), 'dd/MM/yyyy')}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Horário</span>
                  <span className="font-medium">{entry.time.slice(0, 5)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Pessoas</span>
                  <span className="font-medium">{entry.party_size}</span>
                </div>
                {entry.occasion && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Ocasião</span>
                    <span className="text-right font-medium">{entry.occasion}</span>
                  </div>
                )}
                {entry.notes && (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Observações</span>
                    <span className="text-right font-medium">{entry.notes}</span>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Criada em</span>
                  <span className="text-right font-medium">
                    {format(new Date(entry.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </span>
                </div>
              </div>

              {canCancel && (
                <div className="space-y-3 border-t border-border pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => setEditDialogOpen(true)}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Alterar reserva
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-destructive/30 text-destructive hover:text-destructive"
                    onClick={() => setCancelDialogOpen(true)}
                    disabled={cancelReservation.isPending}
                  >
                    {cancelReservation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Cancelar reserva
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Se não puder comparecer, você pode cancelar a própria reserva.
                  </p>
                </div>
              )}
              {isPendingPayment && paymentResumeUrl && (
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs text-muted-foreground">
                    Sua mesa fica bloqueada até o pagamento ser concluído. Conclua dentro do prazo para confirmar a reserva.
                  </p>
                  <Button asChild className="w-full">
                    <Link to={paymentResumeUrl}>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Continuar pagamento
                    </Link>
                  </Button>
                </div>
              )}
              {canStartNewReservation && (
                <div className="space-y-3 border-t border-border pt-4">
                  <Button asChild className="h-11 w-full rounded-lg shadow-sm">
                    <Link to={`/${slug}`}>
                      Fazer nova reserva
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AlterReservationDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        companyName={company.name}
        companyWhatsapp={company.whatsapp ?? null}
        guestName={entry.guest_name}
        date={entry.date}
        time={entry.time}
        partySize={entry.party_size}
      />

      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar reserva?</AlertDialogTitle>
            <AlertDialogDescription>
              Sua reserva será cancelada imediatamente. Se quiser voltar depois, será preciso criar uma nova reserva.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelReservation.isPending}>Manter reserva</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                cancelReservation.mutate();
              }}
              disabled={cancelReservation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelReservation.isPending ? 'Cancelando...' : 'Cancelar reserva'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AlterReservationDialog({
  open,
  onOpenChange,
  companyName,
  companyWhatsapp,
  guestName,
  date,
  time,
  partySize,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyName: string;
  companyWhatsapp: string | null;
  guestName: string;
  date: string;
  time: string;
  partySize: number;
}) {
  const whatsappNumber = toBrazilWhatsAppNumber(companyWhatsapp);
  const formattedDate = format(new Date(`${date}T12:00:00`), "dd/MM/yyyy", { locale: ptBR });
  const formattedTime = time.slice(0, 5);
  const message =
    `Olá! Gostaria de alterar uma reserva em ${companyName}.\n` +
    `Nome: ${guestName}\n` +
    `Data: ${formattedDate}\n` +
    `Horário: ${formattedTime}\n` +
    `Pessoas: ${partySize}`;
  const whatsappUrl = whatsappNumber
    ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Alterar reserva</DialogTitle>
          <DialogDescription>
            Alterações de reserva são feitas de forma rápida pelo WhatsApp. Clique no botão abaixo para falar com o restaurante.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          {whatsappUrl ? (
            <Button asChild className="bg-emerald-600 text-white hover:bg-emerald-700">
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon className="mr-2 h-4 w-4" />
                Falar pelo WhatsApp
              </a>
            </Button>
          ) : (
            <Button disabled>WhatsApp indisponível</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
