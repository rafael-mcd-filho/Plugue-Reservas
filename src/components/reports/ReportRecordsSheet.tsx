import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { supabase } from '@/integrations/supabase/client';
import { getReservationStatusLabel } from '@/lib/reservation-status';
import type { ReportReservationRecord } from '@/lib/report-records';

interface ReportRecordsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  companyId: string;
  slug: string;
  scopeKey: readonly unknown[];
  loadRecords: (signal?: AbortSignal) => Promise<ReportReservationRecord[]>;
}

const PAGE_SIZE = 25;
const integer = new Intl.NumberFormat('pt-BR');
const displayDate = (date: string) => date.split('-').reverse().join('/');

export default function ReportRecordsSheet({ open, onOpenChange, title, description, companyId, slug, scopeKey, loadRecords }: ReportRecordsSheetProps) {
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const permissions = useCompanyPermissions();
  const scope = JSON.stringify([companyId, ...scopeKey]);
  const canInspect = !permissions.permissionsLoading && !permissions.permissionsError
    && permissions.activeCompanyId === companyId && permissions.hasPermission('reservations_view');
  useEffect(() => { setPage(1); setSelectedId(null); }, [open, scope]);
  const recordsQuery = useQuery({
    queryKey: ['report-records', companyId, ...scopeKey],
    queryFn: ({ signal }) => loadRecords(signal),
    enabled: open && !!companyId && canInspect,
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const detailQuery = useQuery({
    queryKey: ['report-reservation-detail', companyId, selectedId],
    queryFn: async () => {
      const { data, error } = await supabase.from('reservations').select('*').eq('company_id', companyId).eq('id', selectedId!).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Reserva indisponível.');
      return data as unknown as ReservationDetails;
    },
    enabled: open && canInspect && !!selectedId,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const records = recordsQuery.data ?? [];
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visibleRecords = records.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const closeDetails = () => {
    setSelectedId(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="shrink-0 border-b border-border p-5 pr-12 text-left">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {permissions.permissionsLoading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">Verificando acesso aos registros…</p>
            : !canInspect ? <p role="alert" className="rounded-lg border border-border p-4 text-sm">Seu acesso atual não permite consultar os detalhes das reservas desta unidade.</p>
              : recordsQuery.isPending ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando a base completa…</div>
                : recordsQuery.isError ? <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-4"><p className="text-sm">Não foi possível carregar todos os registros deste recorte.</p><Button variant="outline" onClick={() => recordsQuery.refetch()}>Tentar novamente</Button></div>
                  : <>
                    <p className="mb-3 text-xs text-muted-foreground">{integer.format(records.length)} {records.length === 1 ? 'reserva neste recorte' : 'reservas neste recorte'}. Os detalhes respeitam o acesso da unidade.</p>
                    <p className="mb-3 text-xs leading-relaxed text-muted-foreground">Os registros são consultados ao abrir. Se uma reserva foi alterada recentemente, atualize o relatório para comparar a mesma leitura.</p>
                    {records.length === 0 ? <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nenhuma reserva encontrada para este recorte.</p>
                      : <ol className="space-y-2">
                        {visibleRecords.map(record => <li key={record.id}>
                          <button type="button" className="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={event => { returnFocusRef.current = event.currentTarget; setSelectedId(record.id); }} aria-label={'Abrir reserva de ' + record.guest_name}>
                            <span className="flex flex-wrap items-start justify-between gap-2"><strong className="text-sm">{record.guest_name || 'Reserva sem nome'}</strong><Badge variant="outline" className="text-[11px]">{getReservationStatusLabel(record.status)}</Badge></span>
                            <span className="mt-1 block text-xs text-muted-foreground">{displayDate(record.date)} às {record.time.slice(0, 5)} · {record.party_size} {record.party_size === 1 ? 'pessoa' : 'pessoas'}</span>
                            {record.note && <span className="mt-1 block text-xs text-muted-foreground">{record.note}</span>}
                          </button>
                        </li>)}
                      </ol>}
                  </>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar registros</Button>
          {canInspect && !recordsQuery.isPending && !recordsQuery.isError && records.length > 0 && <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" aria-label="Página anterior dos registros" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-xs" aria-live="polite">Página {currentPage} de {pages}</span>
            <Button size="icon" variant="outline" aria-label="Próxima página dos registros" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>}
        </div>
      </SheetContent>
      {open && canInspect && selectedId && <>
        <ReservationDetailsDialog open={!detailQuery.isError} onOpenChange={next => { if (!next) closeDetails(); }} reservation={detailQuery.data ?? null} companyId={companyId} slug={slug} loading={detailQuery.isPending} onBackToList={closeDetails} backLabel="Voltar aos registros" showEventHistory={permissions.hasPermission('events_view')} showLeadHistory={permissions.hasPermission('leads_view')} readOnly />
        <Dialog open={detailQuery.isError} onOpenChange={next => { if (!next) closeDetails(); }}><DialogContent><DialogHeader><DialogTitle>Reserva indisponível</DialogTitle><DialogDescription>Não foi possível abrir os detalhes. Os filtros e a página da lista foram preservados.</DialogDescription></DialogHeader><div className="flex gap-2"><Button variant="outline" onClick={closeDetails}>Voltar aos registros</Button><Button onClick={() => detailQuery.refetch()}><AlertCircle className="mr-2 h-4 w-4" />Tentar novamente</Button></div></DialogContent></Dialog>
      </>}
    </Sheet>
  );
}
