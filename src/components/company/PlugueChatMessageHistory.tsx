import { type ReactNode, useMemo, useState } from 'react';
import {
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { PLUGUECHAT_AUTOMATIONS, PLUGUECHAT_TYPE_LABELS } from '@/lib/pluguechat-automations';
import { cn } from '@/lib/utils';
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
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  companyId: string;
}

interface PlugueChatMessageLog {
  id: string;
  company_id: string;
  reservation_id: string | null;
  waitlist_id: string | null;
  queue_id?: string | null;
  phone: string;
  type: string;
  template_id: string;
  template_name: string | null;
  parameters: Record<string, unknown> | null;
  status: string;
  provider_message_id: string | null;
  provider_status: string | null;
  error_details: string | null;
  created_at: string;
}

interface PlugueChatQueueItem {
  id: string;
  company_id: string;
  reservation_id: string | null;
  waitlist_id: string | null;
  phone: string;
  type: string;
  template_id: string;
  template_name: string | null;
  parameters: Record<string, unknown> | null;
  status: string;
  attempts: number;
  max_attempts: number;
  scheduled_for: string;
  expires_at: string;
  last_attempt_at: string | null;
  provider_message_id: string | null;
  provider_status: string | null;
  provider_status_url: string | null;
  provider_status_checked_at: string | null;
  error_details: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  idempotency_key: string | null;
  created_at: string;
}

type RetryQueueResult = {
  ok?: boolean;
  retried?: number;
  process?: {
    ok?: boolean;
    error?: string;
    status?: number;
    body?: unknown;
  } | null;
  error?: string;
};

type HistoryTab = 'all' | 'errors' | 'queue';
type ConfirmAction = 'logs' | 'queue' | null;

const ALL = '__all__';
const PAGE_SIZE = 25;
const QUEUE_STATUSES = ['pending', 'processing', 'provider_queued', 'failed'];

function sanitizeProviderMessage(value: string) {
  return value
    .replace(/api\.helena\.run/gi, 'API PlugueChat')
    .replace(/\bhelena\b/gi, 'PlugueChat');
}

