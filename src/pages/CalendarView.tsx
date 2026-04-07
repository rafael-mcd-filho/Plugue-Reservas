import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

type ReservationStatus = 'confirmed' | 'checked_in' | 'cancelled' | 'completed' | 'no-show';

interface ReservationRow {
  id: string;
  table_id: string | null;
  table_map_id: string | null;
  guest_name: string;
  date: string;
  time: string;
  party_size: number;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
}

interface TableRow {
  id: string;
  number: number;
  table_map_id: string | null;
}

export default function CalendarView() {
  const { companyId } = useCompanySlug();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  const { data: reservations = [], isLoading: reservationsLoading } = useQuery({
    queryKey: ['calendar-reservations', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('id, table_id, table_map_id, guest_name, date, time, party_size, status, occasion, notes')
        .eq('company_id', companyId)
        .order('date', { ascending: true })
        .order('time', { ascending: true });

      if (error) throw error;
      return (data ?? []) as ReservationRow[];
    },
    enabled: !!companyId,
    refetchInterval: 30000,
  });

  const { data: tables = [], isLoading: tablesLoading } = useQuery({
    queryKey: ['calendar-tables', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('id, number, table_map_id')
        .eq('company_id', companyId);

      if (error) throw error;
      return (data ?? []) as TableRow[];
    },
    enabled: !!companyId,
  });

  const { data: tableMaps = [] } = useQuery({
    queryKey: ['calendar-table-maps', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('table_maps' as any)
        .select('id, name')
        .eq('company_id', companyId);

      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
    enabled: !!companyId,
  });

  const isLoading = reservationsLoading || tablesLoading;
  const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';
  const dayReservations = useMemo(
    () => reservations
      .filter((reservation) => reservation.date === selectedDateStr)
      .sort((a, b) => a.time.localeCompare(b.time)),
    [reservations, selectedDateStr],
  );
  const reservationDates = useMemo(
    () => new Set(reservations.map((reservation) => reservation.date)),
    [reservations],
  );
  const tableMapNameMap = useMemo(
    () => new Map(tableMaps.map((tableMap) => [tableMap.id, tableMap.name])),
    [tableMaps],
  );
  const tableMap = useMemo(
    () => new Map(tables.map((table) => {
      const mapName = table.table_map_id ? tableMapNameMap.get(table.table_map_id) : null;
      return [table.id, mapName ? `${table.number} · ${mapName}` : String(table.number)] as const;
    })),
    [tableMapNameMap, tables],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <div className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
          <div className="mt-2 h-5 w-56 animate-pulse rounded bg-muted" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <Card className="w-fit border-none shadow-sm">
            <CardContent className="pt-6">
              <div className="h-[330px] w-[310px] animate-pulse rounded-md bg-muted" />
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <div className="h-7 w-72 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Calendário</h1>
        <p className="mt-1 text-muted-foreground">Visualize reservas por data</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <Card className="w-fit border-none shadow-sm">
          <CardContent className="pt-6">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              className={cn('p-3 pointer-events-auto')}
              modifiers={{ hasReservation: (date) => reservationDates.has(format(date, 'yyyy-MM-dd')) }}
              modifiersClassNames={{ hasReservation: 'bg-primary/15 font-bold text-primary' }}
            />
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">
              {selectedDate
                ? `Reservas em ${format(selectedDate, "EEEE, dd 'de' MMMM", { locale: ptBR })}`
                : 'Selecione uma data'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dayReservations.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma reserva nesta data</p>
            ) : (
              <div className="space-y-3">
                {dayReservations.map((reservation) => {
                  const detail = reservation.occasion || reservation.notes;

                  return (
                    <div
                      key={reservation.id}
                      className="flex items-center gap-4 rounded-lg bg-muted/50 p-4 transition-colors hover:bg-muted"
                    >
                      <div className="w-14 text-center text-lg font-bold text-primary">
                        {reservation.time.slice(0, 5)}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{reservation.guest_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {reservation.party_size} pessoas
                          {reservation.table_id && <> · Mesa {tableMap.get(reservation.table_id) ?? '?'}</>}
                          {detail && <> · {detail}</>}
                        </div>
                      </div>

                      <ReservationStatusBadge status={reservation.status} />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
