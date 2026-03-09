import { useState } from 'react';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useReservations } from '@/contexts/ReservationContext';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { cn } from '@/lib/utils';

export default function CalendarView() {
  const { reservations, getTableById } = useReservations();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  const selectedDateStr = selectedDate?.toISOString().split('T')[0] ?? '';
  const dayReservations = reservations
    .filter(r => r.date === selectedDateStr)
    .sort((a, b) => a.time.localeCompare(b.time));

  // Dates that have reservations
  const reservationDates = new Set(reservations.map(r => r.date));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Calendário</h1>
        <p className="text-muted-foreground mt-1">Visualize reservas por data</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        <Card className="border-none shadow-sm w-fit">
          <CardContent className="pt-6">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              className={cn("p-3 pointer-events-auto")}
              modifiers={{ hasReservation: (date) => reservationDates.has(date.toISOString().split('T')[0]) }}
              modifiersClassNames={{ hasReservation: 'bg-primary/15 font-bold text-primary' }}
            />
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">
              {selectedDate ? (
                <>Reservas em {selectedDate.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</>
              ) : 'Selecione uma data'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dayReservations.length === 0 ? (
              <p className="text-muted-foreground text-sm py-8 text-center">Nenhuma reserva nesta data</p>
            ) : (
              <div className="space-y-3">
                {dayReservations.map(r => {
                  const table = getTableById(r.tableId);
                  return (
                    <div key={r.id} className="flex items-center gap-4 p-4 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                      <div className="text-lg font-bold text-primary w-14 text-center">{r.time}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{r.guestName}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.partySize} pessoas · Mesa {table?.number ?? '?'}
                          {r.notes && <> · {r.notes}</>}
                        </div>
                      </div>
                      <ReservationStatusBadge status={r.status} />
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
