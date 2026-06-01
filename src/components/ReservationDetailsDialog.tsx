import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Activity, Ban, ChevronDown, ChevronLeft, Copy, ExternalLink, Eye, Loader2, Pencil, Users } from 'lucide-react';
import { toast } from 'sonner';
import PhoneWhatsAppLink from '@/components/PhoneWhatsAppLink';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { getReservationStatusLabel } from '@/lib/reservation-status';
import { formatBrazilPhone, normalizeBrazilPhoneDigits } from '@/lib/validation';
import type { ReservationStatus } from '@/types/restaurant';

interface ReservationCompanion {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  position: number;
}

export interface ReservationDetails {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  source: string | null;
  origin_affiliate_code?: string | null;
  origin_affiliate_name?: string | null;
  date: string;
  time: string;
  party_size: number;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
  checked_in_at: string | null;
  checked_in_party_size: number | null;
  created_at: string;
  updated_at: string;
  public_tracking_code: string;
}

interface ReservationTimelineItem {
  id: string;
  occurred_at: string;
  source: string;
  event_name: string;
  tracking_source: string;
  title: string;
  description: string | null;
  status: string | null;
  payload: Record<string, unknown> | null;
  actor_name: string | null;
  actor_role: string | null;
  actor_source: string | null;
}

interface ReservationLeadHistoryItem extends ReservationDetails {
  guest_birthdate?: string | null;
}

interface ReservationDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservation: ReservationDetails | null;
  slug: string;
  companyId?: string | null;
  loading?: boolean;
  onBackToList?: () => void;
  backLabel?: string;
  /** @deprecated Use onEdit/onCheckIn/onStatusChange/onCancel instead */
  actions?: ReactNode;
  onEdit?: (reservation: ReservationDetails) => void;
  onCheckIn?: (reservation: ReservationDetails) => void;
  onStatusChange?: (reservation: ReservationDetails) => void;
  onCancel?: (reservation: ReservationDetails) => void;
  showEventHistory?: boolean;
  showLeadHistory?: boolean;
  onReservationSelect?: (reservation: ReservationDetails) => void;
}

function formatTimelineSource(source: string) {
  if (source === 'meta') return 'Meta CAPI';
  if (source === 'audit') return 'Auditoria';
  return 'Tracking';
}

function formatAttemptStatus(status: string | null) {
  if (status === 'sent') return 'Sucesso';
  if (status === 'failed') return 'Erro';
  if (status === 'processing') return 'Processando';
  if (status === 'pending') return 'Pendente';
  return status ?? 'Sem status';
}

function formatTimelineTitle(item: ReservationTimelineItem) {
  if (item.event_name === 'reservation_no_show') {
    return 'Marcada como No Show';
  }
  if (item.source === 'meta' && item.event_name) {
    return `${item.title} · ${item.event_name}`;
  }
  return item.title;
}

const AUDIT_FIELD_LABELS: Record<string, string> = {
  guest_name: 'Nome',
  guest_phone: 'WhatsApp',
  guest_email: 'E-mail',
  guest_birthdate: 'Nascimento',
  date: 'Data',
  time: 'Horário',
  party_size: 'Pessoas reservadas',
  occasion: 'Ocasião',
  notes: 'Observações',
  status: 'Status',
  checked_in_at: 'Check-in',
  checked_in_party_size: 'Pessoas presentes',
};

function formatAuditRole(role: string | null) {
  if (role === 'superadmin') return 'Superadmin';
  if (role === 'admin') return 'Admin';
  if (role === 'operator') return 'Operador';
  if (role === 'user') return 'Usuário';
  if (role === 'system') return 'Sistema';
  return role;
}

