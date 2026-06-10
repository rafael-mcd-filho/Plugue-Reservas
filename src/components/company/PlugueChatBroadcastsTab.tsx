import { useMemo, useState } from 'react';
import { Ban, CheckCircle2, Clock, Plus, Send, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { type PlugueChatBroadcast, useCancelPlugueChatBroadcast, useCreatePlugueChatBroadcast, usePlugueChatBroadcasts } from '@/hooks/usePlugueChatBroadcasts';
import type { WhatsAppChannel } from '@/hooks/useWhatsAppChannel';

interface Props {
  companyId: string;
  activeChannel: WhatsAppChannel;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
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
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function PlugueChatBroadcastsTab({ companyId, activeChannel }: Props) {
  const { data: broadcasts, isLoading } = usePlugueChatBroadcasts(companyId);
  const createBroadcast = useCreatePlugueChatBroadcast();
  const cancelBroadcast = useCancelPlugueChatBroadcast();

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
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

  const recipientCounts = useMemo(() => {
    const map = new Map<string, { total: number; pending: number; sent: number; failed: number }>();
    for (const row of recipientRows ?? []) {
      const entry = map.get(row.broadcast_id) ?? { total: 0, pending: 0, sent: 0, failed: 0 };
      entry.total++;
      if (['pending', 'queued', 'processing', 'provider_queued'].includes(row.status)) entry.pending++;
      else if (row.status === 'sent') entry.sent++;
      else if (row.status === 'failed') entry.failed++;
      map.set(row.broadcast_id, entry);
    }
    return map;
  }, [recipientRows]);

  const handleCreate = () => {
    if (!templateId.trim()) return;

    createBroadcast.mutate(
      {
        company_id: companyId,
        template_id: templateId.trim(),
        template_name: templateName.trim() || null,
        audience_filter: {},
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      },
      {
        onSuccess: () => {
          setShowNewDialog(false);
          setTemplateId('');
          setTemplateName('');
          setScheduledFor('');
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

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Disparos PlugueChat</h3>
          <p className="text-sm text-muted-foreground">
            Envie templates aprovados pela Meta para todos os clientes ou um segmento.
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

      {/* Diálogo novo disparo */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo disparo PlugueChat</DialogTitle>
            <DialogDescription>
              Informe o template aprovado na Meta. O disparo será enviado para todos os clientes com telefone cadastrado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="bc-template-id">Template ID</Label>
              <Input
                id="bc-template-id"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                placeholder="ex: promocao_verao_v1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bc-template-name">Nome do template (referência)</Label>
              <Input
                id="bc-template-name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Opcional"
              />
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
                Deixe em branco para salvar como rascunho e processar manualmente.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)} disabled={createBroadcast.isPending}>
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={createBroadcast.isPending || !templateId.trim()}>
              {createBroadcast.isPending ? 'Criando...' : 'Criar disparo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo confirmar cancelamento */}
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
