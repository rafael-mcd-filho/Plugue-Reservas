import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Armchair, Ban, CalendarCheck, CheckCircle2, Clock3, Info, Loader2, Search, Users, type LucideIcon } from 'lucide-react';
import type { CalendarSlotAvailabilitySlot } from '@/components/CalendarSlotAvailability';
import type { ManualReservationPreset } from '@/components/ManualReservationDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import {
  buildSlotTableAvailability,
  getSlotBookingState,
  getTableSuggestedPartySize,
  normalizeSlotTableOptions,
  type SlotTableOption,
  type SlotTableOptionRow,
} from '@/lib/calendar-slot-availability';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';

export interface CalendarMapReservation {
  id: string;
  guest_name: string;
  status: string;
  party_size: number;
  checked_in_party_size: number | null;
  timeRange: string;
}

export interface CalendarTableMapProps {
  companyId: string;
  date: string;
  slot: CalendarSlotAvailabilitySlot;
  mapName: string | null;
  canCreateReservation: boolean;
  reservations: CalendarMapReservation[];
  onReserve: (preset: ManualReservationPreset) => void;
  onOpenReservation: (reservationId: string) => void;
}

type TableState = 'free' | 'reserved' | 'checked_in' | 'unavailable';
const labels: Record<TableState, string> = {
  free: 'Livre na faixa',
  reserved: 'Reserva na faixa',
  checked_in: 'Com check-in',
  unavailable: 'Indisponível',
};
const presentation: Record<TableState, { icon: LucideIcon; card: string; badge: string; symbol: string }> = {
  free: {
    icon: Armchair,
    card: 'border-success/20 border-l-success bg-success-soft/40 hover:border-success/40 hover:border-l-success',
    badge: 'border-success/15 bg-success-soft text-success',
    symbol: 'bg-success-soft text-success',
  },
  reserved: {
    icon: CalendarCheck,
    card: 'border-amber-200/80 border-l-amber-500 bg-amber-50/60 hover:border-amber-300 hover:border-l-amber-500',
    badge: 'border-amber-200 bg-amber-100/80 text-amber-900',
    symbol: 'bg-amber-100 text-amber-900',
  },
  checked_in: {
    icon: CheckCircle2,
    card: 'border-info/20 border-l-info bg-info-soft/45 hover:border-info/40 hover:border-l-info',
    badge: 'border-info/15 bg-info-soft text-info',
    symbol: 'bg-info text-info-foreground',
  },
  unavailable: {
    icon: Ban,
    card: 'border-border border-l-muted-foreground/50 bg-muted/30',
    badge: 'border-border bg-muted text-muted-foreground',
    symbol: 'bg-muted text-muted-foreground',
  },
};

function getTableState(option: SlotTableOption, reservation: CalendarMapReservation | undefined): TableState {
  if (option.available) return 'free';
  if (!option.conflictReservationId) return 'unavailable';
  return reservation && normalizeReservationStatus(reservation.status) === 'checked_in' ? 'checked_in' : 'reserved';
}

const searchable = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();