function formatAuditValue(field: string, value: unknown) {
  if (value === null || value === undefined || value === '') {
    return 'vazio';
  }

  if (field === 'status' && typeof value === 'string') {
    return getReservationStatusLabel(value);
  }

  if (field === 'date' && typeof value === 'string') {
    const dateValue = new Date(`${value}T12:00:00`);
    if (!Number.isNaN(dateValue.getTime())) {
      return format(dateValue, 'dd/MM/yyyy', { locale: ptBR });
    }
    return value;
  }

  if (field === 'time' && typeof value === 'string') {
    return value.slice(0, 5);
  }

  if ((field === 'checked_in_at' || field === 'guest_birthdate') && typeof value === 'string') {
    const dateValue = field === 'guest_birthdate' ? new Date(`${value}T12:00:00`) : new Date(value);
    const pattern = field === 'guest_birthdate' ? 'dd/MM/yyyy' : "dd/MM/yyyy 'às' HH:mm";
    if (!Number.isNaN(dateValue.getTime())) {
      return format(dateValue, pattern, { locale: ptBR });
    }
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 'sim' : 'nao';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function getVisibleOccasionLabel(occasion: string | null | undefined) {
  const normalizedOccasion = occasion?.trim();
  if (!normalizedOccasion) return null;
  return normalizedOccasion.toLowerCase() === 'outro' ? null : normalizedOccasion;
}


const EDIT_DISPLAY_FIELDS = new Set(['date', 'time', 'party_size', 'guest_name', 'guest_phone', 'guest_email', 'guest_birthdate', 'occasion', 'notes']);

function getReservationEditChanges(item: ReservationTimelineItem) {
  if (item.event_name !== 'updated' || !item.payload || typeof item.payload !== 'object') {
    return [];
  }
  const changes = item.payload.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return [];
  }
  return Object.entries(changes)
    .filter(([field, change]) => EDIT_DISPLAY_FIELDS.has(field) && change && typeof change === 'object' && !Array.isArray(change))
    .map(([field, change]) => {
      const typedChange = change as { old?: unknown; new?: unknown };
      return {
        field,
        label: AUDIT_FIELD_LABELS[field] ?? field,
        oldValue: formatAuditValue(field, typedChange.old),
        newValue: formatAuditValue(field, typedChange.new),
      };
    });
}

function isDisplayableDescription(description: string | null | undefined): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  return !trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('/');
}

function getAuditActorLabel(item: ReservationTimelineItem) {
  if (item.source !== 'audit') return null;
  if (item.actor_source === 'system') return 'Sistema automático';
  if (item.actor_source === 'public') return item.actor_name ? `${item.actor_name} (Público)` : 'Público';

  const roleLabel = formatAuditRole(item.actor_role);
  if (item.actor_name && roleLabel) return `${item.actor_name} (${roleLabel})`;
  if (item.actor_name) return item.actor_name;
  return roleLabel ?? 'Usuário';
}

function sortReservationHistory(
  left: Pick<ReservationLeadHistoryItem, 'date' | 'time'>,
  right: Pick<ReservationLeadHistoryItem, 'date' | 'time'>,
) {
  const dateDiff = right.date.localeCompare(left.date);
  return dateDiff !== 0 ? dateDiff : right.time.localeCompare(left.time);
}

function getHistoryStatusBadgeClass(status: ReservationStatus) {
  switch (status) {
    case 'confirmed':
      return 'border-primary/20 bg-primary text-primary-foreground';
    case 'checked_in':
      return 'border-info/20 bg-info text-info-foreground';
    case 'cancelled':
      return 'border-destructive/20 bg-destructive text-destructive-foreground';
    case 'no-show':
      return 'border-secondary/20 bg-secondary text-secondary-foreground';
    default:
      return 'border-secondary/20 bg-secondary text-secondary-foreground';
  }
}

