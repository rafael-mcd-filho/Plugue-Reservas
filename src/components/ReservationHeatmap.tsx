import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface HeatmapProps {
  counts: Record<string, number>;
  breakdown: Record<string, { total: number; scheduled: number; waitlist: number }>;
  maxCount: number;
  hours: string[];
  dayNames: string[];
}

function getIntensity(count: number, max: number): string {
  if (count === 0 || max === 0) return 'bg-muted';
  const ratio = count / max;
  if (ratio > 0.75) return 'bg-info';
  if (ratio > 0.5) return 'bg-info/70';
  if (ratio > 0.25) return 'bg-info/40';
  return 'bg-info/20';
}

export default function ReservationHeatmap({ counts, breakdown, maxCount, hours, dayNames }: HeatmapProps) {
  if (hours.length === 0) {
    return (
      <Card className="border border-border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            <span className="inline-flex items-center gap-1.5">
              <span>Horários mais movimentados</span>
              <InfoTooltip
                content="Mostra os dias e horários com mais atendimentos registrados. No detalhe, você vê o que foi agendado e o que veio da fila."
                ariaLabel="Entender o gráfico Horários mais movimentados"
              />
            </span>
          </CardTitle>
          <CardDescription>Sem dados no período selecionado</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 border border-border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1.5">
            <span>Horários mais movimentados</span>
            <InfoTooltip
              content="Mostra os dias e horários com mais atendimentos registrados. No detalhe, você vê o que foi agendado e o que veio da fila."
              ariaLabel="Entender o gráfico Horários mais movimentados"
            />
          </span>
        </CardTitle>
        <CardDescription>Total por dia da semana e horário, com detalhe da origem</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TooltipProvider delayDuration={100}>
            <div className="min-w-[420px] sm:min-w-[500px]">
              <div className="mb-1 flex gap-1">
                <div className="w-9 shrink-0 sm:w-10" />
                {hours.map((hour) => (
                  <div key={hour} className="flex-1 text-center text-xs font-medium text-muted-foreground">
                    {hour}
                  </div>
                ))}
              </div>

              {dayNames.map((day, dayIdx) => (
                <div key={day} className="mb-1 flex gap-1">
                  <div className="flex w-9 shrink-0 items-center text-xs font-medium text-muted-foreground sm:w-10">
                    {day}
                  </div>
                  {hours.map((hour) => {
                    const key = `${dayIdx}_${hour}`;
                    const count = counts[key] || 0;
                    const cellBreakdown = breakdown[key] || { total: 0, scheduled: 0, waitlist: 0 };
                    return (
                      <Tooltip key={key}>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              'h-7 min-w-[24px] flex-1 cursor-default rounded-sm transition-colors sm:h-8 sm:min-w-[28px]',
                              getIntensity(count, maxCount),
                            )}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="space-y-1 text-xs">
                          <p className="font-semibold">
                            {day} {hour}
                          </p>
                          <p>Total: {cellBreakdown.total} atendimento{cellBreakdown.total !== 1 ? 's' : ''}</p>
                          <p>Agendadas: {cellBreakdown.scheduled}</p>
                          <p>Fila convertida: {cellBreakdown.waitlist}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              ))}
            </div>
          </TooltipProvider>

          <div className="mt-3 flex items-center justify-start gap-2 sm:justify-end">
            <span className="text-xs text-muted-foreground">Menos</span>
            <div className="flex gap-0.5">
              {['bg-muted', 'bg-info/20', 'bg-info/40', 'bg-info/70', 'bg-info'].map((className) => (
                <div key={className} className={cn('h-4 w-4 rounded-sm', className)} />
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Mais</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
