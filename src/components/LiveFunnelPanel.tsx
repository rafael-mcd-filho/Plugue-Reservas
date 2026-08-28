import { Activity, CalendarCheck, Clock3, MousePointerClick, UserRoundPen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import type { LiveFunnelStage } from '@/hooks/useLiveFunnelPresence';
import { cn } from '@/lib/utils';
import './LiveFunnelPanel.css';

interface LiveFunnelPanelProps {
  data: Array<{
    count: number;
    stage: LiveFunnelStage;
  }>;
  isLoading?: boolean;
  isUnavailable?: boolean;
  totalActive: number;
  windowMinutes: number;
}

const LIVE_STAGE_ORDER: LiveFunnelStage[] = [
  'page_view',
  'date_select',
  'time_select',
  'form_fill',
  'completed',
];

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
    label: 'Página Pública',
    shortLabel: 'Página',
    icon: MousePointerClick,
    color: 'bg-primary/10 text-primary',
  },
  date_select: {
    label: 'Seleção de Data',
    shortLabel: 'Data',
    icon: Activity,
    color: 'bg-amber-500/10 text-amber-700',
  },
  time_select: {
    label: 'Seleção de Horário',
    shortLabel: 'Horário',
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
  isLoading = false,
  isUnavailable = false,
  totalActive,
  windowMinutes,
}: LiveFunnelPanelProps) {
  const metricsReady = !isLoading && !isUnavailable;
  const sessionLabel = totalActive === 1 ? 'sessão' : 'sessões';
  const activeLabel = totalActive === 1 ? 'ativa' : 'ativas';
  const statusLabel = isLoading
    ? 'Carregando atividade ao vivo'
    : isUnavailable
      ? 'Atividade ao vivo indisponível'
      : `${totalActive} ${sessionLabel} ${activeLabel} nos últimos ${windowMinutes} minutos`;
  const visibleData = LIVE_STAGE_ORDER.map((stage) => (
    data.find((item) => item.stage === stage) ?? { stage, count: 0 }
  ));

  return (
    <Card className="min-w-0 border border-border shadow-sm" aria-busy={isLoading || undefined}>
      <CardContent className="min-w-0 p-2.5 sm:p-3">
        <div className="live-funnel-layout min-w-0">
          <div className="live-funnel-summary flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1.5 text-sm font-semibold leading-none text-foreground">
                <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                  {metricsReady && totalActive > 0 && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/55 motion-reduce:animate-none" />
                  )}
                  <span
                    className={cn(
                      'relative inline-flex h-2 w-2 rounded-full',
                      metricsReady && totalActive > 0 ? 'bg-success' : 'bg-muted-foreground/35',
                    )}
                  />
                </span>
                <span>Ao Vivo</span>
                <InfoTooltip
                  content={`Mostra em qual etapa estão as sessões ativas nos últimos ${windowMinutes} minutos, considerando apenas o último estado conhecido de cada sessão.`}
                  ariaLabel="Entender o painel ao vivo do funil"
                  interaction="popover"
                />
              </div>
            </div>

            <div
              className="inline-flex w-[76px] shrink-0 items-baseline justify-center gap-1 rounded-md bg-muted/50 px-2 py-1"
              role="status"
              aria-live="polite"
              aria-label={statusLabel}
            >
              <span className="text-base font-bold leading-none tabular-nums text-foreground">
                {metricsReady ? totalActive.toLocaleString('pt-BR') : '—'}
              </span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {metricsReady ? sessionLabel : 'sessões'}
              </span>
            </div>
          </div>

          <div className="live-funnel-divider" aria-hidden="true" />

          <div className="live-funnel-stage-viewport -mx-0.5 px-0.5 pb-0.5">
            <ol className="live-funnel-stages" aria-label="Etapas das sessões ativas">
              {visibleData.map((item) => {
                const config = STAGE_CONFIG[item.stage];
                const Icon = config.icon;
                const isActive = metricsReady && item.count > 0;
                const percentage = metricsReady && totalActive > 0
                  ? Math.round((item.count / totalActive) * 100)
                  : 0;
                const stageStatusLabel = isLoading
                  ? `${config.label}: carregando`
                  : isUnavailable
                    ? `${config.label}: indisponível`
                    : `${config.label}: ${item.count} ${item.count === 1 ? 'sessão' : 'sessões'}, ${percentage}% do total ativo`;

                return (
                  <li key={item.stage} className="min-w-0">
                    <div
                      className={cn(
                        'relative flex h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2.5 transition-colors',
                        isActive
                          ? 'bg-primary/[0.08]'
                          : 'bg-muted/35',
                      )}
                      title={metricsReady
                        ? `${config.label}: ${item.count} sessões no último estado conhecido`
                        : stageStatusLabel}
                      aria-label={stageStatusLabel}
                      role="group"
                    >
                      <div
                        className={cn('inline-flex shrink-0 rounded-md p-1.5', config.color)}
                        aria-hidden="true"
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium leading-none text-foreground">
                          {config.shortLabel}
                        </p>
                        <p className="mt-1 text-[10px] leading-none tabular-nums text-muted-foreground">
                          {isLoading ? 'Carregando…' : isUnavailable ? 'Indisponível' : `${percentage}% do total`}
                        </p>
                      </div>

                      <p className="shrink-0 text-lg font-bold leading-none tabular-nums text-foreground">
                        {metricsReady ? item.count.toLocaleString('pt-BR') : '—'}
                      </p>

                      <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted" aria-hidden="true">
                        <div
                          className={cn(
                            'h-full rounded-full transition-[width,background-color] motion-reduce:transition-none',
                            isActive ? 'bg-primary' : 'bg-muted-foreground/20',
                          )}
                          style={{
                            minWidth: isActive ? '1px' : undefined,
                            width: `${percentage}%`,
                          }}
                        />
                      </div>
                    </div>
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
