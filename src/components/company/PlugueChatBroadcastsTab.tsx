import { type ReactNode, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  Play,
  Search,
  Send,
  Users,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { type PlugueChatBroadcast, useCancelPlugueChatBroadcast, useCreatePlugueChatBroadcast, usePlugueChatBroadcasts } from '@/hooks/usePlugueChatBroadcasts';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { cn } from '@/lib/utils';
import { formatBrazilPhone, normalizeBrazilPhoneDigits } from '@/lib/validation';
import { getReservationStatusLabel } from '@/lib/reservation-status';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

type PeriodPreset = 'all' | 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom';

type RecipientCandidate = {
  id: string;
  guest_name: string | null;
  guest_phone: string | null;
  date: string | null;
  time: string | null;
  party_size: number | null;
  status: string | null;
};

type CommittedFilters = {
  start: Date | null;
  end: Date | null;
  statuses: string[];
} | null;

const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  all: 'Todo o periodo',
  today: 'Hoje',
  yesterday: 'Ontem',
  this_week: 'Esta semana',
  last_week: 'Semana passada',
  this_month: 'Mes atual',
  last_month: 'Mes anterior',
  custom: 'Personalizado',
};

const STATUS_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'checked_in', label: 'Check-in realizado' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'no-show', label: 'No Show' },
];

function getPresetDateRange(preset: PeriodPreset): { start: Date | null; end: Date | null } {
  const now = new Date();

  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const yesterday = subDays(startOfDay(now), 1);
      return { start: yesterday, end: endOfDay(yesterday) };
    }
    case 'this_week':
      return { start: startOfWeek(now, { weekStartsOn: 0 }), end: endOfDay(now) };
    case 'last_week': {
      const lastWeek = subWeeks(now, 1);
      return { start: startOfWeek(lastWeek, { weekStartsOn: 0 }), end: endOfWeek(lastWeek, { weekStartsOn: 0 }) };
    }
    case 'this_month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      return { start: startOfMonth(lastMonth), end: endOfMonth(lastMonth) };
    }
    case 'custom':
      return { start: null, end: null };
  }
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; icon: ReactNode; className: string }> = {
    draft: { label: 'Rascunho', icon: <Clock className="h-3 w-3" />, className: 'border-gray-200 bg-gray-50 text-gray-600' },
    scheduled: { label: 'Agendado', icon: <Clock className="h-3 w-3" />, className: 'border-blue-200 bg-blue-50 text-blue-700' },
    processing: { label: 'Processando', icon: <Send className="h-3 w-3" />, className: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
    completed: { label: 'Concluido', icon: <CheckCircle2 className="h-3 w-3" />, className: 'border-green-200 bg-green-50 text-green-700' },
    cancelled: { label: 'Cancelado', icon: <Ban className="h-3 w-3" />, className: 'border-gray-200 bg-gray-50 text-gray-500' },
    failed: { label: 'Falhou', icon: <XCircle className="h-3 w-3" />, className: 'border-red-200 bg-red-50 text-red-700' },
  };

  const item = config[status] ?? config.draft;
  return (
    <Badge variant="outline" className={cn('gap-1', item.className)}>
      {item.icon} {item.label}
    </Badge>
  );
}

function formatDate(value: string | null | undefined, pattern = "dd/MM/yyyy 'as' HH:mm") {
  if (!value) return '-';
  try {
    return format(parseISO(value), pattern, { locale: ptBR });
  } catch {
    return '-';
  }
}

function formatReservationDate(candidate: RecipientCandidate) {
  if (!candidate.date) return '-';
  const date = formatDate(candidate.date, 'dd/MM/yyyy');
  return candidate.time ? `${date} ${candidate.time.slice(0, 5)}` : date;
}

function getBroadcastTitle(broadcast: PlugueChatBroadcast) {
  return broadcast.name || broadcast.template_name || broadcast.template_id;
}

