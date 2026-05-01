import { type ChangeEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Play,
  Send,
  Square,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/hooks/useImpersonation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DateRangePicker } from '@/components/ui/date-range-picker';
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
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatBrazilPhone, normalizeBrazilPhoneDigits } from '@/lib/validation';
import { getReservationStatusLabel } from '@/lib/reservation-status';
import { parseWhatsAppErrorDetails } from '@/lib/whatsapp-automations';

interface Props {
  companyId: string;
}

type BroadcastStatus = 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed';

interface BroadcastRow {
  id: string;
  company_id: string;
  name: string;
  message: string;
  image_url: string | null;
  status: BroadcastStatus;
  delay_min_seconds: number;
  delay_max_seconds: number;
  filter_date_from: string | null;
  filter_date_to: string | null;
  filter_statuses: string[];
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  cancelled_count: number;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

interface RecipientRow {
  id: string;
  broadcast_id: string;
  reservation_id: string | null;
  phone: string;
  guest_name: string | null;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped' | 'cancelled';
  error_details: string | null;
  sent_at: string | null;
  attempts: number;
  created_at: string;
}

interface ReservationCandidate {
  id: string;
  guest_name: string;
  guest_phone: string;
  date: string;
  time: string;
  party_size: number;
  status: string;
}

const STATUS_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'checked_in', label: 'Check-in realizado' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'no-show', label: 'No Show' },
];

