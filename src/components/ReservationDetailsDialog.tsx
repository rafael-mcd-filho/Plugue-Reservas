import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Activity, Copy, ExternalLink, Loader2, Send, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ReservationSourceBadge, ReservationStatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatBrazilPhone } from '@/lib/validation';

type ReservationStatus = 'confirmed' | 'checked_in' | 'cancelled' | 'completed' | 'no-show';

interface ReservationCompanion {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  position: number;
}

interface ReservationDetails {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  source: string | null;
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
  table_label?: string | null;
  table_map_name?: string | null;
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
}

interface ReservationDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservation: ReservationDetails | null;
  slug: string;
}

function formatTimelineSource(source: string) {
  if (source === 'meta') return 'Meta CAPI';
  return 'Tracking';
}

function formatAttemptStatus(status: string | null) {
  if (status === 'sent') return 'Sucesso';
  if (status === 'failed') return 'Erro';
  if (status === 'processing') return 'Processando';
  if (status === 'pending') return 'Pendente';
  return status ?? 'Sem status';
}

export default function ReservationDetailsDialog({
  open,
  onOpenChange,
  reservation,
  slug,
}: ReservationDetailsDialogProps) {
  const [selectedPayload, setSelectedPayload] = useState<{ title: string; content: string } | null>(null);
  const trackingUrl = reservation
    ? `${window.location.origin}/${slug}/reserva/${reservation.public_tracking_code}`
    : '';

  useEffect(() => {
    if (!open) {
      setSelectedPayload(null);
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
    enabled: open && !!reservation?.id,
  });

  const copyTrackingLink = async () => {
    if (!trackingUrl) return;
    await navigator.clipboard.writeText(trackingUrl);
    toast.success('Link de acompanhamento copiado!');
  };

  const openTrackingLink = () => {
    if (!trackingUrl) return;
    window.open(trackingUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Detalhes da reserva</DialogTitle>
          </DialogHeader>

          {reservation ? (
            <div className="space-y-5 pt-2">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-lg font-semibold text-foreground">{reservation.guest_name}</p>
                  <p className="text-sm text-muted-foreground">{formatBrazilPhone(reservation.guest_phone)}</p>
                  {reservation.guest_email && (
                    <p className="text-sm text-muted-foreground">{reservation.guest_email}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <ReservationSourceBadge source={reservation.source} />
                  <ReservationStatusBadge status={reservation.status} />
                </div>
              </div>

              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Origem</p>
                  <div className="mt-1">
                    <ReservationSourceBadge source={reservation.source} />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Data</p>
                  <p className="mt-1 font-medium text-foreground">
                    {format(new Date(`${reservation.date}T12:00:00`), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Horario</p>
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
                {(reservation.table_label || reservation.table_map_name) && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Mesa / mapa</p>
                    <p className="mt-1 font-medium text-foreground">
                      {reservation.table_label ?? 'Sem mesa'}
                      {reservation.table_map_name ? ` · ${reservation.table_map_name}` : ''}
                    </p>
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

              {(reservation.occasion || reservation.notes) && (
                <div className="space-y-3">
                  {reservation.occasion && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Ocasião</p>
                      <p className="mt-1 font-medium text-foreground">{reservation.occasion}</p>
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

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Histórico de eventos</p>
                  </div>
                  {!timelineLoading && (
                    <p className="text-xs text-muted-foreground">{timeline.length} registros</p>
                  )}
                </div>

                {timelineLoading ? (
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Carregando histórico...
                  </div>
                ) : timelineError ? (
                  <p className="mt-3 text-sm text-destructive">Não foi possível carregar o histórico desta reserva.</p>
                ) : timeline.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">Nenhum evento registrado para esta reserva ainda.</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {timeline.map((item) => (
                      <div key={`${item.source}-${item.id}`} className="rounded-lg border border-border bg-background/80 p-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-foreground">{item.title}</p>
                              <Badge variant={item.source === 'meta' ? 'outline' : 'secondary'}>
                                {formatTimelineSource(item.source)}
                              </Badge>
                              {item.status && (
                                <Badge variant={item.status === 'sent' ? 'secondary' : item.status === 'failed' ? 'destructive' : 'outline'}>
                                  {formatAttemptStatus(item.status)}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {format(new Date(item.occurred_at), "dd/MM/yyyy 'às' HH:mm:ss", { locale: ptBR })}
                            </p>
                          </div>

                          {item.payload && Object.keys(item.payload).length > 0 && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setSelectedPayload({
                                  title: `${item.title} (${formatTimelineSource(item.source)})`,
                                  content: JSON.stringify(item.payload, null, 2),
                                })
                              }
                            >
                              Ver payload
                            </Button>
                          )}
                        </div>

                        {item.description && (
                          <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(reservation.checked_in_at || companions.length > 0 || companionsLoading) && (
                <div className="rounded-lg border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-3">
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

              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Link de acompanhamento</p>
                    <p className="break-all text-xs text-muted-foreground">{trackingUrl}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button type="button" variant="outline" className="gap-2" onClick={copyTrackingLink}>
                    <Copy className="h-4 w-4" />
                    Copiar link
                  </Button>
                  <Button type="button" variant="outline" className="gap-2" onClick={openTrackingLink}>
                    <ExternalLink className="h-4 w-4" />
                    Abrir acompanhamento
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedPayload} onOpenChange={(nextOpen) => !nextOpen && setSelectedPayload(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              {selectedPayload?.title ?? 'Payload'}
            </DialogTitle>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-4 text-xs text-foreground">
            {selectedPayload?.content ?? ''}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
