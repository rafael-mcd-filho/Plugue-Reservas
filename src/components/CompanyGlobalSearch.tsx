import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { AlertCircle, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Loader2, Search, UserRound } from 'lucide-react';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
import LeadProfileDialog from '@/components/leads/LeadProfileDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { useImpersonation } from '@/hooks/useImpersonation';
import type { CrmLeadRow } from '@/hooks/useCrmLeads';
import { supabase } from '@/integrations/supabase/client';
import { COMPANY_GLOBAL_SEARCH_MAX_LENGTH, isCompanyGlobalSearchQueryReady, normalizeCompanyGlobalSearchQuery, searchCompanyGlobal } from '@/lib/company-global-search';
import { mapCrmLeadRowToProfile } from '@/lib/crm-lead-profile';
import { formatPhone } from '@/lib/phone';
import { getReservationStatusLabel } from '@/lib/reservation-status';

interface CompanyGlobalSearchProps {
  companyId: string;
  companyName: string;
  slug: string;
}

type Selection = { kind: 'reservation'; id: string } | { kind: 'customer'; row: CrmLeadRow };

/** The keyed scope unmounts queries, dialogs and search text when access changes. */
export default function CompanyGlobalSearch(props: CompanyGlobalSearchProps) {
  const { user } = useAuth();
  const { impersonatedUserId } = useImpersonation();
  const permissions = useCompanyPermissions();
  const ready = !!user && !!props.companyId && permissions.activeCompanyId === props.companyId
    && !permissions.permissionsLoading && !permissions.permissionsError;
  const canViewReservations = ready && permissions.hasPermission('reservations_view');
  const canViewCustomers = ready && permissions.hasPermission('leads_view');
  const showEventHistory = ready && permissions.hasPermission('events_view');
  if (!canViewReservations && !canViewCustomers) return null;
  const accessScope = [user!.id, impersonatedUserId ?? '', props.companyId, canViewReservations, canViewCustomers, showEventHistory].join(':');
  return <ScopedCompanyGlobalSearch key={accessScope} {...props} accessScope={accessScope}
    canViewReservations={canViewReservations} canViewCustomers={canViewCustomers} showEventHistory={showEventHistory} />;
}

