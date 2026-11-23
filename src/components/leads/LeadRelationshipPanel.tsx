import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Eye, Loader2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getPaymentStatusLabel, type ReservationPaymentStatus } from '@/lib/asaas-prepayment-contracts';
import { WHATSAPP_MESSAGE_TYPE_LABELS } from '@/lib/whatsapp-automations';
import {
  getCrmMessageStatusLabel,
  getCrmReservationStatusLabel,
  getCrmRelationshipPage,
  type CrmRelationshipCapabilities,
  type CrmRelationshipMessage,
  type CrmRelationshipPayment,
  type CrmRelationshipReservation,
  type CrmRelationshipSection,
  type CrmRelationshipSummary,
} from '@/lib/crm-relationship';

interface Props {
  companyId: string;
  customerKey: string;
  open: boolean;
  canViewReservations: boolean;
  onOpenReservation: (id: string) => void;
  onReservationAccessChange: (allowed: boolean) => void;
  children: ReactNode;
}
type RelationshipTab = 'visits' | Exclude<CrmRelationshipSection, 'summary'>;
const labels = { visits: 'Visitas', reservations: 'Reservas', payments: 'Pagamentos', messages: 'Mensagens' };
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (date: string) => format(new Date(`${date}T12:00:00`), 'dd/MM/yyyy');
const formatTimestamp = (date: string) => format(parseISO(date), 'dd/MM/yyyy HH:mm');

function ErrorState({ retry, fetching }: { retry: () => unknown; fetching: boolean }) {
  return <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm">
    <p>Não foi possível carregar estas informações do cliente.</p>
    <Button type="button" variant="outline" size="sm" className="mt-3" disabled={fetching} onClick={() => void retry()}>Tentar novamente</Button>
  </div>;
}
function LoadingState() {
  return <div role="status" className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />Carregando informações do cliente…</div>;
}

export default function LeadRelationshipPanel(props: Props) {
  // The parent keys this component by unit/customer. No draft tab/page or cached
  // sensitive rows are reused when a different profile is opened.
  const [tab, setTab] = useState<RelationshipTab>('visits');
  const [sectionReservationAccess, setSectionReservationAccess] = useState(true);
  const { onReservationAccessChange } = props;
  const summaryQuery = useQuery({
    queryKey: ['crm-relationship', props.companyId, props.customerKey, 'summary'],
    queryFn: ({ signal }) => getCrmRelationshipPage({ companyId: props.companyId, customerKey: props.customerKey, section: 'summary', signal }),
    enabled: props.open, retry: false, staleTime: 0, gcTime: 0,
  });
  const { refetch: refetchSummary } = summaryQuery;
  const capabilities = props.open && !summaryQuery.isError && summaryQuery.data ? summaryQuery.data.capabilities : null;
  const hasReservationSection = props.canViewReservations && capabilities?.reservations === true;
  const canOpenReservation = hasReservationSection && sectionReservationAccess;
  const available: RelationshipTab[] = ['visits'];
  if (hasReservationSection) available.push('reservations');
  if (capabilities?.payments) available.push('payments');
  if (capabilities?.messages) available.push('messages');
  const displayedTab = available.includes(tab) ? tab : 'visits';

  useEffect(() => {
    if (summaryQuery.data && !summaryQuery.isError) setSectionReservationAccess(true);
  }, [summaryQuery.dataUpdatedAt, summaryQuery.isError, summaryQuery.data]);
  const onSectionAccessSnapshot = useCallback((allowed: boolean) => {
    setSectionReservationAccess(allowed);
    if (!allowed) void refetchSummary();
  }, [refetchSummary]);

  useEffect(() => {
    onReservationAccessChange(canOpenReservation);
  }, [canOpenReservation, onReservationAccessChange]);

  return <div className="pt-4">
    <Tabs value={displayedTab} onValueChange={(value) => setTab(value as RelationshipTab)}>
      <div className="overflow-x-auto pb-1"><TabsList aria-label="Histórico e relacionamento do cliente" className="h-auto w-max min-w-full justify-start gap-0.5">
        {available.map((value) => <TabsTrigger key={value} value={value} className="min-h-9 px-1.5 text-xs sm:px-3 sm:text-sm">{labels[value]}</TabsTrigger>)}
      </TabsList></div>
      {props.open && summaryQuery.isPending && <p role="status" className="mt-2 text-xs text-muted-foreground">Carregando outras informações do cliente…</p>}
      {summaryQuery.isError && <div className="mt-3"><ErrorState retry={summaryQuery.refetch} fetching={summaryQuery.isFetching} /></div>}
      <TabsContent value="visits" className="mt-3">{props.children}</TabsContent>
      {displayedTab !== 'visits' && capabilities && <TabsContent value={displayedTab} className="mt-3">
        <RelationshipSection key={`${props.companyId}:${props.customerKey}:${displayedTab}`}
          companyId={props.companyId} customerKey={props.customerKey} section={displayedTab}
          capabilities={capabilities} summary={summaryQuery.data!.summary}
          canOpenReservation={canOpenReservation} onOpenReservation={props.onOpenReservation}
          onReservationAccessSnapshot={onSectionAccessSnapshot} />
      </TabsContent>}
    </Tabs>
  </div>;
}