function StatusBadgeShell({
  children,
  className,
  label,
  details,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  details?: string | null;
}) {
  const displayDetails = details ? sanitizeProviderMessage(details) : null;
  const badge = (
    <Badge
      variant="outline"
      tabIndex={displayDetails ? 0 : undefined}
      aria-label={displayDetails ? `${label}. Motivo: ${displayDetails}` : label}
      className={cn('gap-1', className, displayDetails && 'cursor-help')}
    >
      {children}
    </Badge>
  );

  if (!displayDetails) return badge;

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-[360px] whitespace-pre-wrap text-xs leading-relaxed">
          {displayDetails}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function LogStatusBadge({ status, errorDetails }: { status: string; errorDetails?: string | null }) {
  if (status === 'sent') {
    return (
      <StatusBadgeShell label="Enviado" className="border-green-200 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3 w-3" /> Enviado
      </StatusBadgeShell>
    );
  }
  if (status === 'failed') {
    return (
      <StatusBadgeShell label="Falhou" details={errorDetails} className="border-red-200 bg-red-50 text-red-700">
        <XCircle className="h-3 w-3" /> Falhou
      </StatusBadgeShell>
    );
  }
  if (status === 'provider_queued' || status === 'processing') {
    return (
      <StatusBadgeShell label="Validando" className="border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Validando
      </StatusBadgeShell>
    );
  }
  return (
    <StatusBadgeShell label={status}>
      <Clock className="h-3 w-3" /> {status}
    </StatusBadgeShell>
  );
}

function QueueStatusBadge({ status, errorDetails }: { status: string; errorDetails?: string | null }) {
  if (status === 'pending') {
    return (
      <StatusBadgeShell label="Pendente" className="border-blue-200 bg-blue-50 text-blue-700">
        <Clock className="h-3 w-3" /> Pendente
      </StatusBadgeShell>
    );
  }
  if (status === 'processing') {
    return (
      <StatusBadgeShell label="Processando" className="border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Processando
      </StatusBadgeShell>
    );
  }
  if (status === 'provider_queued') {
    return (
      <StatusBadgeShell label="Validando" className="border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Validando
      </StatusBadgeShell>
    );
  }
  if (status === 'failed') {
    return (
      <StatusBadgeShell label="Falhou" details={errorDetails} className="border-red-200 bg-red-50 text-red-700">
        <XCircle className="h-3 w-3" /> Falhou
      </StatusBadgeShell>
    );
  }
  return (
    <StatusBadgeShell label={status}>
      <Clock className="h-3 w-3" /> {status}
    </StatusBadgeShell>
  );
}

function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, '');
  if (d.length === 13) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  return phone;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function dateBounds(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getRange(page: number) {
  const from = (page - 1) * PAGE_SIZE;
  return { from, to: from + PAGE_SIZE - 1 };
}

function getPageCount(count: number) {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function assertRetryResult(data: unknown): RetryQueueResult {
  const result = (data ?? {}) as RetryQueueResult;
  if (result.ok === false || result.error) {
    throw new Error(result.error || 'Erro ao reprocessar fila.');
  }
  return result;
}

async function invokePlugueChatApi<T = Record<string, unknown>>(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('pluguechat-api', { body });

  if (error) {
    const message = await getFunctionErrorMessage(error);
    if (message.startsWith('Unknown action: clear_')) {
      throw new Error('A funcao pluguechat-api ainda nao foi atualizada com a limpeza de logs/fila.');
    }
    throw new Error(message);
  }

  const result = (data ?? {}) as T & { error?: string; ok?: boolean };
  if (result.ok === false || result.error) {
    throw new Error(result.error || 'Nao foi possivel concluir a acao.');
  }

  return result;
}

function tableEmptyState(colSpan: number, message: string) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}

function PaginationControls({
  page,
  count,
  isFetching,
  onPageChange,
}: {
  page: number;
  count: number;
  isFetching: boolean;
  onPageChange: (page: number) => void;
}) {
  const pageCount = getPageCount(count);
  const start = count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, count);

  return (
    <div className="flex flex-col gap-2 border-t px-3 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>
        {count === 0 ? 'Nenhum registro' : `${start}-${end} de ${count}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(page - 1)}
        >
          Anterior
        </Button>
        <span className="min-w-16 text-center text-xs">
          {page} / {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= pageCount || isFetching}
          onClick={() => onPageChange(page + 1)}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}

export default function PlugueChatMessageHistory({ companyId }: Props) {
  const qc = useQueryClient();

  const [historyTab, setHistoryTab] = useState<HistoryTab>('all');
  const [filterType, setFilterType] = useState(ALL);
  const [filterQueueStatus, setFilterQueueStatus] = useState(ALL);
  const [filterDate, setFilterDate] = useState('');
  const [logPage, setLogPage] = useState(1);
  const [errorPage, setErrorPage] = useState(1);
  const [queuePage, setQueuePage] = useState(1);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  function resetPages() {
    setLogPage(1);
    setErrorPage(1);
    setQueuePage(1);
  }

  const statsQuery = useQuery({
    queryKey: ['pluguechat-history-stats', companyId],
    queryFn: async () => {
      const [logs, sent, failed, queue] = await Promise.all([
        (supabase as any)
          .from('pluguechat_message_logs')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId),
        (supabase as any)
          .from('pluguechat_message_logs')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'sent'),
        (supabase as any)
          .from('pluguechat_message_logs')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'failed'),
        (supabase as any)
          .from('pluguechat_message_queue')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .in('status', QUEUE_STATUSES),
      ]);

      if (logs.error) throw logs.error;
      if (sent.error) throw sent.error;
      if (failed.error) throw failed.error;
      if (queue.error) throw queue.error;

      return {
        logs: logs.count ?? 0,
        sent: sent.count ?? 0,
        failed: failed.count ?? 0,
        queue: queue.count ?? 0,
      };
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const logsQuery = useQuery({
    queryKey: ['pluguechat-logs', companyId, filterType, filterDate, logPage],
    queryFn: async () => {
      const range = getRange(logPage);
      let q = (supabase as any)
        .from('pluguechat_message_logs')
        .select('*', { count: 'exact' })
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .range(range.from, range.to);

      if (filterType !== ALL) q = q.eq('type', filterType);
      if (filterDate) {
        const { start, end } = dateBounds(filterDate);
        q = q.gte('created_at', start).lt('created_at', end);
      }

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as PlugueChatMessageLog[], count: count ?? 0 };
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const errorLogsQuery = useQuery({
    queryKey: ['pluguechat-error-logs', companyId, filterType, filterDate, errorPage],
    queryFn: async () => {
      const range = getRange(errorPage);
      let q = (supabase as any)
        .from('pluguechat_message_logs')
        .select('*', { count: 'exact' })
        .eq('company_id', companyId)
        .eq('status', 'failed')
        .order('created_at', { ascending: false })
        .range(range.from, range.to);

      if (filterType !== ALL) q = q.eq('type', filterType);
      if (filterDate) {
        const { start, end } = dateBounds(filterDate);
        q = q.gte('created_at', start).lt('created_at', end);
      }

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as PlugueChatMessageLog[], count: count ?? 0 };
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const queueQuery = useQuery({
    queryKey: ['pluguechat-queue', companyId, filterType, filterQueueStatus, filterDate, queuePage],
    queryFn: async () => {
      const range = getRange(queuePage);
      let q = (supabase as any)
        .from('pluguechat_message_queue')
        .select('*', { count: 'exact' })
        .eq('company_id', companyId)
        .in('status', QUEUE_STATUSES)
        .order('scheduled_for', { ascending: true })
        .range(range.from, range.to);

      if (filterType !== ALL) q = q.eq('type', filterType);
      if (filterQueueStatus !== ALL) q = q.eq('status', filterQueueStatus);
      if (filterDate) {
        const { start, end } = dateBounds(filterDate);
        q = q.gte('scheduled_for', start).lt('scheduled_for', end);
      }

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as PlugueChatQueueItem[], count: count ?? 0 };
    },
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const retryItem = useMutation({
    mutationFn: async (itemId: string) => {
      const data = await invokePlugueChatApi({
        action: 'retry_queue_item',
        company_id: companyId,
        item_id: itemId,
        process_now: true,
      });
      return assertRetryResult(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-error-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-history-stats', companyId] });
      toast.success('Item reenfileirado e processamento acionado.');
    },
    onError: () => toast.error('Erro ao tentar novamente.'),
  });

  const retryFailedQueue = useMutation({
    mutationFn: async () => {
      const data = await invokePlugueChatApi({
        action: 'retry_failed_queue',
        company_id: companyId,
        process_now: true,
      });
      return assertRetryResult(data);
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-error-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-history-stats', companyId] });

      const retried = result.retried ?? 0;
      if (retried === 0) {
        toast.info('Nenhuma falha pendente para reprocessar.');
        return;
      }

      toast.success(`${retried} ${retried === 1 ? 'item reenfileirado' : 'itens reenfileirados'} e processamento acionado.`);
    },
    onError: () => toast.error('Erro ao reprocessar falhas.'),
  });

  const processQueue = useMutation({
    mutationFn: async () => {
      const data = await invokePlugueChatApi({
        action: 'process_queue',
        company_id: companyId,
      });
      return assertRetryResult(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-error-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-history-stats', companyId] });
      toast.success('Processamento dos pendentes acionado.');
    },
    onError: () => toast.error('Erro ao processar fila.'),
  });

  const clearMutation = useMutation({
    mutationFn: async (action: Exclude<ConfirmAction, null>) => {
      await invokePlugueChatApi({
        action: action === 'logs' ? 'clear_logs' : 'clear_queue',
        company_id: companyId,
      });
    },
    onSuccess: (_, action) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-error-logs', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-history-stats', companyId] });
      resetPages();
      setConfirmAction(null);
      toast.success(action === 'logs' ? 'Logs limpos.' : 'Fila limpa.');
    },
    onError: (error: any) => toast.error(error?.message || 'Não foi possível concluir a limpeza.'),
  });

  const hasBaseFilters = filterType !== ALL || filterDate !== '';
  const hasFilters = hasBaseFilters || (historyTab === 'queue' && filterQueueStatus !== ALL);
  const stats = statsQuery.data ?? { logs: 0, sent: 0, failed: 0, queue: 0 };
  const logs = logsQuery.data?.rows ?? [];
  const logsCount = logsQuery.data?.count ?? 0;
  const errorLogs = errorLogsQuery.data?.rows ?? [];
  const errorLogsCount = errorLogsQuery.data?.count ?? 0;
  const queue = queueQuery.data?.rows ?? [];
  const queueCount = queueQuery.data?.count ?? 0;
  const failedQueueCount = useMemo(() => queue.filter((item) => item.status === 'failed').length, [queue]);
  const queueActionPending = retryFailedQueue.isPending || processQueue.isPending;
  const isLoading = logsQuery.isLoading || errorLogsQuery.isLoading || queueQuery.isLoading;

  function clearFilters() {
    setFilterType(ALL);
    setFilterQueueStatus(ALL);
    setFilterDate('');
    resetPages();
  }

  function renderLogTable(items: PlugueChatMessageLog[], emptyMessage: string) {
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data/Hora</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Template</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? tableEmptyState(5, emptyMessage) : items.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(log.created_at)}</TableCell>
                <TableCell className="text-sm">{PLUGUECHAT_TYPE_LABELS[log.type] ?? log.type}</TableCell>
                <TableCell className="whitespace-nowrap text-sm font-mono">{formatPhone(log.phone)}</TableCell>
                <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground" title={log.template_name ?? log.template_id}>
                  {log.template_name ?? log.template_id}
                </TableCell>
                <TableCell>
                  <LogStatusBadge status={log.status} errorDetails={log.error_details} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  function renderQueueTable(items: PlugueChatQueueItem[]) {
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agendado</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Template</TableHead>
              <TableHead>Tentativas</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[150px] text-right">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? tableEmptyState(7, 'Nenhum item na fila no momento.') : items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(item.scheduled_for)}</TableCell>
                <TableCell className="text-sm">{PLUGUECHAT_TYPE_LABELS[item.type] ?? item.type}</TableCell>
                <TableCell className="whitespace-nowrap text-sm font-mono">{formatPhone(item.phone)}</TableCell>
                <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground" title={item.template_name ?? item.template_id}>
                  {item.template_name ?? item.template_id}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{item.attempts}/{item.max_attempts}</TableCell>
                <TableCell>
                  <QueueStatusBadge status={item.status} errorDetails={item.error_details} />
                </TableCell>
                <TableCell className="text-right">
                  {item.status === 'failed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 text-xs"
                      disabled={retryItem.isPending || queueActionPending}
                      onClick={() => retryItem.mutate(item.id)}
                    >
                      <RefreshCw className="h-3 w-3" /> Tentar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

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
                  <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> {stats.sent} enviadas
                </span>
                <span className="inline-flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5 text-destructive" /> {stats.failed} erros
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5 text-amber-600" /> {stats.queue} na fila
                </span>
              </CardDescription>
            </div>

            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              disabled={stats.logs === 0 || clearMutation.isPending}
              onClick={() => setConfirmAction('logs')}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Limpar logs
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <Tabs value={historyTab} onValueChange={(value) => setHistoryTab(value as HistoryTab)} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <TabsList>
                <TabsTrigger value="all" className="gap-1.5">
                  <MessageCircle className="h-3.5 w-3.5" /> Todas
                </TabsTrigger>
                <TabsTrigger value="errors" className="gap-1.5">
                  <XCircle className="h-3.5 w-3.5" /> Erros
                  {stats.failed > 0 && (
                    <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-[10px]">
                      {stats.failed}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="queue" className="gap-1.5">
                  <Inbox className="h-3.5 w-3.5" /> Fila
                  {stats.queue > 0 && (
                    <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px]">
                      {stats.queue}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex flex-wrap gap-2">
              <Select
                value={filterType}
                onValueChange={(value) => {
                  setFilterType(value);
                  resetPages();
                }}
              >
                <SelectTrigger className="h-9 w-full sm:w-[210px]">
                  <Filter className="mr-1 h-3.5 w-3.5" />
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os tipos</SelectItem>
                  {PLUGUECHAT_AUTOMATIONS.map((automation) => (
                    <SelectItem key={automation.type} value={automation.type}>{automation.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {historyTab === 'queue' && (
                <Select
                  value={filterQueueStatus}
                  onValueChange={(value) => {
                    setFilterQueueStatus(value);
                    resetPages();
                  }}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[170px]">
                    <SelectValue placeholder="Status da fila" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Toda a fila</SelectItem>
                    <SelectItem value="pending">Pendente</SelectItem>
                    <SelectItem value="processing">Processando</SelectItem>
                    <SelectItem value="provider_queued">Validando</SelectItem>
                    <SelectItem value="failed">Falhou</SelectItem>
                  </SelectContent>
                </Select>
              )}

              <Input
                type="date"
                className="h-9 w-full sm:w-[160px]"
                value={filterDate}
                onChange={(event) => {
                  setFilterDate(event.target.value);
                  resetPages();
                }}
              />

              {hasFilters && (
                <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                  Limpar filtros
                </Button>
              )}
            </div>

            <TabsContent value="all">
              <Card>
                <CardContent className="p-0">
                  {renderLogTable(logs, hasFilters ? 'Nenhuma mensagem encontrada com esses filtros.' : 'Nenhuma mensagem enviada ainda pelo PlugueChat.')}
                  <PaginationControls
                    page={logPage}
                    count={logsCount}
                    isFetching={logsQuery.isFetching}
                    onPageChange={setLogPage}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="errors">
              <Card>
                <CardContent className="p-0">
                  {renderLogTable(errorLogs, hasFilters ? 'Nenhum erro encontrado com esses filtros.' : 'Nenhum erro registrado.')}
                  <PaginationControls
                    page={errorPage}
                    count={errorLogsCount}
                    isFetching={errorLogsQuery.isFetching}
                    onPageChange={setErrorPage}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="queue" className="space-y-4">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {failedQueueCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-2"
                    disabled={queueActionPending}
                    onClick={() => retryFailedQueue.mutate()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Reprocessar falhas ({failedQueueCount})
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2"
                  disabled={queueActionPending || queueCount === 0}
                  onClick={() => processQueue.mutate()}
                >
                  <Play className="h-3.5 w-3.5" />
                  Processar pendentes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-2 text-destructive hover:text-destructive"
                  disabled={queueCount === 0 || clearMutation.isPending}
                  onClick={() => setConfirmAction('queue')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Limpar fila
                </Button>
              </div>

              <Card>
                <CardContent className="p-0">
                  {renderQueueTable(queue)}
                  <PaginationControls
                    page={queuePage}
                    count={queueCount}
                    isFetching={queueQuery.isFetching}
                    onPageChange={setQueuePage}
                  />
                </CardContent>
              </Card>
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
                ? 'Todos os logs PlugueChat desta empresa serão removidos permanentemente.'
                : 'Todos os itens da fila PlugueChat desta empresa serão removidos permanentemente.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmAction) clearMutation.mutate(confirmAction);
              }}
              disabled={clearMutation.isPending}
            >
              {clearMutation.isPending ? 'Limpando...' : 'Limpar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
