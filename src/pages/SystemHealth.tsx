import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Activity, Database, MessageSquare, Wifi, WifiOff, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock, Inbox, Server, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

function useSystemHealth() {
  return useQuery({
    queryKey: ['system-health'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('system-health');
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000, // auto-refresh every 30s
  });
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'healthy' || status === 'connected') return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === 'error' || status === 'disconnected') return <XCircle className="h-5 w-5 text-destructive" />;
  if (status === 'not_configured') return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  return <AlertTriangle className="h-5 w-5 text-amber-500" />;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
    healthy: { label: 'Saudável', variant: 'default' },
    connected: { label: 'Conectado', variant: 'default' },
    error: { label: 'Erro', variant: 'destructive' },
    disconnected: { label: 'Desconectado', variant: 'destructive' },
    not_configured: { label: 'Não configurado', variant: 'secondary' },
    unreachable: { label: 'Inacessível', variant: 'destructive' },
  };
  const config = map[status] || { label: status, variant: 'outline' as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export default function SystemHealth() {
  const { data, isLoading, refetch, isFetching } = useSystemHealth();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Activity className="h-8 w-8 text-primary" />
            Saúde do Sistema
          </h1>
          <p className="text-muted-foreground mt-1">Monitoramento em tempo real dos serviços</p>
        </div>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Atualizar
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i} className="border-none shadow-sm">
              <CardContent className="p-6"><Skeleton className="h-20 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : !data ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <AlertTriangle className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>Não foi possível obter dados de saúde do sistema.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Service Status Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <ServiceCard
              icon={<Database className="h-5 w-5" />}
              title="Banco de Dados"
              status={data.database?.status}
              detail={`${data.database?.responseMs}ms`}
              error={data.database?.error}
            />
            <ServiceCard
              icon={<Server className="h-5 w-5" />}
              title="Evolution API"
              status={data.evolutionApi?.status}
              detail={data.evolutionApi?.responseMs ? `${data.evolutionApi.responseMs}ms` : undefined}
              error={data.evolutionApi?.error}
            />
            <ServiceCard
              icon={<MessageSquare className="h-5 w-5" />}
              title="Fila de Mensagens"
              status={data.messageQueue?.failed > 0 ? 'error' : data.messageQueue?.pending > 0 ? 'warning' : 'healthy'}
              detail={`${data.messageQueue?.pending || 0} pendentes`}
            />
            <ServiceCard
              icon={<Wifi className="h-5 w-5" />}
              title="WhatsApp"
              status={data.whatsapp?.disconnected > 0 ? 'error' : 'healthy'}
              detail={`${data.whatsapp?.connected || 0}/${data.whatsapp?.total || 0} conectados`}
            />
          </div>

          {/* Quick Stats */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-none shadow-sm">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="p-3 rounded-lg bg-primary/10">
                  <Inbox className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{data.reservationsToday || 0}</p>
                  <p className="text-sm text-muted-foreground">Reservas hoje</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-none shadow-sm">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="p-3 rounded-lg bg-amber-500/10">
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{data.messageQueue?.pending || 0}</p>
                  <p className="text-sm text-muted-foreground">Mensagens na fila</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-none shadow-sm">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="p-3 rounded-lg bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{data.messageQueue?.failed || 0}</p>
                  <p className="text-sm text-muted-foreground">Mensagens com erro</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* WhatsApp Instances */}
          {data.whatsapp?.instances?.length > 0 && (
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wifi className="h-4 w-4" /> Instâncias WhatsApp
                </CardTitle>
                <CardDescription>{data.whatsapp.total} instância(s) registrada(s)</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Instância</TableHead>
                      <TableHead>Empresa</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Última atualização</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.whatsapp.instances.map((inst: any) => (
                      <TableRow key={inst.id}>
                        <TableCell className="font-medium">{inst.instance_name}</TableCell>
                        <TableCell className="text-muted-foreground">{inst.company_name}</TableCell>
                        <TableCell className="text-muted-foreground">{inst.phone_number || '—'}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {inst.status === 'connected' ? (
                              <Wifi className="h-4 w-4 text-emerald-500" />
                            ) : (
                              <WifiOff className="h-4 w-4 text-destructive" />
                            )}
                            <StatusBadge status={inst.status} />
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {format(new Date(inst.updated_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Recent Errors */}
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" /> Erros Recentes (24h)
              </CardTitle>
              <CardDescription>{data.recentErrors?.length || 0} erro(s) nas últimas 24 horas</CardDescription>
            </CardHeader>
            <CardContent>
              {!data.recentErrors?.length ? (
                <div className="py-8 text-center text-muted-foreground">
                  <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500 opacity-50" />
                  <p className="text-sm">Nenhum erro nas últimas 24 horas 🎉</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Data</TableHead>
                      <TableHead>Empresa</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Erro</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentErrors.map((err: any) => (
                      <TableRow key={err.id}>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {format(new Date(err.created_at), "dd/MM HH:mm", { locale: ptBR })}
                        </TableCell>
                        <TableCell className="text-sm">{err.company_name}</TableCell>
                        <TableCell><Badge variant="outline">{err.type}</Badge></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{err.phone}</TableCell>
                        <TableCell className="text-sm text-destructive max-w-[300px] truncate">{err.error_details || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ServiceCard({ icon, title, status, detail, error }: {
  icon: React.ReactNode;
  title: string;
  status: string;
  detail?: string;
  error?: string;
}) {
  const isOk = status === 'healthy' || status === 'connected';
  return (
    <Card className="border-none shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-lg ${isOk ? 'bg-emerald-500/10' : 'bg-destructive/10'}`}>
              {icon}
            </div>
            <div>
              <p className="font-semibold text-sm">{title}</p>
              {detail && <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>}
            </div>
          </div>
          <StatusIcon status={status} />
        </div>
        {error && <p className="text-xs text-destructive mt-3 truncate">{error}</p>}
      </CardContent>
    </Card>
  );
}
