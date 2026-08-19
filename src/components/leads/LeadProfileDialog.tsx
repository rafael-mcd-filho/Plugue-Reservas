import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarDays,
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Mail,
  MapPin,
} from 'lucide-react';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCrmLeadPresenceHistory, type CrmLeadPresenceVisit } from '@/hooks/useCrmLeads';
import { supabase } from '@/integrations/supabase/client';
import {
  formatLeadPhoneText,
  formatLeadState,
  formatLeadVisitContext,
  formatReservationStatus,
  getLeadVisitStatusClassName,
  type CrmLeadProfile,
} from '@/lib/crm-lead-profile';
import { toast } from 'sonner';

export interface LeadProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: CrmLeadProfile | null;
  companyId: string | undefined;
  slug: string | undefined;
  profileLoading?: boolean;
  profileError?: string | null;
  onRetryProfile?: () => unknown | Promise<unknown>;
  /**
   * Atualiza o perfil antes de repetir o histórico. Retorne `true` quando a
   * contagem mudou e o perfil controlado foi atualizado; nesse caso, a nova
   * chave da consulta recarregará o histórico automaticamente.
   */
  onRefreshLead?: (lead: CrmLeadProfile) => Promise<boolean>;
}

const PRESENCE_PAGE_SIZE = 25;

