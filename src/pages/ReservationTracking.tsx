import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, MapPin, XCircle } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
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
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import { isValidCompanySlug } from '@/lib/validation';

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

const statusMessages: Record<string, { icon: typeof CheckCircle2; title: string; description: string; color: string }> = {
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
  no_show: {
    icon: AlertCircle,
    title: 'Não compareceu',
    description: 'Esta reserva foi marcada como não comparecimento.',
    color: 'text-muted-foreground',
  },
};

export default function ReservationTracking() {
  const { slug, code } = useParams<{ slug: string; code: string }>();
  const queryClient = useQueryClient();
  const slugIsValid = isValidCompanySlug(slug);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const { data: company, isLoading: companyLoading, error: companyError } = useQuery({
    queryKey: ['company-public-reservation', slug],
    queryFn: async () => {
      const rpcResult = await (supabase as any).rpc('get_public_company_by_slug', { _slug: slug! });

      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as Array<{ id: string; name: string; logo_url: string | null }>;
        return rows.length > 0 ? rows[0] : null;
      }

      const { data, error } = await supabase
        .from('companies_public' as any)
        .select('id, name, logo_url')
        .eq('slug', slug!)
        .maybeSingle();

      if (error) throw error;
      return data as { id: string; name: string; logo_url: string | null } | null;
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

  const status = statusMessages[entry.status] || statusMessages.confirmed;
  const StatusIcon = status.icon;
  const canCancel = entry.status === 'confirmed';

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
                entry.status === 'cancelled'
                  ? 'bg-destructive'
                  : entry.status === 'confirmed'
                    ? 'bg-primary'
                    : entry.status === 'checked_in' || entry.status === 'completed'
                      ? 'bg-info'
                      : 'bg-success'
              }`}
            />
            <CardContent className="space-y-4 p-6 text-center">
              <StatusIcon className={`mx-auto h-10 w-10 ${status.color}`} />

              <div>
                <h2 className={`text-lg font-bold ${status.color}`}>{status.title}</h2>
                <p className="mt-1 text-muted-foreground">{status.description}</p>
              </div>

              <div className="space-y-2 border-t border-border pt-4 text-left text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Nome</span>
                  <span className="text-right font-medium">{entry.guest_name}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Data</span>
                  <span className="font-medium">
                    {format(new Date(`${entry.date}T12:00:00`), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
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
                  <span className="text-muted-foreground">Criada há</span>
                  <span className="font-medium">
                    {formatDistanceToNow(new Date(entry.created_at), { locale: ptBR })}
                  </span>
                </div>
              </div>

              {canCancel && (
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs text-muted-foreground">
                    Se não puder comparecer, você pode cancelar a própria reserva por aqui.
                  </p>
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
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

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
