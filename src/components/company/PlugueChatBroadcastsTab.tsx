import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Clock, Plus, Send, Users, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type PlugueChatBroadcast, useCancelPlugueChatBroadcast, useCreatePlugueChatBroadcast, usePlugueChatBroadcasts } from '@/hooks/usePlugueChatBroadcasts';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

type RecipientCandidate = {
  id: string;
  guest_name: string | null;
  guest_phone: string | null;
  date: string | null;
  time: string | null;
  status: string | null;
};

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; icon: ReactNode; className: string }> = {
    draft: { label: 'Rascunho', icon: <Clock className="h-3 w-3" />, className: 'border-gray-200 bg-gray-50 text-gray-600' },
    scheduled: { label: 'Agendado', icon: <Clock className="h-3 w-3" />, className: 'border-blue-200 bg-blue-50 text-blue-700' },
    processing: { label: 'Processando', icon: <Send className="h-3 w-3" />, className: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
    completed: { label: 'Concluído', icon: <CheckCircle2 className="h-3 w-3" />, className: 'border-green-200 bg-green-50 text-green-700' },
    cancelled: { label: 'Cancelado', icon: <Ban className="h-3 w-3" />, className: 'border-gray-200 bg-gray-50 text-gray-500' },
    failed: { label: 'Falhou', icon: <XCircle className="h-3 w-3" />, className: 'border-red-200 bg-red-50 text-red-700' },
  };

  const c = config[status] ?? config.draft;
  return (
    <Badge variant="outline" className={`gap-1 ${c.className}`}>
      {c.icon} {c.label}
    </Badge>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function normalizePhoneDigits(value: string | null | undefined) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (!digits.startsWith('55') && digits.length <= 11) digits = `55${digits}`;
  return digits;
}

function formatReservationDate(candidate: RecipientCandidate) {
  if (!candidate.date) return 'Sem data';
  const [year, month, day] = candidate.date.split('-');
  const date = day && month && year ? `${day}/${month}/${year}` : candidate.date;
  return candidate.time ? `${date} ${candidate.time.slice(0, 5)}` : date;
}

export default function PlugueChatBroadcastsTab({ companyId, activeChannel }: Props) {
  const { data: broadcasts, isLoading } = usePlugueChatBroadcasts(companyId);
  const createBroadcast = useCreatePlugueChatBroadcast();
  const cancelBroadcast = useCancelPlugueChatBroadcast();

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<Set<string>>(new Set());
  const [cancelTarget, setCancelTarget] = useState<PlugueChatBroadcast | null>(null);

  const broadcastIds = useMemo(() => (broadcasts ?? []).map((b) => b.id), [broadcasts]);

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
  });

  const { data: recipientCandidates = [], isFetching: recipientsLoading } = useQuery({
    queryKey: ['pluguechat-broadcast-candidates', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations')
        .select('id, guest_name, guest_phone, date, time, status')
        .eq('company_id', companyId)
        .not('guest_phone', 'is', null)
        .order('date', { ascending: false })
        .order('time', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as RecipientCandidate[];
    },
    enabled: showNewDialog,
  });

  const recipientCounts = useMemo(() => {
    const map = new Map<string, { total: number; pending: number; sent: number; failed: number }>();
    for (const row of recipientRows ?? []) {
      const entry = map.get(row.broadcast_id) ?? { total: 0, pending: 0, sent: 0, failed: 0 };
      entry.total++;
      if (['pending', 'queued', 'processing', 'provider_queued', 'duplicate'].includes(row.status)) entry.pending++;
      else if (row.status === 'sent') entry.sent++;
      else if (row.status === 'failed') entry.failed++;
      map.set(row.broadcast_id, entry);
    }
    return map;
  }, [recipientRows]);

  const uniqueRecipientCandidates = useMemo(() => {
    const seen = new Set<string>();
    const unique: RecipientCandidate[] = [];

    for (const candidate of recipientCandidates) {
      const phone = normalizePhoneDigits(candidate.guest_phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      unique.push(candidate);
    }

    return unique;
  }, [recipientCandidates]);

  const selectedRecipients = useMemo(
    () => uniqueRecipientCandidates.filter((candidate) => selectedRecipientIds.has(candidate.id)),
    [selectedRecipientIds, uniqueRecipientCandidates],
  );

  const allRecipientsSelected = uniqueRecipientCandidates.length > 0
    && selectedRecipientIds.size === uniqueRecipientCandidates.length;
  const someRecipientsSelected = selectedRecipientIds.size > 0 && !allRecipientsSelected;

  useEffect(() => {
    if (!showNewDialog) {
      setSelectedRecipientIds(new Set());
    }
  }, [showNewDialog]);

  const toggleAllRecipients = (checked: boolean) => {
    setSelectedRecipientIds(checked ? new Set(uniqueRecipientCandidates.map((candidate) => candidate.id)) : new Set());
  };

  const toggleRecipient = (id: string, checked: boolean) => {
    setSelectedRecipientIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleCreate = () => {
    if (!templateId.trim() || selectedRecipients.length === 0) return;

    createBroadcast.mutate(
      {
        company_id: companyId,
        template_id: templateId.trim(),
        template_name: templateName.trim() || null,
        recipient_reservation_ids: selectedRecipients.map((recipient) => recipient.id),
        audience_filter: { source: 'selected_reservations' },
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      },
      {
        onSuccess: () => {
          setShowNewDialog(false);
          setTemplateId('');
          setTemplateName('');
          setScheduledFor('');
          setSelectedRecipientIds(new Set());
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {activeChannel !== 'pluguechat_official' && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          O canal ativo não é o PlugueChat Oficial. Disparos criados aqui só serão processados quando o canal for ativado.
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Disparos PlugueChat</h3>
          <p className="text-sm text-muted-foreground">
            Envie templates aprovados pela Meta para clientes selecionados.
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setShowNewDialog(true)}>
          <Plus className="h-4 w-4" /> Novo disparo
        </Button>
      </div>

      {!broadcasts || broadcasts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum disparo criado ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {broadcasts.map((broadcast) => (
            <Card key={broadcast.id} className="border border-border">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle className="text-sm font-medium">
                      {broadcast.template_name ?? broadcast.template_id}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      ID: {broadcast.template_id}
                    </CardDescription>
                  </div>
                  <StatusBadge status={broadcast.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Criado: {formatDate(broadcast.created_at)}</span>
                  {broadcast.scheduled_for && <span>Agendado: {formatDate(broadcast.scheduled_for)}</span>}
                  {broadcast.started_at && <span>Iniciado: {formatDate(broadcast.started_at)}</span>}
                  {broadcast.finished_at && <span>Concluído: {formatDate(broadcast.finished_at)}</span>}
                </div>
                {recipientCounts.has(broadcast.id) && (() => {
                  const c = recipientCounts.get(broadcast.id)!;
                  return (
                    <div className="flex flex-wrap gap-3 text-xs">
                      <span className="text-muted-foreground">Total: <strong>{c.total}</strong></span>
                      {c.sent > 0 && <span className="text-green-700">Enviados: <strong>{c.sent}</strong></span>}
                      {c.pending > 0 && <span className="text-blue-700">Na fila: <strong>{c.pending}</strong></span>}
                      {c.failed > 0 && <span className="text-red-700">Falhou: <strong>{c.failed}</strong></span>}
                    </div>
                  );
                })()}
                {['draft', 'scheduled'].includes(broadcast.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 text-destructive hover:text-destructive"
                    onClick={() => setCancelTarget(broadcast)}
                    disabled={cancelBroadcast.isPending}
                  >
                    <Ban className="h-3.5 w-3.5" /> Cancelar
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Novo disparo PlugueChat</DialogTitle>
            <DialogDescription>
              Escolha o template aprovado na Meta e selecione os clientes que receberão a mensagem.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bc-template-id">ID do template aprovado</Label>
                <Input
                  id="bc-template-id"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  placeholder="ex: promocao_verao_v1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bc-template-name">Nome interno do disparo</Label>
                <Input
                  id="bc-template-name"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="Ex: Promoção de junho"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-sm font-semibold">
                    <Users className="h-4 w-4 text-primary" /> Destinatários
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Clientes únicos por telefone, a partir das 500 reservas mais recentes com telefone cadastrado.
                  </p>
                </div>
                <Badge variant="outline">
                  {selectedRecipients.length} selecionado{selectedRecipients.length === 1 ? '' : 's'}
                </Badge>
              </div>

              <div className="mt-3 rounded-md border bg-background">
                {recipientsLoading ? (
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : uniqueRecipientCandidates.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Nenhum cliente com telefone cadastrado foi encontrado.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={allRecipientsSelected ? true : someRecipientsSelected ? 'indeterminate' : false}
                              onCheckedChange={(checked) => toggleAllRecipients(checked === true)}
                              aria-label="Selecionar todos os destinatários"
                            />
                          </TableHead>
                          <TableHead>Cliente</TableHead>
                          <TableHead>Telefone</TableHead>
                          <TableHead className="hidden sm:table-cell">Reserva</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {uniqueRecipientCandidates.map((candidate) => {
                          const selected = selectedRecipientIds.has(candidate.id);
                          return (
                            <TableRow key={candidate.id} data-state={selected ? 'selected' : undefined}>
                              <TableCell>
                                <Checkbox
                                  checked={selected}
                                  onCheckedChange={(checked) => toggleRecipient(candidate.id, checked === true)}
                                  aria-label={`Selecionar ${candidate.guest_name ?? 'cliente'}`}
                                />
                              </TableCell>
                              <TableCell className="max-w-[180px] truncate font-medium">
                                {candidate.guest_name || 'Cliente sem nome'}
                              </TableCell>
                              <TableCell>{normalizePhoneDigits(candidate.guest_phone)}</TableCell>
                              <TableCell className="hidden text-muted-foreground sm:table-cell">
                                {formatReservationDate(candidate)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <p className="font-medium">Campos enviados ao template</p>
              <p className="mt-1 text-muted-foreground">
                Use um template com uma variável no corpo: <span className="font-mono text-foreground">{'{{1}}'}</span> recebe o nome do cliente.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bc-scheduled">Agendar para (opcional)</Label>
              <Input
                id="bc-scheduled"
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Deixe em branco para enviar assim que a fila for processada.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)} disabled={createBroadcast.isPending}>
              Cancelar
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createBroadcast.isPending || !templateId.trim() || selectedRecipients.length === 0}
            >
              {createBroadcast.isPending ? 'Criando...' : 'Criar disparo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar disparo?</DialogTitle>
            <DialogDescription>
              O disparo "{cancelTarget?.template_name ?? cancelTarget?.template_id}" será cancelado e não poderá ser retomado.
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