const BROADCAST_STATUS_CONFIG: Record<BroadcastStatus, { label: string; className: string }> = {
  pending: { label: 'Aguardando', className: 'bg-muted text-muted-foreground' },
  running: { label: 'Enviando', className: 'bg-blue-500/10 text-blue-600 border-blue-500/40' },
  paused: { label: 'Pausado', className: 'bg-amber-500/10 text-amber-600 border-amber-500/40' },
  cancelled: { label: 'Cancelado', className: 'bg-destructive/10 text-destructive border-destructive/40' },
  completed: { label: 'Concluído', className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/40' },
  failed: { label: 'Falhou', className: 'bg-destructive/10 text-destructive border-destructive/40' },
};

const RECIPIENT_STATUS_CONFIG: Record<RecipientRow['status'], { label: string; className: string }> = {
  pending: { label: 'Aguardando', className: 'text-muted-foreground' },
  processing: { label: 'Enviando', className: 'text-blue-600' },
  sent: { label: 'Enviado', className: 'text-emerald-600' },
  failed: { label: 'Falhou', className: 'text-destructive' },
  skipped: { label: 'Pulado', className: 'text-amber-600' },
  cancelled: { label: 'Cancelado', className: 'text-muted-foreground' },
};

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const ALLOWED_BROADCAST_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const BROADCAST_IMAGE_ACCEPT = 'image/png,image/jpeg';

function formatDate(value: string | null | undefined, pattern = "dd/MM/yyyy 'às' HH:mm") {
  if (!value) return '—';
  try {
    return format(parseISO(value), pattern, { locale: ptBR });
  } catch {
    return '—';
  }
}

export default function BroadcastsTab({ companyId }: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { isImpersonatingCompany, effectiveRole, scopeCompanyId } = useImpersonation();

  const [filterRange, setFilterRange] = useState<DateRange | undefined>();
  const [filterStatuses, setFilterStatuses] = useState<string[]>(['confirmed', 'checked_in']);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [broadcastName, setBroadcastName] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [delayMin, setDelayMin] = useState(20);
  const [delayMax, setDelayMax] = useState(40);
  const [detailsBroadcast, setDetailsBroadcast] = useState<BroadcastRow | null>(null);
  const [cancelTargetId, setCancelTargetId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const { data: reservations = [], isFetching: loadingReservations } = useQuery({
    queryKey: ['broadcast-candidates', companyId, filterRange?.from, filterRange?.to, filterStatuses.join(',')],
    queryFn: async () => {
      let query = supabase
        .from('reservations')
        .select('id, guest_name, guest_phone, date, time, party_size, status')
        .eq('company_id', companyId)
        .order('date', { ascending: true })
        .order('time', { ascending: true })
        .limit(500);

      if (filterRange?.from) {
        query = query.gte('date', format(filterRange.from, 'yyyy-MM-dd'));
      }
      if (filterRange?.to) {
        query = query.lte('date', format(filterRange.to, 'yyyy-MM-dd'));
      }
      if (filterStatuses.length > 0) {
        query = query.in('status', filterStatuses);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ReservationCandidate[];
    },
    enabled: !!companyId && (filterStatuses.length > 0),
  });

  const { data: broadcasts = [], isLoading: loadingBroadcasts } = useQuery({
    queryKey: ['broadcasts', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_broadcasts' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as BroadcastRow[];
    },
    enabled: !!companyId,
    refetchInterval: 10000,
  });

  const uniqueRecipients = useMemo(() => {
    const seen = new Map<string, ReservationCandidate>();
    for (const reservation of reservations) {
      const digits = normalizeBrazilPhoneDigits(reservation.guest_phone);
      if (!digits) continue;
      if (!seen.has(digits)) seen.set(digits, reservation);
    }
    return Array.from(seen.values());
  }, [reservations]);

  const selectedRecipients = useMemo(() => {
    return uniqueRecipients.filter((r) => selectedIds.has(r.id));
  }, [uniqueRecipients, selectedIds]);

  const allSelected = uniqueRecipients.length > 0 && selectedIds.size === uniqueRecipients.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(uniqueRecipients.map((r) => r.id)));
    } else {
      setSelectedIds(new Set());
    }
  }

  function toggleRow(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_BROADCAST_IMAGE_TYPES.has(file.type)) {
      toast.error('Use imagem PNG ou JPG. WebP nao e suportado para disparo no WhatsApp.');
      event.target.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error('A imagem deve ter no máximo 4MB');
      event.target.value = '';
      return;
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function removeImage() {
    setImageFile(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
  }

  const createBroadcastMutation = useMutation({
    mutationFn: async () => {
      if (selectedRecipients.length === 0) {
        throw new Error('Selecione pelo menos um destinatário.');
      }
      if (!message.trim()) {
        throw new Error('Escreva a mensagem do disparo.');
      }
      if (!broadcastName.trim()) {
        throw new Error('Informe um nome para o disparo.');
      }
      if (delayMin < 0 || delayMax < delayMin) {
        throw new Error('O delay máximo deve ser maior ou igual ao mínimo.');
      }

      let uploadedImageUrl: string | null = null;
      if (imageFile) {
        if (!ALLOWED_BROADCAST_IMAGE_TYPES.has(imageFile.type)) {
          throw new Error('Use imagem PNG ou JPG. WebP nao e suportado para disparo no WhatsApp.');
        }

        const extension = imageFile.type === 'image/png' ? 'png' : 'jpg';
        const filePath = `whatsapp-broadcasts/${companyId}/${Date.now()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from('system-assets')
          .upload(filePath, imageFile, { upsert: false });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage
          .from('system-assets')
          .getPublicUrl(filePath);
        uploadedImageUrl = publicUrlData.publicUrl;
      }

      const { data: broadcast, error: insertError } = await supabase
        .from('whatsapp_broadcasts' as any)
        .insert({
          company_id: companyId,
          created_by: user?.id ?? null,
          name: broadcastName.trim(),
          message: message.trim(),
          image_url: uploadedImageUrl,
          delay_min_seconds: delayMin,
          delay_max_seconds: delayMax,
          status: 'running',
          filter_date_from: filterRange?.from ? format(filterRange.from, 'yyyy-MM-dd') : null,
          filter_date_to: filterRange?.to ? format(filterRange.to, 'yyyy-MM-dd') : null,
          filter_statuses: filterStatuses,
          total_recipients: selectedRecipients.length,
        })
        .select('*')
        .single();

      if (insertError) throw insertError;
      const createdBroadcast = broadcast as unknown as BroadcastRow;

      const recipientRows = selectedRecipients.map((r) => ({
        broadcast_id: createdBroadcast.id,
        company_id: companyId,
        reservation_id: r.id,
        phone: r.guest_phone,
        guest_name: r.guest_name,
        status: 'pending' as const,
      }));

      if (recipientRows.length > 0) {
        const { error: recipientsError } = await supabase
          .from('whatsapp_broadcast_recipients' as any)
          .insert(recipientRows);
        if (recipientsError) throw recipientsError;
      }

      supabase.functions.invoke('process-whatsapp-broadcasts', {
        body: {
          company_id: companyId,
          ...(isImpersonatingCompany && scopeCompanyId
            ? { scope_company_id: scopeCompanyId, impersonated_by_superadmin: true, effective_role: effectiveRole }
            : {}),
        },
      }).catch(() => {});

      return createdBroadcast;
    },
    onSuccess: () => {
      toast.success('Disparo iniciado');
      setMessage('');
      setBroadcastName('');
      removeImage();
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ['broadcasts', companyId] });
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível criar o disparo');
    },
  });

  const cancelBroadcastMutation = useMutation({
    mutationFn: async (broadcastId: string) => {
      const { error } = await supabase
        .from('whatsapp_broadcasts' as any)
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', broadcastId);
      if (error) throw error;

      await supabase
        .from('whatsapp_broadcast_recipients' as any)
        .update({ status: 'cancelled' })
        .eq('broadcast_id', broadcastId)
        .eq('status', 'pending');
    },
    onSuccess: () => {
      toast.success('Disparo cancelado');
      qc.invalidateQueries({ queryKey: ['broadcasts', companyId] });
      setCancelTargetId(null);
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível cancelar o disparo');
    },
  });

  const deleteBroadcastMutation = useMutation({
    mutationFn: async (broadcastId: string) => {
      const { error } = await supabase
        .from('whatsapp_broadcasts' as any)
        .delete()
        .eq('id', broadcastId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Disparo excluído');
      qc.invalidateQueries({ queryKey: ['broadcasts', companyId] });
    },
    onError: (error: any) => {
      toast.error(error.message || 'Não foi possível excluir o disparo');
    },
  });

  function toggleStatusFilter(status: string) {
    setFilterStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
    setSelectedIds(new Set());
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="h-5 w-5 text-primary" /> Novo disparo
          </CardTitle>
          <CardDescription>
            Selecione reservas por período e status, escolha os destinatários e envie uma mensagem em massa.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Período das reservas</Label>
              <DateRangePicker
                value={filterRange}
                onChange={(range) => {
                  setFilterRange(range);
                  setSelectedIds(new Set());
                }}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <Label>Status das reservas</Label>
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTER_OPTIONS.map((option) => {
                  const active = filterStatuses.includes(option.value);
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      onClick={() => toggleStatusFilter(option.value)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Users className="h-4 w-4" /> Destinatários encontrados ({uniqueRecipients.length})
              </Label>
              <span className="text-sm text-muted-foreground">{selectedIds.size} selecionado(s)</span>
            </div>

            <div className="rounded-md border max-h-[360px] overflow-auto">
              {loadingReservations ? (
                <div className="p-4 space-y-2">
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : uniqueRecipients.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Nenhuma reserva encontrada para os filtros selecionados.
                </div>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                          onCheckedChange={(checked) => toggleAll(checked === true)}
                        />
                      </TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead>Pessoas</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uniqueRecipients.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => toggleRow(r.id, !selectedIds.has(r.id))}>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedIds.has(r.id)}
                            onCheckedChange={(checked) => toggleRow(r.id, checked === true)}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{r.guest_name}</TableCell>
                        <TableCell>{formatBrazilPhone(r.guest_phone)}</TableCell>
                        <TableCell>
                          {r.date ? format(parseISO(r.date), 'dd/MM/yyyy', { locale: ptBR }) : '—'} {r.time?.slice(0, 5)}
                        </TableCell>
                        <TableCell>{r.party_size}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {getReservationStatusLabel(r.status)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="broadcast-name">Nome do disparo</Label>
              <Input
                id="broadcast-name"
                placeholder="Ex: Convite happy hour sexta"
                value={broadcastName}
                onChange={(e) => setBroadcastName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="delay-min">Delay mínimo (s)</Label>
                <Input
                  id="delay-min"
                  type="number"
                  min={0}
                  value={delayMin}
                  onChange={(e) => setDelayMin(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="delay-max">Delay máximo (s)</Label>
                <Input
                  id="delay-max"
                  type="number"
                  min={0}
                  value={delayMax}
                  onChange={(e) => setDelayMax(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="broadcast-message">Mensagem</Label>
            <Textarea
              id="broadcast-message"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escreva a mensagem que será enviada…"
            />
          </div>

          <div className="space-y-2">
            <Label>Imagem (opcional)</Label>
            {imagePreview ? (
              <div className="flex items-start gap-3">
                <img src={imagePreview} alt="Preview" className="max-h-32 rounded-md border" />
                <Button type="button" size="sm" variant="outline" onClick={removeImage} className="gap-2">
                  <X className="h-4 w-4" /> Remover
                </Button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground hover:bg-muted">
                <Upload className="h-4 w-4" />
                <span>Clique para anexar uma imagem PNG/JPG (máx. 4MB)</span>
                <input type="file" accept={BROADCAST_IMAGE_ACCEPT} className="hidden" onChange={handleImageChange} />
              </label>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-sm text-muted-foreground">
              {selectedRecipients.length > 0
                ? `Pronto para enviar para ${selectedRecipients.length} destinatário(s) únicos.`
                : 'Selecione destinatários acima para iniciar o disparo.'}
            </div>
            <Button
              onClick={() => createBroadcastMutation.mutate()}
              disabled={
                createBroadcastMutation.isPending ||
                selectedRecipients.length === 0 ||
                !message.trim() ||
                !broadcastName.trim()
              }
              className="gap-2"
            >
              {createBroadcastMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Iniciar envio
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disparos recentes</CardTitle>
          <CardDescription>Acompanhe o progresso e abra para ver o relatório detalhado.</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingBroadcasts ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : broadcasts.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Nenhum disparo criado ainda.
            </div>
          ) : (
            <div className="space-y-3">
              {broadcasts.map((b) => {
                const total = b.total_recipients || 1;
                const done = b.sent_count + b.failed_count + b.skipped_count + b.cancelled_count;
                const progress = Math.min(100, Math.round((done / total) * 100));
                const statusCfg = BROADCAST_STATUS_CONFIG[b.status];
                const canCancel = b.status === 'running' || b.status === 'paused' || b.status === 'pending';

                return (
                  <div
                    key={b.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailsBroadcast(b)}
                    onKeyDown={(e) => e.key === 'Enter' && setDetailsBroadcast(b)}
                    className="group cursor-pointer rounded-lg border p-4 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{b.name}</span>
                          <Badge variant="outline" className={cn('border text-xs', statusCfg.className)}>
                            {statusCfg.label}
                          </Badge>
                          {b.image_url ? (
                            <Badge variant="outline" className="gap-1 text-xs">
                              <ImageIcon className="h-3 w-3" /> com imagem
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Criado em {formatDate(b.created_at)} · {b.total_recipients} destinatário(s)
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {canCancel ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => { e.stopPropagation(); setCancelTargetId(b.id); }}
                            className="gap-2"
                          >
                            <Square className="h-4 w-4" /> Cancelar
                          </Button>
                        ) : null}
                        {!canCancel ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); setDeleteTargetId(b.id); }}
                            disabled={deleteBroadcastMutation.isPending}
                            className="gap-2 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <Progress value={progress} className="h-2 flex-1" />
                      <span className="min-w-[3rem] text-right text-xs text-muted-foreground">{progress}%</span>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1 text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" /> {b.sent_count} enviados
                      </span>
                      {b.failed_count > 0 ? (
                        <span className="flex items-center gap-1 text-destructive">
                          <AlertCircle className="h-3 w-3" /> {b.failed_count} falharam
                        </span>
                      ) : null}
                      {b.skipped_count > 0 ? <span>{b.skipped_count} pulados</span> : null}
                      {b.cancelled_count > 0 ? <span>{b.cancelled_count} cancelados</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <BroadcastDetailsDialog
        broadcast={detailsBroadcast}
        onClose={() => setDetailsBroadcast(null)}
      />

      <Dialog open={!!deleteTargetId} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir disparo?</DialogTitle>
            <DialogDescription>
              O disparo e todo o seu histórico serão removidos permanentemente. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargetId(null)}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteTargetId) { deleteBroadcastMutation.mutate(deleteTargetId); setDeleteTargetId(null); } }}
              disabled={deleteBroadcastMutation.isPending}
              className="gap-2"
            >
              {deleteBroadcastMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Excluir permanentemente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTargetId} onOpenChange={(open) => !open && setCancelTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar disparo?</DialogTitle>
            <DialogDescription>
              Os destinatários que ainda não foram contatados serão marcados como cancelados. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTargetId(null)}>
              Voltar
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelTargetId && cancelBroadcastMutation.mutate(cancelTargetId)}
              disabled={cancelBroadcastMutation.isPending}
              className="gap-2"
            >
              {cancelBroadcastMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              Cancelar disparo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BroadcastDetailsDialog({
  broadcast,
  onClose,
}: {
  broadcast: BroadcastRow | null;
  onClose: () => void;
}) {
  const { data: recipients = [], isLoading } = useQuery({
    queryKey: ['broadcast-recipients', broadcast?.id],
    queryFn: async () => {
      if (!broadcast) return [];
      const { data, error } = await supabase
        .from('whatsapp_broadcast_recipients' as any)
        .select('*')
        .eq('broadcast_id', broadcast.id)
        .order('created_at', { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as RecipientRow[];
    },
    enabled: !!broadcast,
    refetchInterval: broadcast?.status === 'running' ? 5000 : false,
  });

  const [statusFilter, setStatusFilter] = useState<'all' | RecipientRow['status']>('all');

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return recipients;
    return recipients.filter((r) => r.status === statusFilter);
  }, [recipients, statusFilter]);

  if (!broadcast) return null;

  return (
    <Dialog open={!!broadcast} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{broadcast.name}</DialogTitle>
          <DialogDescription>
            Criado em {formatDate(broadcast.created_at)} · {broadcast.total_recipients} destinatário(s)
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 md:grid-cols-4">
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Enviados</div>
              <div className="text-2xl font-semibold text-emerald-600">{broadcast.sent_count}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Falharam</div>
              <div className="text-2xl font-semibold text-destructive">{broadcast.failed_count}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Pulados</div>
              <div className="text-2xl font-semibold text-amber-600">{broadcast.skipped_count}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground">Cancelados</div>
              <div className="text-2xl font-semibold text-muted-foreground">{broadcast.cancelled_count}</div>
            </CardContent>
          </Card>
        </div>

        {broadcast.image_url ? (
          <div className="flex items-start gap-3 rounded-md border p-3">
            <img src={broadcast.image_url} alt="Imagem do disparo" className="max-h-24 rounded" />
            <div className="flex-1 text-sm whitespace-pre-wrap">{broadcast.message}</div>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/50 p-3 text-sm whitespace-pre-wrap">{broadcast.message}</div>
        )}

        <div className="flex items-center gap-2">
          <Label className="text-sm">Filtrar:</Label>
          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="processing">Enviando</SelectItem>
              <SelectItem value="sent">Enviados</SelectItem>
              <SelectItem value="failed">Falharam</SelectItem>
              <SelectItem value="pending">Aguardando</SelectItem>
              <SelectItem value="skipped">Pulados</SelectItem>
              <SelectItem value="cancelled">Cancelados</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} destinatário(s)</span>
        </div>

        <div className="max-h-[400px] overflow-y-auto rounded-md border">
          {isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Nenhum destinatário neste filtro.</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="whitespace-nowrap">Nome</TableHead>
                  <TableHead className="whitespace-nowrap">Telefone</TableHead>
                  <TableHead className="whitespace-nowrap">Status</TableHead>
                  <TableHead className="whitespace-nowrap">Enviado em</TableHead>
                  <TableHead>Observação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const cfg = RECIPIENT_STATUS_CONFIG[r.status];
                  const err = parseWhatsAppErrorDetails(r.error_details);
                  const obs = err ? `${err.title}: ${err.message}` : (r.status !== 'sent' && r.error_details ? r.error_details : null);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap font-medium">{r.guest_name || '—'}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatBrazilPhone(r.phone)}</TableCell>
                      <TableCell className={cn('whitespace-nowrap', cfg.className)}>{cfg.label}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                        {r.sent_at ? formatDate(r.sent_at) : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {obs ?? '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
