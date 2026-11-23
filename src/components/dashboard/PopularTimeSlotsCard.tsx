import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { cn } from '@/lib/utils';
import type { PopularTimeSlot } from '@/lib/popular-time-slots';

interface PopularTimeSlotsCardProps {
  slots: PopularTimeSlot[];
  className?: string;
}

export default function PopularTimeSlotsCard({ slots, className }: PopularTimeSlotsCardProps) {
  const max = slots.reduce((peak, slot) => Math.max(peak, slot.count), 0);

  return (
    <Card className={cn('flex min-w-0 flex-col border border-border shadow-sm', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1.5">
            <span>Horários mais procurados</span>
            <InfoTooltip
              content="Reservas não canceladas do período, somadas pelo horário marcado. Mostra os 8 horários com mais reservas."
              ariaLabel="Entender o gráfico Horários mais procurados"
            />
          </span>
        </CardTitle>
        <CardDescription className="mt-1">Horários com mais reservas no período selecionado.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {slots.length > 0 ? (
          <ol className="flex flex-1 flex-col justify-between gap-3" aria-label="Horários com mais reservas">
            {slots.map((slot) => (
              <li key={slot.time} className="grid grid-cols-[48px_minmax(0,1fr)_40px] items-center gap-3">
                <span className="text-sm font-semibold tabular-nums text-foreground">{slot.time}</span>
                <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${max > 0 ? Math.max((slot.count / max) * 100, 4) : 0}%` }}
                  />
                </span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  <span className="sr-only">{slot.time}: </span>
                  {slot.count.toLocaleString('pt-BR')}
                  <span className="sr-only"> {slot.count === 1 ? 'reserva' : 'reservas'}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p role="status" className="rounded-lg border border-dashed border-border bg-muted/10 px-4 py-5 text-center text-sm text-muted-foreground">
            Nenhuma reserva com horário no período.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
