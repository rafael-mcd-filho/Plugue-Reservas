import { CircleCheck, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import InfoTooltip from '@/components/dashboard/InfoTooltip';

export interface ReservationOutcomeSegment {
  key: string;
  label: string;
  value: number;
  /** Pessoas no desfecho; fica de fora quando a conta não fecha (por exemplo, reservas ainda sem desfecho). */
  people?: number;
  className: string;
  hideWhenEmpty?: boolean;
  /** Texto que abre ao clicar no item da legenda. */
  explanation: string;
  /** Partes do número, mostradas abaixo da explicação (as que valem zero ficam de fora). */
  breakdown?: { label: string; value: number }[];
}

interface ReservationOutcomeCardProps {
  total: number;
  periodLabel: string;
  segments: ReservationOutcomeSegment[];
}

function formatShare(value: number, total: number) {
  if (total <= 0 || value <= 0) return '0%';
  const share = (value / total) * 100;
  if (share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

/** Uma barra de 100% com o desfecho das reservas do período escolhido, pela data da visita. */
export default function ReservationOutcomeCard({ total, periodLabel, segments }: ReservationOutcomeCardProps) {
  const visibleSegments = segments.filter((segment) => !segment.hideWhenEmpty || segment.value > 0);
  const summary = visibleSegments
    .map((segment) => `${segment.label}: ${segment.value.toLocaleString('pt-BR')} (${formatShare(segment.value, total)})`)
    .join('; ');

  return (
    <Card className="border border-border shadow-sm">
      <CardContent className="py-4">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="flex items-center gap-2">
            <CircleCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-medium text-foreground">Como terminaram as reservas</h2>
            <InfoTooltip
              content="Reservas e fila convertida com visita no período escolhido. Clique em cada item da legenda para ver o que ele conta."
              ariaLabel="Entender Como terminaram as reservas"
            />
          </div>
          <p className="text-xs text-muted-foreground">Pela data da visita · {periodLabel}</p>
        </div>

        {total > 0 ? (
          <>
            <div
              role="img"
              aria-label={`${total.toLocaleString('pt-BR')} reservas no período. ${summary}.`}
              className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
            >
              {visibleSegments.map((segment) => (
                segment.value > 0 ? (
                  <span
                    key={segment.key}
                    className={cn('h-full min-w-[3px] border-r-2 border-card last:border-r-0', segment.className)}
                    style={{ width: `${(segment.value / total) * 100}%` }}
                  />
                ) : null
              ))}
            </div>

            <ul className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 xl:grid-cols-4">
              {visibleSegments.map((segment) => {
                const breakdown = segment.breakdown?.filter((part) => part.value > 0) ?? [];
                return (
                  <li key={segment.key} className="min-w-0">
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label={`${segment.label}: ${segment.value.toLocaleString('pt-BR')}. Ver o que este número conta`}
                          className="group flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60"
                        >
                          <span aria-hidden="true" className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', segment.className)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-foreground">
                              {segment.label} · {segment.value.toLocaleString('pt-BR')}
                              <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground" />
                            </span>
                            <span className="block text-xs tabular-nums text-muted-foreground">
                              {formatShare(segment.value, total)}
                              {segment.people !== undefined && (
                                <> · {segment.people.toLocaleString('pt-BR')} {segment.people === 1 ? 'pessoa' : 'pessoas'}</>
                              )}
                            </span>
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-80 space-y-2 text-sm">
                        <p className="flex items-center gap-2 font-semibold text-foreground">
                          <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-full', segment.className)} />
                          {segment.label}
                        </p>
                        <p className="leading-relaxed text-muted-foreground">{segment.explanation}</p>
                        {breakdown.length > 0 && (
                          <ul className="space-y-1 border-t border-border pt-2">
                            {breakdown.map((part) => (
                              <li key={part.label} className="flex items-start justify-between gap-3">
                                <span className="text-muted-foreground">{part.label}</span>
                                <span className="font-semibold tabular-nums text-foreground">{part.value.toLocaleString('pt-BR')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </PopoverContent>
                    </Popover>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p role="status" className="rounded-lg border border-dashed border-border bg-muted/10 px-4 py-5 text-center text-sm text-muted-foreground">
            Nenhuma reserva com visita no período.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
