import { useState } from 'react';
import { CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { PLUGUECHAT_AUTOMATIONS, PLUGUECHAT_TYPE_LABELS } from '@/lib/pluguechat-automations';

interface Props {
  companyId: string;
}

function LogStatusBadge({ status }: { status: string }) {
  if (status === 'sent') {
    return (
      <Badge variant="outline" className="gap-1 border-green-200 bg-green-50 text-green-700">
        <CheckCircle2 className="h-3 w-3" /> Enviado
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="gap-1 border-red-200 bg-red-50 text-red-700">
        <XCircle className="h-3 w-3" /> Falhou
      </Badge>
    );
  }
  if (status === 'provider_queued' || status === 'processing') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Validando
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3 w-3" /> {status}
    </Badge>
  );
}

function QueueStatusBadge({ status }: { status: string }) {
  if (status === 'pending') {
    return (
      <Badge variant="outline" className="gap-1 border-blue-200 bg-blue-50 text-blue-700">
        <Clock className="h-3 w-3" /> Pendente
      </Badge>
    );
  }
  if (status === 'processing') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Processando
      </Badge>
    );
  }
  if (status === 'provider_queued') {
    return (
      <Badge variant="outline" className="gap-1 border-yellow-200 bg-yellow-50 text-yellow-700">
        <Clock className="h-3 w-3" /> Validando
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="gap-1 border-red-200 bg-red-50 text-red-700">
        <XCircle className="h-3 w-3" /> Falhou
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Clock className="h-3 w-3" /> {status}
    </Badge>
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

function sanitizeProviderMessage(value: string) {
  return value
    .replace(/api\.helena\.run/gi, 'API PlugueChat')
    .replace(/\bhelena\b/gi, 'PlugueChat');
}

function ErrorDetails({ value }: { value?: string | null }) {
  if (!value) return null;
  const displayValue = sanitizeProviderMessage(value);
  return (
    <p className="mt-1 max-w-[360px] truncate text-xs text-red-700" title={displayValue}>
      {displayValue}
    </p>
  );
}

const ALL = '__all__';

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
      const { error } = await (supabase as any)
        .from('pluguechat_message_queue')
        .update({ status: 'pending', attempts: 0 })
        .eq('id', itemId)
        .eq('company_id', companyId)
        .eq('status', 'failed');
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pluguechat-queue', companyId] });
      toast.success('Item reenfileirado.');
    },
    onError: () => toast.error('Erro ao tentar novamente.'),
  });

  const hasFilters = filterType !== ALL || filterStatus !== ALL || filterDate;

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
                        <LogStatusBadge status={log.status} />
                        <ErrorDetails value={log.error_details} />
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
                        <QueueStatusBadge status={item.status} />
                        <ErrorDetails value={item.error_details} />
                      </TableCell>
                      <TableCell>
                        {item.status === 'failed' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            disabled={retryItem.isPending}
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
