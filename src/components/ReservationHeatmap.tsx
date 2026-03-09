import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface HeatmapProps {
  counts: Record<string, number>;
  maxCount: number;
  hours: string[];
  dayNames: string[];
}

function getIntensity(count: number, max: number): string {
  if (count === 0 || max === 0) return 'bg-muted';
  const ratio = count / max;
  if (ratio > 0.75) return 'bg-primary';
  if (ratio > 0.5) return 'bg-primary/70';
  if (ratio > 0.25) return 'bg-primary/40';
  return 'bg-primary/20';
}

export default function ReservationHeatmap({ counts, maxCount, hours, dayNames }: HeatmapProps) {
  if (hours.length === 0) {
    return (
      <Card className="border border-border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Horários Mais Reservados</CardTitle>
          <CardDescription>Sem dados no período selecionado</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Horários Mais Reservados</CardTitle>
        <CardDescription>Distribuição por dia da semana e horário</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <TooltipProvider delayDuration={100}>
            <div className="min-w-[500px]">
              {/* Header row with hours */}
              <div className="flex gap-1 mb-1">
                <div className="w-10 shrink-0" />
                {hours.map(h => (
                  <div key={h} className="flex-1 text-center text-[10px] text-muted-foreground font-medium">
                    {h}
                  </div>
                ))}
              </div>

              {/* Grid rows */}
              {dayNames.map((day, dayIdx) => (
                <div key={day} className="flex gap-1 mb-1">
                  <div className="w-10 shrink-0 text-xs text-muted-foreground font-medium flex items-center">
                    {day}
                  </div>
                  {hours.map(hour => {
                    const key = `${dayIdx}_${hour}`;
                    const count = counts[key] || 0;
                    return (
                      <Tooltip key={key}>
                        <TooltipTrigger asChild>
                          <div
                            className={cn(
                              'flex-1 h-8 rounded-sm transition-colors cursor-default min-w-[28px]',
                              getIntensity(count, maxCount),
                            )}
                          />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <span className="font-semibold">{day} {hour}</span>: {count} reserva{count !== 1 ? 's' : ''}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              ))}
            </div>
          </TooltipProvider>

          {/* Legend */}
          <div className="flex items-center justify-end gap-2 mt-3">
            <span className="text-[10px] text-muted-foreground">Menos</span>
            <div className="flex gap-0.5">
              {['bg-muted', 'bg-primary/20', 'bg-primary/40', 'bg-primary/70', 'bg-primary'].map(c => (
                <div key={c} className={cn('w-4 h-4 rounded-sm', c)} />
              ))}
            </div>
            <span className="text-[10px] text-muted-foreground">Mais</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