export default function LeadProfileDialog({
  open,
  onOpenChange,
  lead,
  companyId,
  slug,
  profileLoading = false,
  profileError = null,
  onRetryProfile,
  onRefreshLead,
}: LeadProfileDialogProps) {
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [retryingHistory, setRetryingHistory] = useState(false);
  const [presencePage, setPresencePage] = useState(1);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const historyQuery = useCrmLeadPresenceHistory({
    companyId,
    customerKey: lead?.key,
    expectedVisitCount: lead?.total_reservations,
    enabled: open && !!lead,
  });

  useEffect(() => {
    if (!open) {
      setSelectedReservationId(null);
      setRetryingHistory(false);
      setPresencePage(1);
    }
  }, [open]);

  useEffect(() => {
    setSelectedReservationId(null);
    setPresencePage(1);
  }, [lead?.key]);

  const {
    data: selectedReservation,
    isLoading: selectedReservationLoading,
    error: selectedReservationError,
  } = useQuery({
    queryKey: ['lead-reservation-details', companyId, selectedReservationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as never)
        .select(
          'id, guest_name, guest_phone, guest_email, source, date, time, party_size, public_tracking_code, status, occasion, notes, checked_in_at, checked_in_party_size, created_at, updated_at',
        )
        .eq('company_id', companyId!)
        .eq('id', selectedReservationId!)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error('Reservation not found');
      }

      return data as ReservationDetails;
    },
    enabled: !!companyId && !!selectedReservationId,
  });

  useEffect(() => {
    if (!selectedReservationId || !selectedReservationError) {
      return;
    }

    toast.error('Não foi possível carregar os detalhes da reserva.');
    setSelectedReservationId(null);
  }, [selectedReservationError, selectedReservationId]);

  const retryHistory = async () => {
    if (!lead || retryingHistory) return;

    setRetryingHistory(true);
    try {
      const profileWasUpdated = onRefreshLead
        ? await onRefreshLead(lead)
        : false;

      if (!profileWasUpdated) {
        await historyQuery.refetch();
      }
    } finally {
      setRetryingHistory(false);
    }
  };

  const openReservationDetails = (visit: CrmLeadPresenceVisit) => {
    if (visit.visit_origin === 'reservation') {
      setSelectedReservationId(visit.visit_id);
    }
  };

  const presenceEvents = historyQuery.data?.visits ?? [];
  const presencePageCount = Math.max(1, Math.ceil(presenceEvents.length / PRESENCE_PAGE_SIZE));
  const displayedPresencePage = Math.min(presencePage, presencePageCount);
  const visiblePresenceEvents = presenceEvents.slice(
    (displayedPresencePage - 1) * PRESENCE_PAGE_SIZE,
    displayedPresencePage * PRESENCE_PAGE_SIZE,
  );
  const showProfileError = !!profileError && !lead;

  useEffect(() => {
    if (historyListRef.current) historyListRef.current.scrollTop = 0;
  }, [displayedPresencePage]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[80vh] overflow-y-auto sm:max-w-lg"
          aria-busy={profileLoading || historyQuery.isLoading}
        >
          {profileLoading && !lead ? (
            <>
              <DialogHeader>
                <DialogTitle>Perfil do cliente</DialogTitle>
                <DialogDescription className="sr-only">
                  Carregando os dados e o histórico completo do cliente.
                </DialogDescription>
              </DialogHeader>
              <div
                className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 p-6 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Carregando perfil do cliente…
              </div>
            </>
          ) : showProfileError ? (
            <>
              <DialogHeader>
                <DialogTitle>Perfil do cliente</DialogTitle>
                <DialogDescription className="sr-only">
                  Não foi possível carregar o perfil selecionado.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm" role="alert">
                <p className="text-foreground">{profileError}</p>
                {onRetryProfile && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void onRetryProfile()}
                  >
                    Tentar novamente
                  </Button>
                )}
              </div>
            </>
          ) : lead ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
                    {(lead.guest_name.charAt(0) || '?').toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="break-words">{lead.guest_name}</p>
                    <p className="break-all text-sm font-normal text-muted-foreground">
                      {formatLeadPhoneText(lead.guest_phone)}
                    </p>
                  </div>
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Dados do cliente e histórico completo de presenças.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 pt-2">
                {lead.guest_email && (
                  <div className="flex min-w-0 items-start gap-2 text-sm">
                    <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 break-all text-foreground">{lead.guest_email}</span>
                  </div>
                )}

                {lead.guest_birthdate && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="text-foreground">
                      {format(new Date(`${lead.guest_birthdate}T12:00:00`), "dd 'de' MMMM", {
                        locale: ptBR,
                      })}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <CalendarIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-foreground">
                    Lead desde{' '}
                    {format(parseISO(lead.lead_created_at), "dd 'de' MMMM 'de' yyyy", {
                      locale: ptBR,
                    })}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-foreground">{formatLeadState(lead)}</span>
                </div>

                {lead.importedLeadId && (
                  <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/20 p-3 text-sm">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Origem do lead</p>
                    <p className="mt-1 break-words font-medium text-foreground">
                      Importado via CSV{lead.importFilename ? ` · ${lead.importFilename}` : ''}
                    </p>
                    {lead.importedAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Última importação em {format(parseISO(lead.importedAt), 'dd/MM/yyyy HH:mm')}
                      </p>
                    )}
                    {lead.importedNotes && (
                      <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {lead.importedNotes}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-4">
                <h4 className="mb-3 text-sm font-semibold text-foreground">
                  Histórico de Presenças ({lead.total_reservations})
                </h4>
                {historyQuery.isLoading ? (
                  <div
                    className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Carregando histórico completo…
                  </div>
                ) : historyQuery.isError ? (
                  <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm" role="alert">
                    <p className="text-foreground">Não foi possível carregar o histórico de presenças.</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 gap-2"
                      disabled={retryingHistory || historyQuery.isFetching}
                      onClick={() => void retryHistory()}
                    >
                      {(retryingHistory || historyQuery.isFetching) && (
                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      )}
                      Tentar novamente
                    </Button>
                  </div>
                ) : presenceEvents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                    Este contato ainda não possui presenças registradas. Reservas apenas confirmadas, canceladas ou marcadas como no-show não entram nesta contagem.
                  </div>
                ) : (
                  <div>
                    <div ref={historyListRef} className="max-h-60 space-y-2 overflow-y-auto">
                      {visiblePresenceEvents.map((visit) => {
                      const canOpenReservation = visit.visit_origin === 'reservation';
                      const content = (
                        <>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-foreground">
                              {format(new Date(`${visit.date}T12:00:00`), 'dd/MM/yyyy', { locale: ptBR })} às{' '}
                              {visit.time?.substring(0, 5)}
                            </p>
                            <p className="break-words text-xs text-muted-foreground">
                              {visit.party_size} pessoas
                              {formatLeadVisitContext(visit)}
                              {visit.occasion ? ` · ${visit.occasion}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge className={getLeadVisitStatusClassName(visit.status)}>
                              {formatReservationStatus(visit.status)}
                            </Badge>
                            {canOpenReservation && <Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                          </div>
                        </>
                      );

                      if (!canOpenReservation) {
                        return (
                          <div
                            key={visit.id}
                            className="flex items-start justify-between gap-3 overflow-hidden rounded-md border border-border p-3 text-sm"
                          >
                            {content}
                          </div>
                        );
                      }

                      return (
                        <button
                          type="button"
                          key={visit.id}
                          className="flex w-full items-start justify-between gap-3 overflow-hidden rounded-md border border-border p-3 text-left text-sm transition hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          onClick={() => openReservationDetails(visit)}
                          aria-label={`Abrir detalhes da presença de ${format(new Date(`${visit.date}T12:00:00`), 'dd/MM/yyyy')}`}
                        >
                          {content}
                        </button>
                      );
                      })}
                    </div>

                    {presencePageCount > 1 && (
                      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                          {(displayedPresencePage - 1) * PRESENCE_PAGE_SIZE + 1}
                          {'–'}
                          {Math.min(displayedPresencePage * PRESENCE_PAGE_SIZE, presenceEvents.length)}
                          {' de '}
                          {presenceEvents.length} presenças
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11"
                            disabled={displayedPresencePage === 1}
                            onClick={() => setPresencePage((current) => Math.max(1, current - 1))}
                            aria-label="Página anterior do histórico"
                          >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11"
                            disabled={displayedPresencePage === presencePageCount}
                            onClick={() => setPresencePage((current) => Math.min(presencePageCount, current + 1))}
                            aria-label="Próxima página do histórico"
                          >
                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Perfil do cliente</DialogTitle>
                <DialogDescription className="sr-only">
                  O perfil selecionado não está disponível.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                O perfil deste cliente não está disponível.
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ReservationDetailsDialog
        open={!!selectedReservationId}
        onOpenChange={(reservationOpen) => {
          if (!reservationOpen) {
            setSelectedReservationId(null);
          }
        }}
        reservation={selectedReservation ?? null}
        slug={slug}
        companyId={companyId}
        loading={selectedReservationLoading}
        onBackToList={() => setSelectedReservationId(null)}
        backLabel="Voltar para o lead"
      />
    </>
  );
}
