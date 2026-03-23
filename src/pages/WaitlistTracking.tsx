import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Clock, Users, MapPin, Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface WaitlistEntry {
  id: string;
  guest_name: string;
  party_size: number;
  tracking_code: string;
  status: string;
  position: number;
  created_at: string;
  called_at: string | null;
  company_id: string;
}

const statusMessages: Record<string, { icon: any; title: string; description: string; color: string }> = {
  waiting: {
    icon: Clock,
    title: 'Aguardando',
    description: 'Você está na fila! Fique atento ao seu WhatsApp.',
    color: 'text-amber-600',
  },
  called: {
    icon: AlertCircle,
    title: 'Sua vez!',
    description: 'Dirija-se à recepção. Sua mesa está pronta!',
    color: 'text-blue-600',
  },
  seated: {
    icon: CheckCircle2,
    title: 'Sentado',
    description: 'Bom apetite! Aproveite sua experiência.',
    color: 'text-primary',
  },
  expired: {
    icon: XCircle,
    title: 'Expirado',
    description: 'Seu tempo de espera expirou. Procure a recepção se ainda estiver no local.',
    color: 'text-muted-foreground',
  },
  removed: {
    icon: XCircle,
    title: 'Removido',
    description: 'Você foi removido da lista de espera.',
    color: 'text-muted-foreground',
  },
};

export default function WaitlistTracking() {
  const { slug, code } = useParams<{ slug: string; code: string }>();

  const { data: entry, isLoading, error } = useQuery({
    queryKey: ['waitlist-tracking', code],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc('get_waitlist_by_tracking_code', { _tracking_code: code! });
      if (error) throw error;
      const rows = data as unknown as WaitlistEntry[];
      return rows && rows.length > 0 ? rows[0] : null;
    },
    enabled: !!code,
    refetchInterval: 5000,
  });

  // Count people ahead
  const { data: aheadCount = 0 } = useQuery({
    queryKey: ['waitlist-ahead', entry?.company_id, entry?.position],
    queryFn: async () => {
      if (!entry) return 0;
      const { data, error } = await supabase
        .rpc('get_waitlist_ahead_count', {
          _company_id: entry.company_id,
          _position: entry.position,
        });
      if (error) return 0;
      return (data as number) || 0;
    },
    enabled: !!entry && entry.status === 'waiting',
    refetchInterval: 5000,
  });

  // Get company name + real average wait time
  const { data: company } = useQuery({
    queryKey: ['company-public-waitlist', slug],
    queryFn: async () => {
      const { data } = await supabase
        .from('companies_public' as any)
        .select('name, logo_url')
        .eq('slug', slug!)
        .maybeSingle();
      return data as any;
    },
    enabled: !!slug,
  });

  // Fetch today's average wait from seated entries
  const { data: avgWaitPerPerson = 10 } = useQuery({
    queryKey: ['waitlist-avg-wait', entry?.company_id],
    queryFn: async () => {
      if (!entry) return 10;
      const { data, error } = await supabase
        .rpc('get_waitlist_avg_wait', { _company_id: entry.company_id });
      if (error) return 10;
      return Math.max(5, (data as number) || 10);
    },
    enabled: !!entry && entry.status === 'waiting',
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full border-none shadow-lg">
          <CardContent className="py-12 text-center">
            <XCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="text-xl font-bold mb-2">Entrada não encontrada</h2>
            <p className="text-muted-foreground">Este código de acompanhamento é inválido ou expirou.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = statusMessages[entry.status] || statusMessages.waiting;
  const StatusIcon = status.icon;
  const estimatedWait = aheadCount * avgWaitPerPerson;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          {company?.logo_url && (
            <img src={company.logo_url} alt={company.name} className="h-12 w-12 mx-auto rounded-xl object-cover" />
          )}
          <h1 className="text-xl font-bold">{company?.name || slug}</h1>
          <p className="text-sm text-muted-foreground">Lista de Espera</p>
        </div>

        {/* Status Card */}
        <Card className="border-none shadow-lg overflow-hidden">
          <div className={`h-1.5 ${entry.status === 'called' ? 'bg-blue-500 animate-pulse' : entry.status === 'waiting' ? 'bg-amber-500' : 'bg-primary'}`} />
          <CardContent className="p-6 text-center space-y-4">
            <StatusIcon className={`h-14 w-14 mx-auto ${status.color} ${entry.status === 'called' ? 'animate-bounce' : ''}`} />
            <div>
              <h2 className={`text-2xl font-bold ${status.color}`}>{status.title}</h2>
              <p className="text-muted-foreground mt-1">{status.description}</p>
            </div>

            {entry.status === 'waiting' && (
              <div className="space-y-4 pt-2">
                <div className="flex justify-center gap-8">
                  <div className="text-center">
                    <p className="text-4xl font-bold text-foreground">{aheadCount}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {aheadCount === 1 ? 'pessoa na frente' : 'pessoas na frente'}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-4xl font-bold text-foreground">~{estimatedWait}<span className="text-lg">min</span></p>
                    <p className="text-xs text-muted-foreground mt-1">tempo estimado</p>
                  </div>
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-border space-y-2 text-sm text-left">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Nome</span>
                <span className="font-medium">{entry.guest_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pessoas</span>
                <span className="font-medium">{entry.party_size}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Na fila há</span>
                <span className="font-medium">{formatDistanceToNow(new Date(entry.created_at), { locale: ptBR })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Código</span>
                <span className="font-mono font-medium">{entry.tracking_code}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-muted-foreground">
          Esta página atualiza automaticamente. Não é necessário recarregar.
        </p>
      </div>
    </div>
  );
}