function RelationshipSection({ companyId, customerKey, section, capabilities, summary, canOpenReservation, onOpenReservation, onReservationAccessSnapshot }: {
  companyId: string; customerKey: string; section: Exclude<CrmRelationshipSection, 'summary'>;
  capabilities: CrmRelationshipCapabilities; summary: CrmRelationshipSummary;
  canOpenReservation: boolean; onOpenReservation: (id: string) => void;
  onReservationAccessSnapshot: (allowed: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['crm-relationship', companyId, customerKey, section, page, capabilities.reservations, capabilities.payments, capabilities.messages],
    queryFn: ({ signal }) => getCrmRelationshipPage({ companyId, customerKey, section, page, signal }),
    enabled: capabilities[section], retry: false, staleTime: 0, gcTime: 0,
  });
  const data = query.data;
  const currentSummary = data && !query.isError ? data.summary : summary;
  useEffect(() => {
    if (query.isError) onReservationAccessSnapshot(false);
    else if (data) onReservationAccessSnapshot(data.capabilities.reservations);
  }, [data, query.isError, query.errorUpdatedAt, onReservationAccessSnapshot]);
  const sectionLabel = labels[section].toLowerCase();
  const canOpenCurrentReservation = canOpenReservation && data?.capabilities.reservations === true && !query.isError;
  const openButton = (id: string) => canOpenCurrentReservation && <Button type="button" size="sm" variant="ghost" className="h-8 shrink-0 gap-1.5 px-2 text-xs" onClick={() => onOpenReservation(id)} aria-label={`Abrir reserva ${id}`}><Eye aria-hidden="true" className="h-3.5 w-3.5" />Ver reserva</Button>;

  return <div className="space-y-3">
    {section === 'reservations' && <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Próximas', currentSummary.upcoming_count], ['Agendamentos', currentSummary.reservation_count],
          ['Canceladas', currentSummary.cancelled_count], ['No-shows', currentSummary.no_show_count],
        ].map(([label, value]) => <div key={label} className="rounded-md border border-border bg-muted/20 px-2.5 py-2"><p className="text-[10px] font-medium text-muted-foreground">{label}</p><p className="mt-1 text-base font-semibold tabular-nums">{value ?? '—'}</p></div>)}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">Reservas futuras aparecem primeiro. Agendamento confirmado não significa comparecimento; as presenças estão na aba Visitas.</p>
    </>}
    {section === 'payments' && <p className="text-xs leading-relaxed text-muted-foreground">Pagamentos das reservas em que este cliente é titular. Os valores correspondem às cobranças da reserva, sem representar o consumo na unidade.</p>}
    {section === 'messages' && <p className="text-xs leading-relaxed text-muted-foreground">Mensagens registradas pela plataforma. O estado de envio não comprova leitura; conversas externas não estão incluídas.</p>}

    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState retry={query.refetch} fetching={query.isFetching} /> : data && data.rows.length === 0 ? <p className="rounded-lg border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground">Nenhum registro de {sectionLabel} para este cliente nesta unidade.</p> : data && <>
      <div className="max-h-72 space-y-2 overflow-y-auto" aria-label={`Registros de ${sectionLabel}`}>
        {section === 'reservations' && (data.rows as CrmRelationshipReservation[]).map((reservation) => <article key={reservation.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{formatDate(reservation.date)} às {reservation.time.slice(0, 5)}</p><Badge variant="secondary">{getCrmReservationStatusLabel(reservation.status)}</Badge></div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{reservation.party_size} pessoas</span>{reservation.is_upcoming && <span className="font-medium text-primary">Próxima reserva</span>}<span>{reservation.relationship_role === 'companion' ? reservation.holder_name ? `Acompanhou ${reservation.holder_name}` : 'Acompanhante' : 'Titular'}</span></div>
          {reservation.occasion && <p className="mt-1 break-words text-xs text-muted-foreground">{reservation.occasion}</p>}
          {canOpenReservation && <div className="mt-1 flex justify-end">{openButton(reservation.id)}</div>}
        </article>)}
        {section === 'payments' && (data.rows as CrmRelationshipPayment[]).map((payment) => <article key={payment.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold tabular-nums">{payment.charged_amount !== null || payment.base_amount !== null ? money.format(payment.charged_amount ?? payment.base_amount!) : 'Valor não informado'}</p><Badge variant="secondary">{getPaymentStatusLabel(payment.status as ReservationPaymentStatus) ?? 'Estado indisponível'}</Badge></div>
          <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"><CalendarDays aria-hidden="true" className="h-3 w-3" />Reserva de {formatDate(payment.reservation_date)} às {payment.reservation_time.slice(0, 5)}{payment.billing_type && ` · ${payment.billing_type === 'PIX' ? 'Pix' : payment.billing_type === 'CREDIT_CARD' ? 'Cartão' : payment.billing_type}`}</p>
          {payment.paid_at && <p className="mt-1 text-xs text-muted-foreground">Pago em {formatTimestamp(payment.paid_at)}</p>}
          {payment.refunded_at && <p className="mt-1 text-xs text-muted-foreground">Estorno registrado em {formatTimestamp(payment.refunded_at)}</p>}
          {canOpenReservation && <div className="mt-1 flex justify-end">{openButton(payment.reservation_id)}</div>}
        </article>)}
        {section === 'messages' && (data.rows as CrmRelationshipMessage[]).map((message) => <article key={message.id} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2"><p className="font-medium">{WHATSAPP_MESSAGE_TYPE_LABELS[message.type] ?? 'Mensagem da plataforma'}</p><Badge variant="secondary">{getCrmMessageStatusLabel(message)}</Badge></div>
          <p className="mt-1.5 text-xs text-muted-foreground">{message.channel === 'evolution' ? 'WhatsApp conectado' : 'PlugueChat Oficial'} · {formatTimestamp(message.created_at)}</p>
          {message.message_preview && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{message.message_preview}</p>}
          {message.reservation_id && canOpenReservation && <div className="mt-1 flex justify-end">{openButton(message.reservation_id)}</div>}
        </article>)}
      </div>
      {data.total > data.page_size && <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{(data.page - 1) * data.page_size + 1}–{Math.min(data.page * data.page_size, data.total)} de {data.total} {sectionLabel}</p>
        <div className="flex gap-1"><Button type="button" size="icon" variant="outline" className="h-9 w-9" disabled={data.page <= 1 || query.isFetching} onClick={() => setPage(data.page - 1)} aria-label={`Página anterior de ${sectionLabel}`}><ChevronLeft aria-hidden="true" className="h-4 w-4" /></Button><Button type="button" size="icon" variant="outline" className="h-9 w-9" disabled={data.page * data.page_size >= data.total || query.isFetching} onClick={() => setPage(data.page + 1)} aria-label={`Próxima página de ${sectionLabel}`}><ChevronRight aria-hidden="true" className="h-4 w-4" /></Button></div>
      </div>}
    </>}
  </div>;
}
