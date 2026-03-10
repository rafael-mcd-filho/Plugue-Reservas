import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageCircle, CheckCircle2, XCircle, Clock, History, RefreshCw, Inbox, Filter, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEvolutionApi } from '@/hooks/useAutomations';
import { toast } from 'sonner';

interface Props {
  companyId: string;
}

const typeLabels: Record<string, string> = {
  confirmation: 'Confirmação',
  cancellation: 'Cancelamento',
  reminder_1h: 'Lembrete 1h',
  reminder_24h: 'Lembrete 24h',
  post_visit: 'Pós-visita',
  birthday: 'Aniversário',
  waitlist_entry: 'Fila — Entrada',
  waitlist_called: 'Fila — Chamado',
};

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  sent: { label: 'Enviado', icon: CheckCircle2, className: 'text-primary' },
  error: { label: 'Erro', icon: XCircle, className: 'text-destructive' },
  pending: { label: 'Pendente', icon: Clock, className: 'text-amber-600' },
  failed: { label: 'Falhou', icon: AlertTriangle, className: 'text-destructive' },
};

export default function WhatsAppMessageHistory({ companyId }: Props) {
  const qc = useQueryClient();
  const evolutionApi = useEvolutionApi();
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Message logs
  const { data: logs = [], isLoading: logsLoading } = useQuery({
    queryKey: ['whatsapp-message-logs', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_message_logs' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  // Message queue
  const { data: queue = [], isLoading: queueLoading } = useQuery({
    queryKey: ['whatsapp-message-queue', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_message_queue' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const handleResend = async (log: any) => {
    setResendingId(log.id);
    try {
      const result = await evolutionApi.mutateAsync({
        action: 'resend_message',
        company_id: companyId,
        phone: log.phone,
        message: log.message,
        log_id: log.id,
      });
      if (result?.error) {
        toast.error(`Erro ao reenviar: ${result.error}`);
      } else {
        toast.success('Mensagem reenviada com sucesso!');
      }
      qc.invalidateQueries({ queryKey: ['whatsapp-message-logs', companyId] });
    } catch (err: any) {
      toast.error(err.message || 'Erro ao reenviar mensagem');
    } finally {
      setResendingId(null);
    }
  };

  const filteredLogs = typeFilter === 'all' ? logs : logs.filter((l: any) => l.type === typeFilter);
  const errorLogs = logs.filter((l: any) => l.status === 'error');
  const sentLogs = logs.filter((l: any) => l.status === 'sent');
  const pendingQueue = queue.filter((q: any) => q.status === 'pending');
  const failedQueue = queue.filter((q: any) => q.status === 'failed');

  const sentCount = sentLogs.length;
  const errorCount = errorLogs.length;
  const pendingCount = pendingQueue.length;

  const isLoading = logsLoading || queueLoading;

  if (isLoading) {
    return <Card className="border border-border shadow-sm"><CardContent className="p-6 space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}</CardContent></Card>;
  }

  const renderLogTable = (items: any[], showResend = false) => (
    <div className="overflow-auto max-h-[500px]">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Data/Hora</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Mensagem</TableHead>
            <TableHead>Status</TableHead>
            {showResend && <TableHead className="w-[80px]"></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showResend ? 6 : 5} className="text-center py-8 text-muted-foreground">
                Nenhum registro encontrado
              </TableCell>
            </TableRow>
          ) : items.map((log: any) => {
            const sc = statusConfig[log.status] || statusConfig.pending;
            const StatusIcon = sc.icon;
            const isResending = resendingId === log.id;
            return (
              <TableRow key={log.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {format(new Date(log.created_at), "dd/MM HH:mm", { locale: ptBR })}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {typeLabels[log.type] || log.type}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm font-mono">{log.phone}</TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[250px] truncate" title={log.message}>
                  {log.message}
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center gap-1 text-xs font-medium ${sc.className}`}>
                    <StatusIcon className="h-3.5 w-3.5" /> {sc.label}
                  </span>
                  {log.error_details && (
                    <p className="text-xs text-destructive mt-1 max-w-[200px] truncate" title={log.error_details}>
                      {log.error_details}
                    </p>
                  )}
                </TableCell>
                {showResend && (
                  <TableCell>
                    {log.status === 'error' && (
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => handleResend(log)}
                        disabled={isResending}
                        className="gap-1 text-xs h-7 px-2"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isResending ? 'animate-spin' : ''}`} />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  const renderQueueTable = (items: any[]) => (
    <div className="overflow-auto max-h-[500px]">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Criado em</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Mensagem</TableHead>
            <TableHead>Tentativas</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expira em</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                Nenhuma mensagem na fila
              </TableCell>
            </TableRow>
          ) : items.map((q: any) => {
            const isExpired = new Date(q.expires_at) < new Date();
            return (
              <TableRow key={q.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {format(new Date(q.created_at), "dd/MM HH:mm", { locale: ptBR })}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {typeLabels[q.type] || q.type}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm font-mono">{q.phone}</TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate" title={q.message}>
                  {q.message}
                </TableCell>
                <TableCell className="text-sm">{q.attempts}/{q.max_attempts}</TableCell>
                <TableCell>
                  <Badge variant={q.status === 'pending' ? 'outline' : 'destructive'} className="text-xs">
                    {q.status === 'pending' ? (isExpired ? 'Expirado' : 'Aguardando') : 'Falhou'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {format(new Date(q.expires_at), "dd/MM HH:mm", { locale: ptBR })}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-5 w-5 text-primary" /> Log de Mensagens WhatsApp
        </CardTitle>
        <CardDescription className="flex items-center gap-4 mt-2">
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> {sentCount} enviadas
          </span>
          <span className="inline-flex items-center gap-1">
            <XCircle className="h-3.5 w-3.5 text-destructive" /> {errorCount} erros
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-amber-600" /> {pendingCount} na fila
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="all" className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <TabsList>
              <TabsTrigger value="all" className="gap-1.5">
                <MessageCircle className="h-3.5 w-3.5" /> Todas
              </TabsTrigger>
              <TabsTrigger value="errors" className="gap-1.5">
                <XCircle className="h-3.5 w-3.5" /> Erros
                {errorCount > 0 && <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-[10px]">{errorCount}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="queue" className="gap-1.5">
                <Inbox className="h-3.5 w-3.5" /> Fila
                {pendingCount > 0 && <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">{pendingCount}</Badge>}
              </TabsTrigger>
            </TabsList>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px] h-8 text-xs">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue placeholder="Filtrar tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os tipos</SelectItem>
                {Object.entries(typeLabels).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <TabsContent value="all">
            {renderLogTable(filteredLogs, true)}
          </TabsContent>

          <TabsContent value="errors">
            {renderLogTable(errorLogs, true)}
          </TabsContent>

          <TabsContent value="queue">
            {renderQueueTable([...pendingQueue, ...failedQueue])}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
