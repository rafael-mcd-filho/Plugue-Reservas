import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
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
import {
  formatWaitlistCountdown,
  getWaitlistCallRemainingMs,
  hasWaitlistCallExpired,
  WAITLIST_CALL_TIMEOUT_MINUTES,
} from '@/lib/waitlist';
import { isValidCompanySlug } from '@/lib/validation';

interface WaitlistEntry {
  id: string;
  guest_name: string;
  party_size: number;
  tracking_code: string;
  status: string;
  position: number;
  created_at: string;
  called_at: string | null;
  ahead_count: number;
  avg_wait_minutes: number;
}

interface LeaveWaitlistResult {
  id: string;
  tracking_code: string;
  status: string;
  left_waitlist: boolean;
}

const statusMessages: Record<string, { icon: typeof Clock; title: string; description: string; color: string }> = {
  waiting: {
    icon: Clock,
    title: 'Aguardando',
    description: 'Você está na fila. Fique atento ao seu WhatsApp.',
    color: 'text-primary',
  },
  called: {
    icon: AlertCircle,
    title: 'Sua vez!',
    description: 'Dirija-se à recepção. Sua mesa está pronta.',
    color: 'text-info',
  },
  seated: {
    icon: CheckCircle2,
    title: 'Sentado',
    description: 'Bom apetite. Aproveite sua experiência.',
    color: 'text-success',
  },
  expired: {
    icon: XCircle,
    title: 'Expirado',
    description: 'Seu tempo de espera expirou. Procure a recepção se ainda estiver no local.',
    color: 'text-muted-foreground',
  },
  removed: {
    icon: XCircle,
    title: 'Encerrado',
    description: 'Sua entrada na fila foi encerrada.',
    color: 'text-muted-foreground',
  },
};