export default function ReservationDetailsDialog({
  open,
  onOpenChange,
  reservation,
  slug,
  companyId,
  loading = false,
  onBackToList,
  backLabel,
  actions,
  onEdit,
  onStatusChange,
  onCancel,
  showEventHistory = true,
  showLeadHistory = false,
  onReservationSelect,
}: ReservationDetailsDialogProps) {
  const [eventHistoryOpen, setEventHistoryOpen] = useState(false);
  const [auditHistoryOpen, setAuditHistoryOpen] = useState(false);
  const normalizedPhone = normalizeBrazilPhoneDigits(reservation?.guest_phone);
  const trackingUrl = reservation
    ? `${window.location.origin}/${slug}/reserva/${reservation.public_tracking_code}`
    : '';
  const visibleOccasion = getVisibleOccasionLabel(reservation?.occasion);

  useEffect(() => {
    if (!open) {
      setEventHistoryOpen(false);
      setAuditHistoryOpen(false);
    }
  }, [open]);

  const { data: companions = [], isLoading: companionsLoading } = useQuery({
    queryKey: ['reservation-companions', reservation?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservation_companions' as any)
        .select('id, name, phone, email, birthdate, position')
        .eq('reservation_id', reservation!.id)
        .order('position', { ascending: true });

      if (error) throw error;
      return ((data as any[]) ?? []) as ReservationCompanion[];
    },
    enabled: open && !!reservation?.id,
  });

  const {
    data: timeline = [],
    isLoading: timelineLoading,
    error: timelineError,
  } = useQuery({
    queryKey: ['reservation-event-history', reservation?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_reservation_event_history', {
        _reservation_id: reservation!.id,
      });

      if (error) throw error;
      return ((data as any[]) ?? []) as ReservationTimelineItem[];
    },
    enabled: showEventHistory && open && !!reservation?.id,
  });

  const {
    data: leadHistory = [],
    isLoading: leadHistoryLoading,
    error: leadHistoryError,
  } = useQuery({
    queryKey: ['reservation-lead-history', companyId, normalizedPhone],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as never)
        .select(
          'id, guest_name, guest_phone, guest_email, source, date, time, party_size, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at, public_tracking_code, origin_affiliate_code, origin_affiliate_name',
        )
        .eq('company_id', companyId!)
        .eq('guest_phone', normalizedPhone);

      if (error) throw error;

      return (((data ?? []) as any[]) as ReservationLeadHistoryItem[]).sort(sortReservationHistory);
    },
    enabled: showLeadHistory && open && !!companyId && normalizedPhone.length > 0,
  });

  const sortedTimeline = useMemo(
    () =>
      [...timeline].sort(
        (left, right) => new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime(),
      ),
    [timeline],
  );

  const auditTimeline = useMemo(
    () => sortedTimeline.filter((item) => item.source === 'audit'),
    [sortedTimeline],
  );

  const eventTimeline = useMemo(
    () => sortedTimeline.filter((item) => item.source !== 'audit'),
    [sortedTimeline],
  );

  const previousReservations = useMemo(
    () => leadHistory.filter((item) => item.id !== reservation?.id),
    [leadHistory, reservation?.id],
  );

  const copyTrackingLink = async () => {
    if (!trackingUrl) return;
    await navigator.clipboard.writeText(trackingUrl);
    toast.success('Link de acompanhamento copiado!');
  };

  const openTrackingLink = () => {
    if (!trackingUrl) return;
    window.open(trackingUrl, '_blank', 'noopener,noreferrer');
  };

  const renderTimelineItems = (items: ReservationTimelineItem[], emptyMessage: string) => {
    if (timelineLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando histÃ³rico...
        </div>
      );
    }

    if (timelineError) {
      return <p className="text-sm text-destructive">NÃ£o foi possÃ­vel carregar o histÃ³rico desta reserva.</p>;
    }

    if (items.length === 0) {
      return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
    }

    return (
      <div className="space-y-3">
        {items.map((item) => {
          const timelineTitle = formatTimelineTitle(item);
          const auditActorLabel = getAuditActorLabel(item);

          return (
            <div key={`${item.source}-${item.id}`} className="overflow-hidden rounded-lg border border-border bg-background/80 p-3 text-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{timelineTitle}</p>
                    <Badge variant={item.source === 'meta' ? 'outline' : 'secondary'}>
                      {formatTimelineSource(item.source)}
                    </Badge>
                    {item.source === 'audit' && item.actor_role && (
                      <Badge variant={item.actor_source === 'system' ? 'secondary' : 'outline'}>
                        {formatAuditRole(item.actor_role)}
                      </Badge>
                    )}
                    {item.source === 'audit' && item.actor_source === 'system' && (
                      <Badge variant="secondary">Automático</Badge>
                    )}
                    {item.status && (
                      <Badge variant={item.status === 'sent' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'outline'}>
                        {formatAttemptStatus(item.status)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(item.occurred_at), "dd/MM/yyyy 'Ã s' HH:mm:ss", { locale: ptBR })}
                  </p>
                  {auditActorLabel && (
                    <p className="text-xs text-muted-foreground">Por {auditActorLabel}</p>
                  )}
                </div>

              </div>

              {isDisplayableDescription(item.description) && (
                <p className="mt-2 max-w-full whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {item.description}
                </p>
              )}
              {(() => {
                const editChanges = getReservationEditChanges(item);
                if (editChanges.length === 0) return null;
                return (
                  <div className="mt-3 grid gap-2">
                    {editChanges.map((change) => (
                      <div key={change.field} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                        <p className="font-medium text-foreground">{change.label}</p>
                        <p className="mt-1 text-muted-foreground">Antes: {change.oldValue}</p>
                        <p className="text-muted-foreground">Depois: {change.newValue}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] w-[calc(100vw-1rem)] max-w-4xl overflow-x-hidden overflow-y-auto">
          <DialogHeader className="space-y-3">
            {onBackToList && (
              <div className="flex justify-start">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 gap-2 text-muted-foreground hover:text-foreground"
                  onClick={onBackToList}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {backLabel ?? 'Voltar'}
                </Button>
              </div>
            )}
            <DialogTitle className="text-left">Detalhes da reserva</DialogTitle>
            {actions ? (
              <div className="flex flex-wrap gap-2 pt-1">{actions}</div>
            ) : reservation && (onEdit || onStatusChange || onCancel) ? (
              <div className="grid gap-2 pt-1 sm:flex sm:flex-wrap">
                {onEdit && (
                  <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-2 sm:w-auto" onClick={() => onEdit(reservation)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Editar reserva
                  </Button>
                )}
                {onStatusChange && (
                  <Button type="button" variant="outline" size="sm" className="w-full justify-start sm:w-auto" onClick={() => onStatusChange(reservation)}>
                    Alterar status
                  </Button>
                )}
                {onCancel && reservation.status === 'confirmed' && (
                  <Button type="button" variant="destructive" size="sm" className="w-full justify-start gap-2 sm:w-auto" onClick={() => onCancel(reservation)}>
                    <Ban className="h-3.5 w-3.5" />
                    Cancelar reserva
                  </Button>
                )}
              </div>
            ) : null}
          </DialogHeader>

          {loading ? (
            <div className="flex min-h-[240px] items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando detalhes da reserva...
            </div>
          ) : reservation ? (
            <div className="space-y-5 pt-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className="text-lg font-semibold text-foreground">{reservation.guest_name}</p>
                  <PhoneWhatsAppLink
                    phone={reservation.guest_phone}
                    companyId={companyId}
                    slug={slug}
                    reservation={reservation}
                    phoneClassName="text-sm text-muted-foreground"
                  />
                  {reservation.guest_email && (
                    <p className="text-sm text-muted-foreground">{reservation.guest_email}</p>
                  )}
                </div>
                <div className="sm:pt-0.5">
                  <ReservationStatusBadge status={reservation.status} />
                </div>
              </div>

              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Data</p>
                  <p className="mt-1 font-medium text-foreground">
                    {format(new Date(`${reservation.date}T12:00:00`), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Horário</p>
                  <p className="mt-1 font-medium text-foreground">{reservation.time.slice(0, 5)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Pessoas reservadas</p>
                  <p className="mt-1 font-medium text-foreground">{reservation.party_size}</p>
                </div>
                {reservation.checked_in_party_size && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Pessoas presentes</p>
                    <p className="mt-1 font-medium text-foreground">{reservation.checked_in_party_size}</p>
                  </div>
                )}
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Criada em</p>
                  <p className="mt-1 font-medium text-foreground">
                    {format(new Date(reservation.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </p>
                </div>
                {reservation.checked_in_at && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Check-in</p>
                    <p className="mt-1 font-medium text-foreground">
                      {format(new Date(reservation.checked_in_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                    </p>
                  </div>
                )}
              </div>

              {(visibleOccasion || reservation.notes) && (
                <div className="space-y-3">
                  {visibleOccasion && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Ocasião</p>
                      <p className="mt-1 font-medium text-foreground">{visibleOccasion}</p>
                    </div>
                  )}
                  {reservation.notes && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Observações</p>
                      <p className="mt-1 whitespace-pre-wrap text-foreground">{reservation.notes}</p>
                    </div>
                  )}
                </div>
              )}

              {showEventHistory && (
                <div className="space-y-3">
                <div className="rounded-lg border border-border bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 p-4 text-left transition hover:bg-muted/30"
                  onClick={() => setAuditHistoryOpen((v) => !v)}
                >
                  <div className="flex items-center gap-2">
                    <Pencil className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Histórico de alterações</p>
                    {!timelineLoading && (
                      <span className="text-xs text-muted-foreground">({auditTimeline.length})</span>
                    )}
                  </div>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${auditHistoryOpen ? 'rotate-180' : ''}`} />
                </button>

                {auditHistoryOpen && (
                  <div className="border-t border-border px-4 pb-4 pt-3">
                    {renderTimelineItems(
                      auditTimeline,
                      'Nenhuma alteração registrada para esta reserva ainda.',
                    )}
                  </div>
                )}
                </div>
                <div className="rounded-lg border border-border bg-muted/20">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 p-4 text-left transition hover:bg-muted/30"
                  onClick={() => setEventHistoryOpen((v) => !v)}
                >
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Histórico de eventos</p>
                    {!timelineLoading && (
                      <span className="text-xs text-muted-foreground">({eventTimeline.length})</span>
                    )}
                  </div>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${eventHistoryOpen ? 'rotate-180' : ''}`} />
                </button>

                {eventHistoryOpen && (
                  <div className="border-t border-border px-4 pb-4 pt-3">
                {timelineLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Carregando histórico...
                  </div>
                ) : timelineError ? (
                  <p className="text-sm text-destructive">Não foi possível carregar o histórico desta reserva.</p>
                ) : eventTimeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum evento da jornada foi registrado para esta reserva ainda.</p>
                ) : (
                  <div className="space-y-3">
                    {eventTimeline.map((item) => {
                      const timelineTitle = formatTimelineTitle(item);
                                  const auditActorLabel = getAuditActorLabel(item);

                      return (
                      <div key={`${item.source}-${item.id}`} className="overflow-hidden rounded-lg border border-border bg-background/80 p-3 text-sm">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-foreground">{timelineTitle}</p>
                              <Badge variant={item.source === 'meta' ? 'outline' : 'secondary'}>
                                {formatTimelineSource(item.source)}
                              </Badge>
                              {item.source === 'audit' && item.actor_role && (
                                <Badge variant={item.actor_source === 'system' ? 'secondary' : 'outline'}>
                                  {formatAuditRole(item.actor_role)}
                                </Badge>
                              )}
                              {item.source === 'audit' && item.actor_source === 'system' && (
                                <Badge variant="secondary">Automático</Badge>
                              )}
                              {item.status && (
                                <Badge variant={item.status === 'sent' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'outline'}>
                                  {formatAttemptStatus(item.status)}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(item.occurred_at), "dd/MM/yyyy 'às' HH:mm:ss", { locale: ptBR })}
                            </p>
                            {auditActorLabel && (
                              <p className="text-xs text-muted-foreground">Por {auditActorLabel}</p>
                            )}
                          </div>

                        </div>

                        {isDisplayableDescription(item.description) && (
                          <p className="mt-2 max-w-full whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                            {item.description}
                          </p>
                        )}
                        {(() => {
                          const editChanges = getReservationEditChanges(item);
                          if (editChanges.length === 0) return null;
                          return (
                            <div className="mt-3 grid gap-2">
                              {editChanges.map((change) => (
                                <div key={change.field} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                                  <p className="font-medium text-foreground">{change.label}</p>
                                  <p className="mt-1 text-muted-foreground">Antes: {change.oldValue}</p>
                                  <p className="text-muted-foreground">Depois: {change.newValue}</p>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    )})}
                  </div>
                )}
                  </div>
                )}
                </div>
                </div>
              )}

              {(reservation.checked_in_at || companions.length > 0 || companionsLoading) && (
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-primary" />
                      <p className="text-sm font-medium text-foreground">Acompanhantes</p>
                    </div>
                    {!companionsLoading && (
                      <p className="text-xs text-muted-foreground">{companions.length} cadastrados</p>
                    )}
                  </div>

                  {companionsLoading ? (
                    <p className="mt-3 text-sm text-muted-foreground">Carregando acompanhantes...</p>
                  ) : companions.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">Nenhum acompanhante cadastrado neste check-in.</p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {companions.map((companion) => (
                        <div key={companion.id} className="rounded-lg border border-border bg-background/80 p-3 text-sm">
                          <p className="font-medium text-foreground">{companion.name}</p>
                          <div className="mt-1 space-y-1 text-muted-foreground">
                            {companion.phone && <p>{formatBrazilPhone(companion.phone)}</p>}
                            {companion.email && <p>{companion.email}</p>}
                            {companion.birthdate && (
                              <p>
                                Aniversario:{' '}
                                {format(new Date(`${companion.birthdate}T12:00:00`), "dd 'de' MMMM", {
                                  locale: ptBR,
                                })}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {showLeadHistory && (
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-primary" />
                      <p className="text-sm font-medium text-foreground">Histórico de presenças</p>
                    </div>
                    {!leadHistoryLoading && !leadHistoryError && (
                      <p className="text-xs text-muted-foreground">{previousReservations.length} anteriores</p>
                    )}
                  </div>

                  {leadHistoryLoading ? (
                    <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Carregando histórico do lead...
                    </div>
                  ) : leadHistoryError ? (
                    <p className="mt-3 text-sm text-destructive">Não foi possível carregar o histórico deste lead.</p>
                  ) : previousReservations.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Esta é a primeira presença registrada para este lead.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {previousReservations.map((item) => {
                        const visibleHistoryOccasion = getVisibleOccasionLabel(item.occasion);
                        const content = (
                          <>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground">
                                {format(new Date(`${item.date}T12:00:00`), 'dd/MM/yyyy', { locale: ptBR })} às{' '}
                                {item.time.slice(0, 5)}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.party_size} pessoas · Titular da reserva
                                {visibleHistoryOccasion ? ` · ${visibleHistoryOccasion}` : ''}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <Badge
                                className={`rounded-full border px-3 py-1 text-xs font-semibold shadow-none ${getHistoryStatusBadgeClass(item.status)}`}
                              >
                                {getReservationStatusLabel(item.status)}
                              </Badge>
                              {onReservationSelect && <Eye className="h-4 w-4 text-muted-foreground" />}
                            </div>
                          </>
                        );

                        if (!onReservationSelect) {
                          return (
                            <div
                              key={item.id}
                              className="flex items-center gap-4 rounded-lg border border-border bg-background/80 p-3 text-sm"
                            >
                              {content}
                            </div>
                          );
                        }

                        return (
                          <button
                            type="button"
                            key={item.id}
                            className="flex w-full items-center gap-4 rounded-lg border border-border bg-background/80 p-3 text-left text-sm transition hover:border-primary/35 hover:bg-background"
                            onClick={() => onReservationSelect(item)}
                          >
                            {content}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Link de acompanhamento</p>
                    <p className="break-all text-xs text-muted-foreground">{trackingUrl}</p>
                    {reservation.origin_affiliate_name && (
                      <div className="pt-2">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Origem afiliada</p>
                        <p className="mt-1 text-sm text-foreground">
                          {reservation.origin_affiliate_name}
                          {reservation.origin_affiliate_code ? ` · ${reservation.origin_affiliate_code}` : ''}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button type="button" variant="outline" className="w-full gap-2 sm:w-auto" onClick={copyTrackingLink}>
                    <Copy className="h-4 w-4" />
                    Copiar link
                  </Button>
                  <Button type="button" variant="outline" className="w-full gap-2 sm:w-auto" onClick={openTrackingLink}>
                    <ExternalLink className="h-4 w-4" />
                    Abrir acompanhamento
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[160px] items-center justify-center text-sm text-muted-foreground">
              Nenhuma reserva selecionada.
            </div>
          )}
        </DialogContent>
      </Dialog>

    </>
  );
}
