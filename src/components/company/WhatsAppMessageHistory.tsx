import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Filter,
  History,
  Inbox,
  MessageCircle,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useEvolutionApi } from '@/hooks/useAutomations';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { WHATSAPP_MESSAGE_TYPE_LABELS, parseWhatsAppErrorDetails } from '@/lib/whatsapp-automations';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Props {
  companyId: string;
}

interface MessageRecord {
  id: string;
  company_id: string;
  created_at: string;
  error_details: string | null;
  message: string;
  phone: string;
  reservation_id: string | null;
  status: string;
  type: string;
  attempts?: number;
  max_attempts?: number;
  expires_at?: string;
}

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  sent: { label: 'Enviado', icon: CheckCircle2, className: 'text-primary' },
  error: { label: 'Erro', icon: XCircle, className: 'text-destructive' },
  pending: { label: 'Aceita', icon: Clock, className: 'text-amber-600' },
  failed: { label: 'Falhou', icon: AlertTriangle, className: 'text-destructive' },
};

export default function WhatsAppMessageHistory({ companyId }: Props) {
  const qc = useQueryClient();
  const evolutionApi = useEvolutionApi();
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'logs' | 'queue' | null>(null);
  const [clearing, setClearing] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<{
    title: string;
    message: string;
    providerStatus: number | null;
    providerMessage: string | null;
    raw: string | null;
  } | null>(null);

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
      return (data ?? []) as MessageRecord[];
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

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
      return (data ?? []) as MessageRecord[];
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const filteredLogs = useMemo(
    () => (typeFilter === 'all' ? logs : logs.filter((item) => item.type === typeFilter)),
    [logs, typeFilter],
  );
  const errorLogs = useMemo(() => logs.filter((item) => item.status === 'error'), [logs]);
  const pendingQueue = useMemo(() => queue.filter((item) => item.status === 'pending'), [queue]);
  const failedQueue = useMemo(() => queue.filter((item) => item.status === 'failed'), [queue]);
  const queueItems = useMemo(() => [...pendingQueue, ...failedQueue], [failedQueue, pendingQueue]);
  const isLoading = logsLoading || queueLoading;

  const openIssueDialog = (details: string | null | undefined) => {
    const parsed = parseWhatsAppErrorDetails(details);
    if (!parsed) return;

    setSelectedIssue({
      title: parsed.title,
      message: parsed.message,
      providerStatus: parsed.providerStatus,
      providerMessage: parsed.providerMessage,
      raw: parsed.raw,
    });
  };

  const handleResend = async (log: MessageRecord) => {
    setResendingId(log.id);

    try {
      const result = await evolutionApi.mutateAsync({
        action: 'resend_message',
        company_id: companyId,
        phone: log.phone,
        message: log.message,
        log_id: log.id,
      });

      if (result?.ok === false) {
        const parsed = parseWhatsAppErrorDetails(
          JSON.stringify({
            code: result.error_code ?? null,
            title: result.error_title ?? null,
            message: result.error_message ?? null,
            provider_status: result.provider_status ?? null,
            provider_message: result.provider_message ?? null,
          }),
        );

        toast.error(parsed?.message ?? 'Não foi possível reenviar a mensagem.');
      } else {
        toast.success('Mensagem aceita pela Evolution e aguardando confirmacao.');
      }
    } catch (error: any) {
      toast.error(await getFunctionErrorMessage(error));
    } finally {
      setResendingId(null);
      qc.invalidateQueries({ queryKey: ['whatsapp-message-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['whatsapp-message-queue', companyId] });
    }
  };

  const handleProcessQueue = async () => {
    setProcessing(true);

    try {
      const { data, error } = await supabase.functions.invoke('process-message-queue', {
        body: { company_id: companyId },
      });

      if (error) throw error;

      if (data?.reason === 'another_process_running') {
        toast.message('Já existe outro processamento em andamento para esta fila.');
      } else if (data?.reason === 'no_connected_instances') {
        toast.error('A fila não foi processada porque a instância do WhatsApp está desconectada.');
      } else if (data?.reason === 'Evolution API not configured') {
        toast.error('A fila não foi processada porque a Evolution API não está configurada.');
      } else {
        toast.success(`Fila processada: ${data?.sent ?? 0} aceitas pela Evolution, ${data?.failed ?? 0} com falha.`);
      }
    } catch (error: any) {
      toast.error(await getFunctionErrorMessage(error));
    } finally {
      setProcessing(false);
      qc.invalidateQueries({ queryKey: ['whatsapp-message-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['whatsapp-message-queue', companyId] });
    }
  };

  const handleClear = async () => {
    if (!confirmAction) return;

    setClearing(true);

    try {
      const result = await evolutionApi.mutateAsync({
        action: confirmAction === 'logs' ? 'clear_logs' : 'clear_queue',
        company_id: companyId,
      });

      if (result?.ok === false) {
        toast.error(result.error_message || 'Não foi possível concluir a limpeza.');
        return;
      }

      toast.success(confirmAction === 'logs' ? 'Logs limpos.' : 'Fila limpa.');
      qc.invalidateQueries({ queryKey: ['whatsapp-message-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['whatsapp-message-queue', companyId] });
      setConfirmAction(null);
    } catch (error: any) {
      toast.error(await getFunctionErrorMessage(error));
    } finally {
      setClearing(false);
    }
  };

  const renderStatusCell = (item: MessageRecord) => {
    const config = statusConfig[item.status] || statusConfig.pending;
    const StatusIcon = config.icon;
    const parsedError = parseWhatsAppErrorDetails(item.error_details);

    return (
      <div className="space-y-1">
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${config.className}`}>
          <StatusIcon className="h-3.5 w-3.5" /> {config.label}
        </span>
        {parsedError && (
          <div className="space-y-1">
            <p className="max-w-[220px] text-xs text-muted-foreground">{parsedError.title}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-0 text-xs text-destructive hover:bg-transparent hover:text-destructive"
              onClick={() => openIssueDialog(item.error_details)}
            >
              Ver motivo
            </Button>
          </div>
        )}
      </div>
    );
  };

  const renderLogTable = (items: MessageRecord[], showResend = false) => (
    <div className="max-h-[500px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Data/Hora</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Mensagem</TableHead>
            <TableHead>Status</TableHead>
            {showResend && <TableHead className="w-[110px] text-right">Ação</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showResend ? 6 : 5} className="py-8 text-center text-muted-foreground">
                Nenhum registro encontrado
              </TableCell>
            </TableRow>
          ) : (
            items.map((log) => {
              const isResending = resendingId === log.id;

              return (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {WHATSAPP_MESSAGE_TYPE_LABELS[log.type] || log.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm font-mono">{log.phone}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground" title={log.message}>
                    {log.message}
                  </TableCell>
                  <TableCell>{renderStatusCell(log)}</TableCell>
                  {showResend && (
                    <TableCell className="text-right">
                      {log.status === 'error' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleResend(log)}
                          disabled={isResending}
                          className="gap-1.5"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${isResending ? 'animate-spin' : ''}`} />
                          Reenviar
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );

  const renderQueueTable = (items: MessageRecord[]) => (
    <div className="max-h-[500px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Criado em</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Telefone</TableHead>
            <TableHead>Mensagem</TableHead>
            <TableHead>Tentativas</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead>Expira em</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                Nenhuma mensagem na fila
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const isExpired = item.expires_at ? new Date(item.expires_at) < new Date() : false;
              const parsedError = parseWhatsAppErrorDetails(item.error_details);

              return (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {format(new Date(item.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {WHATSAPP_MESSAGE_TYPE_LABELS[item.type] || item.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm font-mono">{item.phone}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-sm text-muted-foreground" title={item.message}>
                    {item.message}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.attempts ?? 0}/{item.max_attempts ?? 0}
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.status === 'pending' ? 'outline' : 'destructive'} className="text-xs">
                      {item.status === 'pending' ? (isExpired ? 'Expirado' : 'Aguardando') : 'Falhou'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {parsedError ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-0 text-xs text-destructive hover:bg-transparent hover:text-destructive"
                        onClick={() => openIssueDialog(item.error_details)}
                      >
                        {parsedError.title}
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {item.expires_at ? format(new Date(item.expires_at), 'dd/MM HH:mm', { locale: ptBR }) : '-'}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );

  if (isLoading) {
    return (
      <Card className="border border-border shadow-sm">
        <CardContent className="space-y-3 p-6">
          {[1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="border border-border shadow-sm">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-5 w-5 text-primary" /> Histórico de mensagens WhatsApp
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> {logs.filter((item) => item.status === 'sent').length} enviadas
                </span>
                <span className="inline-flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5 text-destructive" /> {errorLogs.length} erros
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5 text-amber-600" /> {pendingQueue.length} na fila
                </span>
              </CardDescription>
            </div>

            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              disabled={logs.length === 0}
              onClick={() => setConfirmAction('logs')}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Limpar logs
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          <Tabs defaultValue="all" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <TabsList>
                <TabsTrigger value="all" className="gap-1.5">
                  <MessageCircle className="h-3.5 w-3.5" /> Todas
                </TabsTrigger>
                <TabsTrigger value="errors" className="gap-1.5">
                  <XCircle className="h-3.5 w-3.5" /> Erros
                  {errorLogs.length > 0 && (
                    <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-[10px]">
                      {errorLogs.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="queue" className="gap-1.5">
                  <Inbox className="h-3.5 w-3.5" /> Fila
                  {pendingQueue.length > 0 && (
                    <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                      {pendingQueue.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-8 w-[180px] text-xs">
                  <Filter className="mr-1 h-3 w-3" />
                  <SelectValue placeholder="Filtrar tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  {Object.entries(WHATSAPP_MESSAGE_TYPE_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <TabsContent value="all">{renderLogTable(filteredLogs, true)}</TabsContent>
            <TabsContent value="errors">{renderLogTable(errorLogs, true)}</TabsContent>
            <TabsContent value="queue" className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={pendingQueue.length === 0 || processing}
                  onClick={handleProcessQueue}
                >
                  <Play className={`h-3.5 w-3.5 ${processing ? 'animate-spin' : ''}`} />
                  {processing ? 'Processando...' : 'Processar fila'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  disabled={queue.length === 0}
                  onClick={() => setConfirmAction('queue')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Limpar fila
                </Button>
              </div>

              {renderQueueTable(queueItems)}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'logs' ? 'Limpar logs de mensagens?' : 'Limpar fila de mensagens?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'logs'
                ? `Todos os ${logs.length} logs desta empresa serão removidos permanentemente.`
                : `Todas as ${queue.length} mensagens pendentes ou com falha serão removidas permanentemente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleClear}
              disabled={clearing}
            >
              {clearing ? 'Limpando...' : 'Limpar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={selectedIssue !== null} onOpenChange={(open) => !open && setSelectedIssue(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{selectedIssue?.title}</DialogTitle>
            <DialogDescription>{selectedIssue?.message}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {selectedIssue?.providerStatus && (
              <div>
                <span className="font-medium">Status do provider:</span> {selectedIssue.providerStatus}
              </div>
            )}

            {selectedIssue?.providerMessage && (
              <div>
                <span className="font-medium">Mensagem do provider:</span> {selectedIssue.providerMessage}
              </div>
            )}

            {selectedIssue?.raw && (
              <div className="space-y-2">
                <span className="font-medium">Detalhe bruto:</span>
                <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                  {selectedIssue.raw}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