export default function WaitlistTracking() {
  const { slug, code } = useParams<{ slug: string; code: string }>();
  const queryClient = useQueryClient();
  const slugIsValid = isValidCompanySlug(slug);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: entry, isLoading } = useQuery({
    queryKey: ['waitlist-tracking', code],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_waitlist_by_tracking_code', {
        _tracking_code: code!,
        _visitor_id: getVisitorId(),
      });
      if (error) throw error;
      const rows = data as unknown as WaitlistEntry[];
      return rows.length > 0 ? rows[0] : null;
    },
    enabled: !!code,
    refetchInterval: 5000,
  });

  const { data: company } = useQuery({
    queryKey: ['company-public-waitlist', slug],
    queryFn: async () => {
      const rpcResult = await (supabase as any).rpc('get_public_company_by_slug', { _slug: slug! });
      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as Array<{ name: string; logo_url: string | null }>;
        return rows.length > 0 ? rows[0] : null;
      }

      const { data, error } = await supabase
        .from('companies_public' as any)
        .select('name, logo_url')
        .eq('slug', slug!)
        .maybeSingle();

      if (error) throw error;
      return data as { name: string; logo_url: string | null } | null;
    },
    enabled: slugIsValid,
  });

  const leaveWaitlist = useMutation({
    mutationFn: async () => {
      if (!code) {
        throw new Error('Código de acompanhamento inválido.');
      }

      const { data, error } = await (supabase as any).rpc('leave_public_waitlist', {
        _tracking_code: code,
        _visitor_id: getVisitorId(),
      });

      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.id) {
        throw new Error('Não foi possível sair da fila agora.');
      }

      return row as LeaveWaitlistResult;
    },
    onSuccess: async (result) => {
      setLeaveDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['waitlist-tracking', code] });

      if (result.left_waitlist) {
        toast.success('Você saiu da fila com sucesso.');
        return;
      }

      if (result.status === 'seated') {
        toast.info('Essa entrada já foi atendida.');
        return;
      }

      toast.info('Essa entrada já não está mais ativa.');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível sair da fila agora.');
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!slugIsValid || !entry) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md border border-border shadow-sm">
          <CardContent className="py-12 text-center">
            <XCircle className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="mb-2 text-xl font-bold">Entrada não encontrada</h2>
            <p className="text-muted-foreground">Este código de acompanhamento é inválido ou expirou.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = statusMessages[entry.status] || statusMessages.waiting;
  const StatusIcon = status.icon;
  const estimatedWait = entry.ahead_count * entry.avg_wait_minutes;
  const canLeaveWaitlist = entry.status === 'waiting' || entry.status === 'called';
  const calledRemainingMs = getWaitlistCallRemainingMs(entry.called_at, nowMs);
  const calledExpired = entry.status === 'called' && hasWaitlistCallExpired(entry.called_at, nowMs);
  const calledCountdown = formatWaitlistCountdown(calledRemainingMs);
  const cardAccentClassName = entry.status === 'called'
    ? (calledExpired ? 'bg-destructive' : 'bg-info animate-pulse')
    : entry.status === 'waiting'
      ? 'bg-primary'
      : 'bg-success';

  return (
    <>
      <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            {company?.logo_url && (
              <img
                src={company.logo_url}
                alt={company.name}
                className="mx-auto h-12 w-12 rounded-md object-cover"
              />
            )}
            <h1 className="text-xl font-bold">{company?.name || slug}</h1>
            <p className="text-sm text-muted-foreground">Lista de espera</p>
          </div>

          <Card className="overflow-hidden border border-border shadow-sm">
            <div className={`h-1.5 ${cardAccentClassName}`} />
            <CardContent className="space-y-4 p-6 text-center">
              <StatusIcon
                className={`mx-auto h-10 w-10 ${calledExpired ? 'text-destructive' : status.color} ${entry.status === 'called' && !calledExpired ? 'animate-bounce' : ''}`}
              />

              <div>
                <h2 className={`text-lg font-bold ${calledExpired ? 'text-destructive' : status.color}`}>{status.title}</h2>
                <p className="mt-1 text-muted-foreground">
                  {entry.status === 'called'
                    ? `Dirija-se à recepção. Você tem ${WAITLIST_CALL_TIMEOUT_MINUTES} minutos para se apresentar.`
                    : status.description}
                </p>
              </div>

              {entry.status === 'waiting' && (
                <div className="space-y-4 pt-2">
                  <div className="flex justify-center gap-8">
                    <div className="text-center">
                      <p className="text-2xl font-bold text-foreground">{entry.ahead_count}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.ahead_count === 1 ? 'pessoa na frente' : 'pessoas na frente'}
                      </p>
                    </div>

                    <div className="text-center">
                      <p className="text-2xl font-bold text-foreground">
                        ~{estimatedWait}
                        <span className="text-lg">min</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">tempo estimado</p>
                    </div>
                  </div>
                </div>
              )}

              {entry.status === 'called' && (
                <div
                  className={calledExpired
                    ? 'rounded-2xl border border-destructive/30 bg-destructive-soft p-4'
                    : 'rounded-2xl border border-info/30 bg-info-soft p-4'}
                >
                  <p className={`text-xs font-medium uppercase tracking-[0.12em] ${calledExpired ? 'text-destructive' : 'text-info'}`}>
                    {calledExpired ? 'Tempo esgotado' : 'Tempo restante para chegar'}
                  </p>
                  <p className={`mt-2 text-3xl font-semibold tabular-nums ${calledExpired ? 'text-destructive' : 'text-foreground'}`}>
                    {calledCountdown}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {calledExpired
                      ? 'O prazo de apresentação terminou. Procure a recepção se ainda estiver no local.'
                      : 'Ao chegar na recepção, a equipe vai confirmar sua entrada.'}
                  </p>
                </div>
              )}

              <div className="space-y-2 border-t border-border pt-4 text-left text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Nome</span>
                  <span className="font-medium text-right">{entry.guest_name}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Pessoas</span>
                  <span className="font-medium">{entry.party_size}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Na fila há</span>
                  <span className="font-medium">
                    {formatDistanceToNow(new Date(entry.created_at), { locale: ptBR })}
                  </span>
                </div>
              </div>

              {canLeaveWaitlist && (
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs text-muted-foreground">
                    Se não quiser mais aguardar, você pode sair da fila por aqui.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-destructive/30 text-destructive hover:text-destructive"
                    onClick={() => setLeaveDialogOpen(true)}
                    disabled={leaveWaitlist.isPending}
                  >
                    {leaveWaitlist.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Sair da fila
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted-foreground">
            Esta página atualiza automaticamente. Não é necessário recarregar.
          </p>
        </div>
      </div>

      <AlertDialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair da fila?</AlertDialogTitle>
            <AlertDialogDescription>
              Sua entrada será encerrada e você perderá sua posição atual. Se quiser voltar depois, será preciso entrar
              novamente na fila.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveWaitlist.isPending}>Continuar aguardando</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                leaveWaitlist.mutate();
              }}
              disabled={leaveWaitlist.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaveWaitlist.isPending ? 'Saindo...' : 'Sair da fila'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