function SearchPagination({ label, page, hasMore, disabled, onPageChange }: {
  label: 'reservas' | 'clientes'; page: number; hasMore: boolean; disabled: boolean; onPageChange: (page: number) => void;
}) {
  if (page === 1 && !hasMore) return null;
  return <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1">
    <span className="text-xs text-muted-foreground">Página {page}{hasMore ? ' · há mais resultados' : ''}</span>
    <div className="flex gap-1">
      <Button type="button" size="icon" variant="ghost" className="h-9 w-9" disabled={disabled || page === 1}
        aria-label={`Página anterior de ${label}`} onClick={() => onPageChange(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
      <Button type="button" size="icon" variant="ghost" className="h-9 w-9" disabled={disabled || !hasMore}
        aria-label={`Próxima página de ${label}`} onClick={() => onPageChange(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
    </div>
  </div>;
}

function SearchSectionError({ label, onRetry, retrying }: { label: string; onRetry: () => void; retrying: boolean }) {
  return <div role="alert" className="mx-2 mb-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
    <p className="text-sm">Não foi possível buscar {label}.</p>
    <Button type="button" variant="outline" size="sm" className="mt-2" disabled={retrying} onClick={onRetry}>Tentar novamente</Button>
  </div>;
}

function ScopedCompanyGlobalSearch({ companyId, companyName, slug, accessScope, canViewReservations, canViewCustomers, showEventHistory }: CompanyGlobalSearchProps & {
  accessScope: string; canViewReservations: boolean; canViewCustomers: boolean; showEventHistory: boolean;
}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [debouncedText, setDebouncedText] = useState('');
  const [reservationsPage, setReservationsPage] = useState(1);
  const [customersPage, setCustomersPage] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [commandValue, setCommandValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const query = normalizeCompanyGlobalSearchQuery(text);
  const validQuery = isCompanyGlobalSearchQueryReady(query);
  const waiting = validQuery && query !== debouncedText;
  const queryKey = useMemo(() => ['company-global-search', accessScope, debouncedText, reservationsPage, customersPage],
    [accessScope, debouncedText, reservationsPage, customersPage]);
  const canSearch = open && validQuery && !waiting;

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setText(''); setDebouncedText(''); setSelection(null); setCommandValue('');
      setReservationsPage(1); setCustomersPage(1);
    }
  };
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedText(query), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(() => { changeOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (selection || (!open && document.querySelector('[role="dialog"], [role="alertdialog"]'))) return;
      event.preventDefault();
      setOpen(true);
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, selection]);

  const results = useQuery({
    queryKey,
    queryFn: ({ signal }) => searchCompanyGlobal({ companyId, query: debouncedText, canViewReservations, canViewCustomers,
      reservationsPage, customersPage, signal }),
    enabled: canSearch,
    staleTime: 15_000,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!canSearch) return;
    return () => { void queryClient.cancelQueries({ queryKey, exact: true }); };
  }, [canSearch, queryClient, queryKey]);

  const reservationId = selection?.kind === 'reservation' ? selection.id : null;
  const detail = useQuery({
    queryKey: ['company-global-search-detail', accessScope, reservationId],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.from('reservations').select('*')
        .eq('company_id', companyId).eq('id', reservationId!).abortSignal(signal).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Reserva indisponível.');
      return data as unknown as ReservationDetails;
    },
    enabled: open && canViewReservations && !!reservationId,
    retry: false,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const backToSearch = () => {
    setSelection(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };
  const data = canSearch ? results.data : undefined;
  const busy = waiting || (canSearch && results.isPending);
  const retry = () => { void results.refetch(); };

  return <>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Buscar clientes e reservas" title="Buscar na unidade (Ctrl ou ⌘ K)"
          className="h-9 w-9 shrink-0 gap-2 px-2.5 sm:w-full sm:min-w-44 sm:justify-start sm:text-muted-foreground">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="hidden truncate sm:inline">Buscar por nome, telefone ou código</span>
          <kbd className="ml-auto hidden rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] lg:inline">Ctrl K</kbd>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onCloseAutoFocus={event => { if (selection) event.preventDefault(); }}>
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 pr-14 text-left">
          <DialogTitle>Buscar na unidade</DialogTitle>
          <DialogDescription className="truncate" title={companyName}>{companyName}</DialogDescription>
        </DialogHeader>
        <Command label="Nome, telefone ou código" shouldFilter={false} value={commandValue} onValueChange={setCommandValue} className="min-h-0 rounded-none">
          <CommandInput ref={inputRef} aria-label="Nome, telefone ou código" placeholder="Nome, telefone ou código da reserva"
            value={text} maxLength={COMPANY_GLOBAL_SEARCH_MAX_LENGTH} className="h-12 text-base sm:text-sm" onValueChange={next => {
              setText(next); setReservationsPage(1); setCustomersPage(1); setCommandValue('');
            }} />
          <CommandList className="max-h-[min(55dvh,440px)] min-h-0 overscroll-contain p-2" aria-busy={busy || results.isFetching}>
            {!validQuery ? <div className="px-4 py-9 text-center">
              <div className="mb-3 flex justify-center gap-2 text-primary" aria-hidden="true">
                {canViewCustomers && <UserRound className="h-5 w-5" />}{canViewReservations && <CalendarDays className="h-5 w-5" />}
              </div>
              <p className="text-sm font-medium">Encontre {canViewCustomers && canViewReservations ? 'clientes e reservas' : canViewCustomers ? 'clientes' : 'reservas'}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Digite pelo menos 3 caracteres para começar.</p>
            </div> : busy ? <div role="status" className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Buscando na unidade…
            </div> : results.isError ? <SearchSectionError label="na unidade" retrying={results.isFetching} onRetry={retry} /> : data && <>
              {canViewReservations && <CommandGroup heading="Reservas">
                {data.reservations.error ? <SearchSectionError label="reservas" retrying={results.isFetching} onRetry={retry} />
                  : data.reservations.items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">Nenhuma reserva encontrada.</p>
                    : data.reservations.items.map(reservation => <CommandItem key={reservation.id} value={`reservation:${reservation.id}`}
                      className="cursor-pointer items-start gap-3 rounded-lg p-3" onSelect={() => setSelection({ kind: 'reservation', id: reservation.id })}>
                      <span className="mt-0.5 rounded-lg border border-border bg-background p-2 text-primary"><CalendarDays className="h-4 w-4" aria-hidden="true" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><span className="break-words text-sm font-semibold">{reservation.guest_name || 'Reserva sem nome'}</span>
                          <Badge variant="outline" className="text-[10px]">{getReservationStatusLabel(reservation.status)}</Badge></span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{reservation.date.split('-').reverse().join('/')} às {reservation.time.slice(0, 5)} · {reservation.party_size} {reservation.party_size === 1 ? 'pessoa' : 'pessoas'}</span>
                        <span className="mt-0.5 block break-words text-xs text-muted-foreground">{formatPhone(reservation.guest_phone_e164 || reservation.guest_phone)}{reservation.public_tracking_code && ` · ${reservation.public_tracking_code}`}</span>
                      </span><ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </CommandItem>)}
                {!data.reservations.error && <SearchPagination label="reservas" page={data.reservations.page} hasMore={data.reservations.hasMore}
                  disabled={results.isFetching} onPageChange={setReservationsPage} />}
              </CommandGroup>}
              {canViewCustomers && <CommandGroup heading="Clientes">
                {data.customers.error ? <SearchSectionError label="clientes" retrying={results.isFetching} onRetry={retry} />
                  : data.customers.items.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">Nenhum cliente encontrado.</p>
                    : data.customers.items.map(customer => <CommandItem key={customer.customer_key} value={`customer:${customer.customer_key}`}
                      className="cursor-pointer items-start gap-3 rounded-lg p-3" onSelect={() => setSelection({ kind: 'customer', row: customer })}>
                      <span className="mt-0.5 rounded-lg border border-border bg-background p-2 text-primary"><UserRound className="h-4 w-4" aria-hidden="true" /></span>
                      <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{customer.latest_name || 'Cliente sem nome'}</span>
                        <span className="mt-1 block break-words text-xs text-muted-foreground">{formatPhone(customer.phone_e164 || customer.display_phone || (customer.phone_normalized ? `+${customer.phone_normalized}` : '')) || 'Telefone não informado'}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{customer.canonical_visit_count} {customer.canonical_visit_count === 1 ? 'visita registrada' : 'visitas registradas'}</span>
                      </span><ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </CommandItem>)}
                {!data.customers.error && <SearchPagination label="clientes" page={data.customers.page} hasMore={data.customers.hasMore}
                  disabled={results.isFetching} onPageChange={setCustomersPage} />}
              </CommandGroup>}
            </>}
          </CommandList>
        </Command>
        <p className="shrink-0 border-t border-border bg-muted/20 px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
          Resultados desta unidade. Use ↑ ↓ e Enter para abrir; Esc para fechar.
        </p>
      </DialogContent>
      {open && selection?.kind === 'reservation' && canViewReservations && <>
        <ReservationDetailsDialog open={!detail.isError} onOpenChange={next => { if (!next) backToSearch(); }} reservation={detail.data ?? null}
          companyId={companyId} slug={slug} loading={detail.isPending} onBackToList={backToSearch} backLabel="Voltar à busca"
          showEventHistory={showEventHistory} showLeadHistory={canViewCustomers} readOnly
          onReservationSelect={reservation => setSelection({ kind: 'reservation', id: reservation.id })} />
        <Dialog open={detail.isError} onOpenChange={next => { if (!next) backToSearch(); }}>
          <DialogContent><DialogHeader><DialogTitle>Reserva indisponível</DialogTitle><DialogDescription>Não foi possível carregar esta reserva. Sua busca foi preservada.</DialogDescription></DialogHeader>
            <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={backToSearch}>Voltar à busca</Button><Button onClick={() => detail.refetch()}><AlertCircle className="mr-2 h-4 w-4" />Tentar novamente</Button></div>
          </DialogContent>
        </Dialog>
      </>}
      {open && selection?.kind === 'customer' && canViewCustomers && <LeadProfileDialog open onOpenChange={next => { if (!next) backToSearch(); }}
        lead={mapCrmLeadRowToProfile(selection.row)} companyId={companyId} slug={slug} readOnly
        canViewReservations={canViewReservations} showEventHistory={showEventHistory} />}
    </Dialog>
  </>;
}