export default function PlugueChatBroadcastsTab({ companyId, activeChannel }: Props) {
  const { data: broadcasts = [], isLoading: loadingBroadcasts } = usePlugueChatBroadcasts(companyId);
  const createBroadcast = useCreatePlugueChatBroadcast();
  const cancelBroadcast = useCancelPlugueChatBroadcast();

  const [filterPeriodPreset, setFilterPeriodPreset] = useState<PeriodPreset>('all');
  const [filterCustomStart, setFilterCustomStart] = useState('');
  const [filterCustomEnd, setFilterCustomEnd] = useState('');
  const [filterStatuses, setFilterStatuses] = useState<string[]>(['confirmed', 'checked_in']);
  const [committedFilters, setCommittedFilters] = useState<CommittedFilters>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [broadcastName, setBroadcastName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [cancelTarget, setCancelTarget] = useState<PlugueChatBroadcast | null>(null);

  const broadcastIds = useMemo(() => broadcasts.map((broadcast) => broadcast.id), [broadcasts]);

  const { data: recipientRows } = useQuery({
    queryKey: ['pluguechat-broadcast-recipients', broadcastIds],
    queryFn: async () => {
      if (broadcastIds.length === 0) return [];
      const { data, error } = await (supabase as any)
        .from('pluguechat_broadcast_recipients')
        .select('broadcast_id,status')
        .in('broadcast_id', broadcastIds);
      if (error) throw error;
      return (data ?? []) as { broadcast_id: string; status: string }[];
    },
    enabled: broadcastIds.length > 0,
    refetchInterval: 10000,
  });

  const { data: reservations = [], isFetching: loadingReservations } = useQuery({
    queryKey: [
      'pluguechat-broadcast-candidates',
      companyId,
      committedFilters?.start?.toISOString(),
      committedFilters?.end?.toISOString(),
      committedFilters?.statuses.join(','),
    ],
    queryFn: async () => {
      if (!committedFilters) return [];
      let query = supabase
        .from('reservations')
        .select('id, guest_name, guest_phone, date, time, party_size, status')
        .eq('company_id', companyId)
        .not('guest_phone', 'is', null)
        .order('date', { ascending: true })
        .order('time', { ascending: true })
        .limit(500);

      if (committedFilters.start) {
        query = query.gte('date', format(committedFilters.start, 'yyyy-MM-dd'));
      }
      if (committedFilters.end) {
        query = query.lte('date', format(committedFilters.end, 'yyyy-MM-dd'));
      }
      if (committedFilters.statuses.length > 0) {
        query = query.in('status', committedFilters.statuses);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as RecipientCandidate[];
    },
    enabled: !!companyId && committedFilters !== null && committedFilters.statuses.length > 0,
  });

  const recipientCounts = useMemo(() => {
    const map = new Map<string, { total: number; pending: number; sent: number; failed: number }>();
    for (const row of recipientRows ?? []) {
      const current = map.get(row.broadcast_id) ?? { total: 0, pending: 0, sent: 0, failed: 0 };
      current.total++;
      if (['pending', 'queued', 'processing', 'provider_queued', 'duplicate'].includes(row.status)) current.pending++;
      else if (row.status === 'sent') current.sent++;
      else if (row.status === 'failed') current.failed++;
      map.set(row.broadcast_id, current);
    }
    return map;
  }, [recipientRows]);

  const uniqueRecipients = useMemo(() => {
    const seen = new Map<string, RecipientCandidate>();

    for (const reservation of reservations) {
      const digits = normalizeBrazilPhoneDigits(reservation.guest_phone);
      if (!digits || seen.has(digits)) continue;
      seen.set(digits, reservation);
    }

    return Array.from(seen.values());
  }, [reservations]);

  const selectedRecipients = useMemo(
    () => uniqueRecipients.filter((recipient) => selectedIds.has(recipient.id)),
    [selectedIds, uniqueRecipients],
  );

  const allSelected = uniqueRecipients.length > 0 && selectedIds.size === uniqueRecipients.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  function toggleStatusFilter(status: string) {
    setFilterStatuses((current) => (
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status]
    ));
  }

  function toggleAllRecipients(checked: boolean) {
    setSelectedIds(checked ? new Set(uniqueRecipients.map((recipient) => recipient.id)) : new Set());
  }

  function toggleRecipient(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleSearch() {
    const range = filterPeriodPreset === 'custom'
      ? {
          start: filterCustomStart ? startOfDay(parseISO(filterCustomStart)) : null,
          end: filterCustomEnd ? endOfDay(parseISO(filterCustomEnd)) : null,
        }
      : getPresetDateRange(filterPeriodPreset);

    setCommittedFilters({ ...range, statuses: filterStatuses });
    setSelectedIds(new Set());
  }

  function handleCreate() {
    if (!broadcastName.trim() || !templateId.trim() || selectedRecipients.length === 0) return;

    createBroadcast.mutate(
      {
        company_id: companyId,
        name: broadcastName.trim(),
        template_id: templateId.trim(),
        recipient_reservation_ids: selectedRecipients.map((recipient) => recipient.id),
        audience_filter: {
          source: 'selected_reservations',
          filter_date_from: committedFilters?.start ? format(committedFilters.start, 'yyyy-MM-dd') : null,
          filter_date_to: committedFilters?.end ? format(committedFilters.end, 'yyyy-MM-dd') : null,
          filter_statuses: committedFilters?.statuses ?? [],
        },
      },
      {
        onSuccess: () => {
          setBroadcastName('');
          setTemplateId('');
          setSelectedIds(new Set());
        },
      },
    );
  }

  if (loadingBroadcasts) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo nao e o PlugueChat Oficial. Disparos criados aqui so serao processados quando o canal for ativado.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-5 w-5 text-primary" /> Novo disparo
          </CardTitle>
          <CardDescription>
            Selecione reservas por periodo e status, escolha os destinatarios e envie um template em massa.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <div className="space-y-2">
              <Label>Periodo das reservas</Label>
              <Select value={filterPeriodPreset} onValueChange={(value) => setFilterPeriodPreset(value as PeriodPreset)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PERIOD_PRESET_LABELS) as PeriodPreset[]).map((key) => (
                    <SelectItem key={key} value={key}>{PERIOD_PRESET_LABELS[key]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Status das reservas</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-between font-normal">
                    <span className="truncate">
                      {filterStatuses.length === 0
                        ? 'Selecione ao menos um status'
                        : filterStatuses
                          .map((status) => STATUS_FILTER_OPTIONS.find((option) => option.value === status)?.label ?? status)
                          .join(', ')}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="space-y-1">
                    {STATUS_FILTER_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          checked={filterStatuses.includes(option.value)}
                          onCheckedChange={() => toggleStatusFilter(option.value)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <Button type="button" className="gap-2" onClick={handleSearch} disabled={filterStatuses.length === 0 || loadingReservations}>
              {loadingReservations ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </Button>
          </div>

          {filterPeriodPreset === 'custom' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pluguechat-broadcast-start">Data inicial</Label>
                <Input
                  id="pluguechat-broadcast-start"
                  type="date"
                  value={filterCustomStart}
                  onChange={(event) => setFilterCustomStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pluguechat-broadcast-end">Data final</Label>
                <Input
                  id="pluguechat-broadcast-end"
                  type="date"
                  value={filterCustomEnd}
                  onChange={(event) => setFilterCustomEnd(event.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4" /> Destinatarios encontrados ({uniqueRecipients.length})
              </h4>
              <span className="text-sm text-muted-foreground">{selectedRecipients.length} selecionado(s)</span>
            </div>

            <div className="max-h-80 overflow-auto rounded-md border">
              {committedFilters === null ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Selecione os filtros e clique em "Buscar" para carregar os leads.
                </div>
              ) : loadingReservations ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : uniqueRecipients.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Nenhum destinatario encontrado com esses filtros.
                </div>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                          onCheckedChange={(checked) => toggleAllRecipients(checked === true)}
                          aria-label="Selecionar todos os destinatarios"
                        />
                      </TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead className="hidden sm:table-cell">Data</TableHead>
                      <TableHead className="hidden md:table-cell">Pessoas</TableHead>
                      <TableHead className="hidden lg:table-cell">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uniqueRecipients.map((recipient) => {
                      const selected = selectedIds.has(recipient.id);
                      return (
                        <TableRow
                          key={recipient.id}
                          className="cursor-pointer"
                          data-state={selected ? 'selected' : undefined}
                          onClick={() => toggleRecipient(recipient.id, !selected)}
                        >
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) => toggleRecipient(recipient.id, checked === true)}
                              aria-label={`Selecionar ${recipient.guest_name ?? 'cliente'}`}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{recipient.guest_name || 'Cliente sem nome'}</TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">{formatBrazilPhone(recipient.guest_phone)}</TableCell>
                          <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                            {formatReservationDate(recipient)}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{recipient.party_size ?? '-'}</TableCell>
                          <TableCell className="hidden text-muted-foreground lg:table-cell">
                            {recipient.status ? getReservationStatusLabel(recipient.status) : '-'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pluguechat-broadcast-name">Nome do disparo</Label>
              <Input
                id="pluguechat-broadcast-name"
                placeholder="Ex: Convite happy hour sexta"
                value={broadcastName}
                onChange={(event) => setBroadcastName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pluguechat-template-id">Template</Label>
              <Input
                id="pluguechat-template-id"
                placeholder="Ex: convite_happy_hour"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-sm text-muted-foreground">
              {selectedRecipients.length > 0
                ? `Pronto para enviar para ${selectedRecipients.length} destinatario(s) unico(s).`
                : 'Selecione destinatarios acima para iniciar o disparo.'}
            </div>
            <Button
              type="button"
              className="gap-2"
              disabled={createBroadcast.isPending || selectedRecipients.length === 0 || !broadcastName.trim() || !templateId.trim()}
              onClick={handleCreate}
            >
              {createBroadcast.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Iniciar envio
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disparos recentes</CardTitle>
          <CardDescription>Acompanhe o progresso dos disparos PlugueChat.</CardDescription>
        </CardHeader>
        <CardContent>
          {broadcasts.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Nenhum disparo criado ainda.
            </div>
          ) : (
            <div className="space-y-3">
              {broadcasts.map((broadcast) => {
                const counts = recipientCounts.get(broadcast.id);
                const total = counts?.total ?? Number(broadcast.audience_filter?.recipient_count ?? 0);
                const done = (counts?.sent ?? 0) + (counts?.failed ?? 0);
                const progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                const canCancel = ['draft', 'scheduled', 'processing'].includes(broadcast.status);

                return (
                  <div key={broadcast.id} className="rounded-lg border p-4 transition-colors hover:bg-muted/30">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{getBroadcastTitle(broadcast)}</span>
                          <StatusBadge status={broadcast.status} />
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Criado em {formatDate(broadcast.created_at)} · Template: {broadcast.template_id}
                        </div>
                      </div>

                      {canCancel && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="gap-2 text-destructive hover:text-destructive"
                          disabled={cancelBroadcast.isPending}
                          onClick={() => setCancelTarget(broadcast)}
                        >
                          <Ban className="h-4 w-4" /> Cancelar
                        </Button>
                      )}
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <Progress value={progress} className="h-2 flex-1" />
                      <span className="min-w-12 text-right text-xs text-muted-foreground">{progress}%</span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>Total: <strong>{total}</strong></span>
                      {counts?.sent ? <span className="text-emerald-600">Enviados: <strong>{counts.sent}</strong></span> : null}
                      {counts?.pending ? <span className="text-blue-700">Na fila: <strong>{counts.pending}</strong></span> : null}
                      {counts?.failed ? <span className="text-red-700">Falharam: <strong>{counts.failed}</strong></span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar disparo?</DialogTitle>
            <DialogDescription>
              O disparo "{cancelTarget ? getBroadcastTitle(cancelTarget) : ''}" sera cancelado e nao podera ser retomado.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={cancelBroadcast.isPending}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!cancelTarget) return;
                cancelBroadcast.mutate(
                  { id: cancelTarget.id, companyId },
                  { onSettled: () => setCancelTarget(null) },
                );
              }}
              disabled={cancelBroadcast.isPending}
            >
              Confirmar cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