export default function CalendarTableMap({ companyId, date, slot, mapName, canCreateReservation, reservations, onReserve, onOpenReservation }: CalendarTableMapProps) {
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | Exclude<TableState, 'unavailable'>>('all');
  const booking = getSlotBookingState(slot);
  const remainingCapacity = slot.capacityLimit != null ? slot.remainingCapacity : null;
  const tablesQuery = useQuery({
    queryKey: ['calendar-slot-tables', companyId, date, slot.time],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_reservation_table_options', {
        _company_id: companyId,
        _date: date,
        _time: `${slot.time}:00`,
        _party_size: 1,
        _duration_minutes: null,
        _reservation_id: null,
      });
      if (error) throw error;
      return normalizeSlotTableOptions((data as SlotTableOptionRow[]) ?? []);
    },
    enabled: !!companyId && !!date,
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
    retry: false,
  });
  const reservationsById = useMemo(() => new Map(reservations.map(reservation => [reservation.id, reservation])), [reservations]);
  const availability = useMemo(() => buildSlotTableAvailability(tablesQuery.data ?? [], { showOccupied: true, minSeats: 0 }), [tablesQuery.data]);
  const sections = useMemo(() => {
    const term = searchable(search);
    return availability.sections.map(section => ({
      ...section,
      tables: section.tables.filter(option => {
        const reservation = option.conflictReservationId ? reservationsById.get(option.conflictReservationId) : undefined;
        const state = getTableState(option, reservation);
        return (stateFilter === 'all' || state === stateFilter)
          && (!term || searchable(`Mesa ${option.tableNumber} ${section.label} ${option.available ? '' : reservation?.guest_name ?? option.conflictGuestName ?? ''}`).includes(term));
      }).sort((left, right) => left.tableNumber - right.tableNumber),
    })).filter(section => section.tables.length > 0);
  }, [availability.sections, reservationsById, search, stateFilter]);

  const reserveTable = (option: SlotTableOption) => onReserve({
    date,
    time: slot.time,
    partySize: getTableSuggestedPartySize(option.capacity, 0, booking.maxPartySize),
    remainingCapacity,
    table: { id: option.tableId, number: option.tableNumber, sectionName: option.sectionName, capacity: option.capacity },
  });

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold">Mapa de mesas</h2>
        <p className="mt-1 text-xs text-muted-foreground">{mapName ?? 'Mapa ativo'} · {date.split('-').reverse().join('/')} às {slot.time}</p>
        {tablesQuery.isSuccess && <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium text-foreground">{availability.freeCount} de {availability.totalCount}</span> mesas livres na faixa</p>}
      </div>
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="group" aria-label="Filtrar situação das mesas">
        {(['all', 'checked_in', 'free', 'reserved'] as const).map(state => {
          const Icon = state === 'all' ? null : presentation[state].icon;
          return <Button key={state} type="button" size="sm" variant={stateFilter === state ? 'secondary' : 'ghost'} className="h-8 shrink-0 gap-1.5 text-xs" aria-pressed={stateFilter === state} onClick={() => setStateFilter(state)}>
            {Icon && <Icon aria-hidden="true" className={cn('h-3.5 w-3.5', state === 'checked_in' ? 'text-info' : state === 'free' ? 'text-success' : 'text-amber-800')} />}
            {state === 'all' ? 'Todas' : state === 'checked_in' ? 'Com check-in' : state === 'free' ? 'Livres' : 'Reservadas'}
          </Button>;
        })}
      </div>
    </div>
    <div className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar cliente ou mesa" aria-label="Buscar cliente ou mesa no mapa" className="pl-9" />
    </div>
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>A disponibilidade considera a duração da reserva nesta faixa e os conflitos da agenda. O check-in identifica a reserva vinculada à mesa. Atualização a cada 30 segundos.</p>
    </div>
    {booking.blockedReason && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{booking.blockedReason}</span></div>}
    {tablesQuery.isLoading ? <div role="status" className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />Carregando mesas…</div>
      : tablesQuery.isError ? <div role="alert" className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 px-4 py-6 text-center"><p className="text-sm font-medium">Não foi possível carregar o mapa desta faixa.</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void tablesQuery.refetch()}>Tentar novamente</Button></div>
        : availability.totalCount === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhuma mesa ativa no mapa desta faixa.</p>
          : sections.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhuma mesa encontrada para estes filtros.</p>
            : sections.map(section => <section key={section.key} className="space-y-2" aria-label={section.label}>
              <h3 className="text-sm font-medium">{section.label}<span className="ml-2 text-xs font-normal text-muted-foreground">{section.tables.length} {section.tables.length === 1 ? 'mesa' : 'mesas'}</span></h3>
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 2xl:grid-cols-4">
                {section.tables.map(option => {
                  const reservation = !option.available && option.conflictReservationId ? reservationsById.get(option.conflictReservationId) : undefined;
                  const state = getTableState(option, reservation);
                  const { icon: Icon, card, badge, symbol } = presentation[state];
                  const canReserve = canCreateReservation && slot.availabilityMode === 'tables' && option.available && !booking.blockedReason && getTableSuggestedPartySize(option.capacity, 0, booking.maxPartySize) > 0;
                  const canOpen = !option.available && !!reservation;
                  const guestName = !option.available && option.conflictReservationId ? reservation?.guest_name ?? option.conflictGuestName : null;
                  return <button key={option.tableId} type="button" aria-label={`Mesa ${option.tableNumber}, ${labels[state]}`} disabled={!canReserve && !canOpen} onClick={() => { if (canReserve) reserveTable(option); else if (canOpen && reservation) onOpenReservation(reservation.id); }} className={cn('flex min-w-0 flex-col rounded-lg border border-l-[3px] p-2.5 text-left transition-[background-color,border-color,box-shadow] duration-150 enabled:hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default motion-reduce:transition-none', card)}>
                    <div className="mb-1.5 flex w-full items-center justify-between gap-1.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold sm:text-sm"><span className={cn('hidden h-6 w-6 shrink-0 items-center justify-center rounded-md min-[375px]:flex', symbol)}><Armchair aria-hidden="true" className="h-3.5 w-3.5" /></span><span className="whitespace-nowrap">Mesa {option.tableNumber}</span></span>
                      <span className="flex shrink-0 items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground" title={`Capacidade da mesa: ${option.capacity} pessoas`}><Users aria-hidden="true" className="h-3 w-3" />{option.capacity}</span>
                    </div>
                    <Badge variant="secondary" className={cn('max-w-full self-start gap-1 px-1.5 py-0.5 text-[11px] font-medium leading-snug', badge)}><Icon aria-hidden="true" className="h-3 w-3 shrink-0" />{labels[state]}</Badge>
                    {(guestName || reservation) && <div className="my-2 space-y-1">
                      {guestName && <p className="break-words text-xs font-medium sm:text-sm">{guestName}</p>}
                      {reservation && <>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground"><Users aria-hidden="true" className="h-3 w-3 shrink-0" />{state === 'checked_in' ? reservation.checked_in_party_size ?? reservation.party_size : reservation.party_size} pessoas</p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 aria-hidden="true" className="h-3 w-3 shrink-0" />{reservation.timeRange}</p>
                      </>}
                    </div>}
                    <span className="mt-auto w-full border-t border-foreground/10 pt-2 text-xs text-muted-foreground">{canReserve ? 'Reservar esta mesa' : canOpen ? 'Ver reserva' : option.available ? 'Livre na agenda' : state === 'unavailable' ? 'Disponibilidade não confirmada' : 'Reserva vinculada à mesa'}</span>
                  </button>;
                })}
              </div>
            </section>)}
  </div>;
}
