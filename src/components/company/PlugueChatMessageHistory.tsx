import { type ReactNode, useMemo, useState } from 'react';
import { CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { PLUGUECHAT_AUTOMATIONS, PLUGUECHAT_TYPE_LABELS } from '@/lib/pluguechat-automations';
import { cn } from '@/lib/utils';

interface Props {
  companyId: string;
}

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

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

const ALL = '__all__';

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

function assertRetryResult(data: unknown): RetryQueueResult {
  const result = (data ?? {}) as RetryQueueResult;
  if (result.ok === false || result.error) {
    throw new Error(result.error || 'Erro ao reprocessar fila.');
  }
  return result;
}

export default function PlugueChatMessageHistory({ companyId }: Props) {
  const qc = useQueryClient();

  const [filterType, setFilterType] = useState(ALL);
  const [filterStatus, setFilterStatus] = useState(ALL);
  const [filterDate, setFilterDate] = useState('');

  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['pluguechat-logs', companyId, filterType, filterStatus, filterDate],
    queryFn: async () => {
      let q = (supabase as any)
        .from('pluguechat_message_logs')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (filterType !== ALL) q = q.eq('type', filterType);
      if (filterStatus !== ALL) q = q.eq('status', filterStatus);
      if (filterDate) {
        const start = new Date(filterDate);
        const end = new Date(filterDate);
        end.setDate(end.getDate() + 1);
        q = q.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!companyId,
  });

  const { data: queue, isLoading: queueLoading } = useQuery({
    queryKey: ['pluguechat-queue', companyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('pluguechat_message_queue')
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['pending', 'processing', 'provider_queued', 'failed'])
        .order('scheduled_for', { ascending: true })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!companyId,
  });

  const retryItem = useMutation({
    mutationFn: async (itemId: string) => {
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: {
          action: 'retry_queue_item',
          company_id: companyId,
          item_id: itemId,
          process_now: true,
        },
      });
      if (error) throw error;
      return assertRetryResult(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      toast.success('Item reenfileirado e processamento acionado.');
    },
    onError: () => toast.error('Erro ao tentar novamente.'),
  });

  const retryFailedQueue = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: {
          action: 'retry_failed_queue',
          company_id: companyId,
          process_now: true,
        },
      });
      if (error) throw error;
      return assertRetryResult(data);
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });

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
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: {
          action: 'process_queue',
          company_id: companyId,
        },
      });
      if (error) throw error;
      return assertRetryResult(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      qc.invalidateQueries({ queryKey: ['pluguechat-logs', companyId] });
      toast.success('Processamento dos pendentes acionado.');
    },
    onError: () => toast.error('Erro ao processar fila.'),
  });

  const hasFilters = filterType !== ALL || filterStatus !== ALL || filterDate;
  const failedQueueCount = useMemo(() => (queue ?? []).filter((item: any) => item.status === 'failed').length, [queue]);
  const queueActionPending = retryFailedQueue.isPending || processQueue.isPending;

  return (
    <Tabs defaultValue="enviadas">
      <TabsList>
        <TabsTrigger value="enviadas">Enviadas</TabsTrigger>
        <TabsTrigger value="fila">
          Fila{queue && queue.length > 0 ? ` (${queue.length})` : ''}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="enviadas" className="space-y-4 pt-2">
        <div className="flex flex-wrap gap-2">
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos os tipos</SelectItem>
              {PLUGUECHAT_AUTOMATIONS.map((a) => (
                <SelectItem key={a.type} value={a.type}>{a.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              <SelectItem value="sent">Enviado</SelectItem>
              <SelectItem value="failed">Falhou</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="date"
            className="w-[160px]"
            value={filterDate}
            onChange={(e) => setFilterDate(e.target.value)}
          />

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setFilterType(ALL); setFilterStatus(ALL); setFilterDate(''); }}
            >
              Limpar filtros
            </Button>
          )}
        </div>

        {logsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !logs || logs.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {hasFilters ? 'Nenhuma mensagem encontrada com esses filtros.' : 'Nenhuma mensagem enviada ainda pelo PlugueChat.'}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log: any) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(log.created_at)}</TableCell>
                      <TableCell className="text-sm">{PLUGUECHAT_TYPE_LABELS[log.type] ?? log.type}</TableCell>
                      <TableCell className="text-sm font-mono">{formatPhone(log.phone)}</TableCell>
                      <TableCell className="max-w-[160px] truncate text-xs text-muted-foreground">
                        {log.template_name ?? log.template_id}
                      </TableCell>
                      <TableCell>
                        <LogStatusBadge status={log.status} errorDetails={log.error_details} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="fila" className="space-y-4 pt-2">
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
            variant="ghost"
            className="h-8 gap-2"
            disabled={queueActionPending}
            onClick={() => processQueue.mutate()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Processar pendentes
          </Button>
        </div>

        {queueLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !queue || queue.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Nenhum item na fila no momento.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agendado</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Tentativas</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((item: any) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(item.scheduled_for)}</TableCell>
                      <TableCell className="text-sm">{PLUGUECHAT_TYPE_LABELS[item.type] ?? item.type}</TableCell>
                      <TableCell className="text-sm font-mono">{formatPhone(item.phone)}</TableCell>
                      <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground">
                        {item.template_name ?? item.template_id}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{item.attempts}/{item.max_attempts}</TableCell>
                      <TableCell>
                        <QueueStatusBadge status={item.status} errorDetails={item.error_details} />
                      </TableCell>
                      <TableCell>
                        {item.status === 'failed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            disabled={retryItem.isPending || queueActionPending}
                            onClick={() => retryItem.mutate(item.id)}
                          >
                            <RefreshCw className="h-3 w-3" /> Tentar novamente
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </TabsContent>
    </Tabs>
  );
}
