import { Activity, CalendarCheck, ChevronRight, Clock3, MousePointerClick, UserRoundPen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import type { LiveFunnelStage } from '@/hooks/useLiveFunnelPresence';
import { cn } from '@/lib/utils';

interface LiveFunnelPanelProps {
  data: Array<{
    count: number;
    stage: LiveFunnelStage;
  }>;
  totalActive: number;
  windowMinutes: number;
}

const STAGE_CONFIG: Record<
  LiveFunnelStage,
  {
    color: string;
    icon: typeof MousePointerClick;
    label: string;
    shortLabel: string;
  }
> = {
  page_view: {
    label: 'P\u00E1gina P\u00FAblica',
    shortLabel: 'P\u00E1gina',
    icon: MousePointerClick,
    color: 'bg-primary/10 text-primary',
  },
  date_select: {
    label: 'Sele\u00E7\u00E3o de Data',
    shortLabel: 'Data',
    icon: Activity,
    color: 'bg-amber-500/10 text-amber-700',
  },
  time_select: {
    label: 'Sele\u00E7\u00E3o de Hor\u00E1rio',
    shortLabel: 'Hor\u00E1rio',
    icon: Clock3,
    color: 'bg-sky-500/10 text-sky-700',
  },
  form_fill: {
    label: 'Dados Pessoais',
    shortLabel: 'Dados',
    icon: UserRoundPen,
    color: 'bg-violet-500/10 text-violet-700',
  },
  completed: {
    label: 'Reserva Finalizada',
    shortLabel: 'Finalizada',
    icon: CalendarCheck,
    color: 'bg-emerald-500/10 text-emerald-700',
  },
};

export default function LiveFunnelPanel({
  data,
  totalActive,
  windowMinutes,
}: LiveFunnelPanelProps) {
  return (
    <Card className="min-w-0 border border-border shadow-sm">
      <CardContent className="min-w-0 p-3">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 text-base font-semibold leading-none text-foreground">
                <span>Ao Vivo Agora</span>
                <InfoTooltip
                  content={`Mostra em qual etapa est\u00E3o as sess\u00F5es ativas nos \u00FAltimos ${windowMinutes} minutos, considerando apenas o \u00FAltimo estado conhecido de cada sess\u00E3o.`}
                  ariaLabel="Entender o painel ao vivo do funil"
                />
              </div>
              <p className="mt-1 text-xs leading-none text-muted-foreground">
                {`Atividade nos \u00FAltimos ${windowMinutes} minutos`}
              </p>
            </div>
            <div className="inline-flex shrink-0 items-baseline gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1">
              <span className="text-lg font-bold leading-none text-foreground">{totalActive}</span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{'sess\u00F5es'}</span>
            </div>
          </div>

          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <ol className="flex min-w-[720px] items-stretch">
              {data.map((item, index) => {
                const config = STAGE_CONFIG[item.stage];
                const Icon = config.icon;
                const isActive = item.count > 0;
                const percentage = totalActive > 0 ? Math.round((item.count / totalActive) * 100) : 0;
                const nextItem = data[index + 1];
                const connectorIsActive = isActive || Boolean(nextItem?.count);

                return (
                  <li
                    key={item.stage}
                    className="flex min-w-0 flex-1 items-stretch"
                  >
                    <div
                      className={cn(
                        'flex min-h-[74px] min-w-0 flex-1 flex-col rounded-lg border px-3 py-2 transition-colors',
                        isActive
                          ? 'border-primary/30 bg-primary/5'
                          : 'border-border bg-background',
                      )}
                      title={`${config.label}: ${item.count} sess\u00F5es no \u00FAltimo estado conhecido`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className={cn('inline-flex shrink-0 rounded-md p-1.5', config.color)}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <p className="text-right text-xl font-bold leading-none text-foreground tabular-nums">
                          {item.count}
                        </p>
                      </div>

                      <div className="mt-2 min-w-0">
                        <p className="truncate text-xs font-medium leading-none text-foreground">
                          {config.shortLabel}
                        </p>
                        <p className="mt-1 text-[10px] leading-none text-muted-foreground">
                          {percentage}% das sessões
                        </p>
                      </div>

                      <div className="mt-auto h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            isActive ? 'bg-primary' : 'bg-muted-foreground/20',
                          )}
                          style={{ width: `${Math.max(percentage, item.count > 0 ? 10 : 0)}%` }}
                        />
                      </div>
                    </div>

                    {index < data.length - 1 && (
                      <div className="flex w-8 shrink-0 items-center justify-center px-1" aria-hidden="true">
                        <div className={cn('h-px flex-1', connectorIsActive ? 'bg-primary/40' : 'bg-border')} />
                        <ChevronRight
                          className={cn(
                            'h-4 w-4 shrink-0',
                            connectorIsActive ? 'text-primary/65' : 'text-muted-foreground/35',
                          )}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
