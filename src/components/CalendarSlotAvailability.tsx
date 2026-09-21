import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ManualReservationPreset } from '@/components/ManualReservationDialog';
import { supabase } from '@/integrations/supabase/client';
import {
  buildSlotTableAvailability,
  CAPACITY_QUICK_PARTY_SIZES,
  getSlotBookingState,
  getTableMaxPartySize,
  getTableSuggestedPartySize,
  MANUAL_RESERVATION_MAX_PARTY_SIZE,
  normalizeSlotTableOptions,
  type SlotBookingState,
  type SlotTableOption,
  type SlotTableOptionRow,
} from '@/lib/calendar-slot-availability';
import { cn } from '@/lib/utils';

const MIN_SEATS_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20];

export interface CalendarSlotAvailabilitySlot {
  /** HH:MM */
  time: string;
  availabilityMode: 'tables' | 'capacity';
  capacityLimit: number | null;
  remainingCapacity: number | null;
  reservationLimit: number | null;
  arrivalReservationCount: number;
}

interface CalendarSlotAvailabilityProps {
  companyId: string;
  /** yyyy-MM-dd */
  date: string;
  slot: CalendarSlotAvailabilitySlot;
  showOccupied: boolean;
  onShowOccupiedChange: (value: boolean) => void;
  minSeats: number;
  onMinSeatsChange: (value: number) => void;
  /** Reservas da faixa que podem ser abertas, com o horario "HH:MM–HH:MM". */
  reservationTimeRanges: Record<string, string>;
  onReserve: (preset: ManualReservationPreset) => void;
  onOpenReservation: (reservationId: string) => void;
}

function formatPeople(count: number) {
  return `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`;
}

function getSlotRemainingCapacity(slot: CalendarSlotAvailabilitySlot) {
  return slot.capacityLimit != null ? slot.remainingCapacity : null;
}

function BookingBlockedNotice({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{reason}</span>
    </div>
  );
}

function AvailabilityStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function CapacitySlotAvailability({
  date,
  slot,
  booking,
  onReserve,
}: {
  date: string;
  slot: CalendarSlotAvailabilitySlot;
  booking: SlotBookingState;
  onReserve: (preset: ManualReservationPreset) => void;
}) {
  const remainingCapacity = getSlotRemainingCapacity(slot);
  const reserve = (partySize: number) => onReserve({
    date,
    time: slot.time,
    partySize,
    remainingCapacity,
  });

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
        <AvailabilityStat
          label="Vagas de pessoas"
          value={slot.capacityLimit != null ? `${remainingCapacity ?? 0} de ${slot.capacityLimit}` : '--'}
        />
        {slot.reservationLimit != null && (
          <AvailabilityStat
            label="Reservas"
            value={`${slot.arrivalReservationCount} de ${slot.reservationLimit}`}
          />
        )}
        <AvailabilityStat
          label="Maior grupo que cabe"
          value={booking.blockedReason ? '--' : formatPeople(booking.maxPartySize)}
        />
      </div>

      {booking.blockedReason && <BookingBlockedNotice reason={booking.blockedReason} />}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Reservar para</span>
        {CAPACITY_QUICK_PARTY_SIZES.map((size) => (
          <Button
            key={size}
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={!!booking.blockedReason || size > booking.maxPartySize}
            onClick={() => reserve(size)}
          >
            {size} pessoas
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs"
          disabled={!!booking.blockedReason}
          onClick={() => reserve(Math.max(Math.min(2, booking.maxPartySize), 1))}
        >
          Outro…
          {!booking.blockedReason && booking.maxPartySize < MANUAL_RESERVATION_MAX_PARTY_SIZE
            ? ` (até ${booking.maxPartySize})`
            : ''}
        </Button>
      </div>
    </div>
  );
}

function TableAvailabilityRow({
  option,
  booking,
  occupiedTimeRange,
  onReserveTable,
  onOpenReservation,
}: {
  option: SlotTableOption;
  booking: SlotBookingState;
  occupiedTimeRange: string | undefined;
  onReserveTable: (option: SlotTableOption) => void;
  onOpenReservation: (reservationId: string) => void;
}) {
  const canReserve = option.available
    && !booking.blockedReason
    && getTableMaxPartySize(option.capacity, booking.maxPartySize) > 0;
  const canOpenReservation = !option.available
    && !!option.conflictReservationId
    && occupiedTimeRange !== undefined;
  const freeSeats = option.available ? option.capacity : 0;
  const seatsLabel = `${freeSeats}/${option.capacity} vagas`;
  const statusLabel = option.available
    ? 'Livre'
    : ['Ocupada', option.conflictGuestName, occupiedTimeRange].filter(Boolean).join(' · ');

  return (
    <li>
      <button
        type="button"
        disabled={!canReserve && !canOpenReservation}
        onClick={() => {
          if (canReserve) {
            onReserveTable(option);
          } else if (canOpenReservation && option.conflictReservationId) {
            onOpenReservation(option.conflictReservationId);
          }
        }}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[5.5rem_6.5rem_minmax(0,1fr)] sm:items-center sm:gap-3">
          <p className={cn('text-sm font-semibold', option.available ? 'text-foreground' : 'text-muted-foreground')}>
            Mesa {option.tableNumber}
            <span className="font-normal text-muted-foreground sm:hidden"> · {seatsLabel}</span>
          </p>
          <p className={cn('hidden text-sm tabular-nums sm:block', option.available ? 'text-foreground' : 'text-muted-foreground')}>
            {seatsLabel}
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:mt-0">
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', option.available ? 'bg-emerald-500' : 'bg-slate-300')}
              aria-hidden="true"
            />
            <span className="truncate">{statusLabel}</span>
          </p>
        </div>
        {canReserve ? (
          <span className="shrink-0 rounded-md border border-primary/30 bg-primary/[0.06] px-2.5 py-1 text-xs font-semibold text-primary">
            Reservar
          </span>
        ) : canOpenReservation ? (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Ver reserva ›</span>
        ) : null}
      </button>
    </li>
  );
}

function TableSlotAvailability({
  companyId,
  date,
  slot,
  booking,
  showOccupied,
  onShowOccupiedChange,
  minSeats,
  onMinSeatsChange,
  reservationTimeRanges,
  onReserve,
  onOpenReservation,
}: Omit<CalendarSlotAvailabilityProps, 'slot'> & {
  slot: CalendarSlotAvailabilitySlot;
  booking: SlotBookingState;
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const remainingCapacity = getSlotRemainingCapacity(slot);

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
  });

  const availability = useMemo(
    () => buildSlotTableAvailability(tablesQuery.data ?? [], { showOccupied, minSeats }),
    [tablesQuery.data, showOccupied, minSeats],
  );
  const showSectionHeaders = availability.sections.length > 1;

  const toggleSection = (key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const reserveTable = (option: SlotTableOption) => onReserve({
    date,
    time: slot.time,
    partySize: getTableSuggestedPartySize(option.capacity, minSeats, booking.maxPartySize),
    remainingCapacity,
    table: {
      id: option.tableId,
      number: option.tableNumber,
      sectionName: option.sectionName,
      capacity: option.capacity,
    },
  });

  const reserveWithAutomaticTable = () => onReserve({
    date,
    time: slot.time,
    partySize: Math.max(Math.min(minSeats > 0 ? minSeats : 2, booking.maxPartySize), 1),
    remainingCapacity,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {tablesQuery.isSuccess ? (
            <>
              <span className="font-semibold tabular-nums text-foreground">{availability.freeCount}</span>
              {` de ${availability.totalCount} mesas livres · `}
              <span className="font-semibold tabular-nums text-foreground">{availability.freeSeats}</span>
              {' lugares em mesa'}
            </>
          ) : 'Mesas deste horário'}
          {remainingCapacity != null && (
            <>
              {' · '}
              <span className="font-semibold tabular-nums text-foreground">{remainingCapacity}</span>
              {' vagas no limite da faixa'}
            </>
          )}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!!booking.blockedReason}
          title="O sistema escolhe a menor mesa livre que comporta o grupo. Sem mesa livre, a reserva fica para alocar depois."
          onClick={reserveWithAutomaticTable}
        >
          Reservar com mesa automática
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md bg-muted p-0.5 text-xs font-semibold" role="group" aria-label="Mesas exibidas">
          {([false, true] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={showOccupied === value}
              onClick={() => onShowOccupiedChange(value)}
              className={cn(
                'h-7 rounded px-3 transition',
                showOccupied === value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value ? 'Todas' : 'Livres'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Cabe</span>
          <Select value={String(minSeats)} onValueChange={(value) => onMinSeatsChange(Number(value) || 0)}>
            <SelectTrigger className="h-7 w-[7.5rem] text-xs" aria-label="Filtrar mesas pela quantidade de pessoas">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Qualquer</SelectItem>
              {MIN_SEATS_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>{size} pessoas</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {booking.blockedReason && <BookingBlockedNotice reason={booking.blockedReason} />}

      {tablesQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-background py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando mesas...
        </div>
      ) : tablesQuery.isError ? (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 px-4 py-5 text-center">
          <p className="text-sm font-medium text-foreground">Não foi possível carregar as mesas desta faixa.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => tablesQuery.refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : availability.totalCount === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma mesa ativa no mapa deste horário.</p>
      ) : availability.sections.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {minSeats > 0
            ? `Nenhuma mesa livre para ${minSeats} pessoas nesta faixa.`
            : 'Nenhuma mesa livre nesta faixa.'}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-border bg-background">
          {availability.sections.map((section) => {
            const collapsed = showSectionHeaders && collapsedSections.has(section.key);

            return (
              <div key={section.key} className="border-b border-border/70 last:border-b-0">
                {showSectionHeaders && (
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleSection(section.key)}
                    className="sticky top-0 z-[1] flex w-full items-center justify-between gap-3 border-b border-border/60 bg-muted/80 px-3 py-1.5 text-left text-xs backdrop-blur-sm"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
                      {collapsed
                        ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <span className="truncate">{section.label}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {section.freeCount} livres de {section.totalCount} · {section.freeSeats} vagas
                    </span>
                  </button>
                )}

                {!collapsed && (
                  <ul className="divide-y divide-border/60">
                    {section.tables.map((option) => (
                      <TableAvailabilityRow
                        key={option.tableId}
                        option={option}
                        booking={booking}
                        occupiedTimeRange={option.conflictReservationId
                          ? reservationTimeRanges[option.conflictReservationId]
                          : undefined}
                        onReserveTable={reserveTable}
                        onOpenReservation={onOpenReservation}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Aba "Disponibilidade" de uma faixa do calendario. No modo por mesas lista as
 * mesas do horario; no modo por capacidade a propria faixa e a unidade, entao
 * o atalho e escolher a quantidade de pessoas.
 */
export default function CalendarSlotAvailability(props: CalendarSlotAvailabilityProps) {
  const booking = getSlotBookingState(props.slot);

  if (props.slot.availabilityMode === 'capacity') {
    return (
      <CapacitySlotAvailability
        date={props.date}
        slot={props.slot}
        booking={booking}
        onReserve={props.onReserve}
      />
    );
  }

  return <TableSlotAvailability {...props} booking={booking} />;
}
