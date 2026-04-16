import { Activity, CalendarCheck, Clock3, MousePointerClick, UserRoundPen } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import type { LiveFunnelStage } from '@/hooks/useLiveFunnelPresence';

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
  }
> = {
  page_view: {
    label: 'P\u00E1gina P\u00FAblica',
    icon: MousePointerClick,
    color: 'bg-primary/10 text-primary',
  },
  date_select: {
    label: 'Sele\u00E7\u00E3o de Data',
    icon: Activity,
    color: 'bg-amber-500/10 text-amber-700',
  },
  time_select: {
    label: 'Sele\u00E7\u00E3o de Hor\u00E1rio',
    icon: Clock3,
    color: 'bg-sky-500/10 text-sky-700',
  },
  form_fill: {
    label: 'Dados Pessoais',
    icon: UserRoundPen,
    color: 'bg-violet-500/10 text-violet-700',
  },
  completed: {
    label: 'Reserva Finalizada',
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
      <CardHeader className="pb-1">
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1.5">
            <span>Ao Vivo Agora</span>
            <InfoTooltip
              content={`Mostra em qual etapa est\u00E3o as sess\u00F5es ativas nos \u00FAltimos ${windowMinutes} minutos, considerando apenas o \u00FAltimo estado conhecido de cada sess\u00E3o.`}
              ariaLabel="Entender o painel ao vivo do funil"
            />
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          {`${totalActive} sess\u00F5es com atividade nos \u00FAltimos ${windowMinutes} minutos`}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 pt-1">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5 [&>*]:min-w-0">
          {data.map((item) => {
            const config = STAGE_CONFIG[item.stage];
            const Icon = config.icon;

            return (
              <div
                key={item.stage}
                className="grid min-w-0 grid-cols-[auto,1fr,auto] items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5"
              >
                <div className={`inline-flex rounded-md p-2 ${config.color}`}>
                  <Icon className="h-3.5 w-3.5" />
                </div>

                <div className="min-w-0">
                  <p className="truncate text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    {config.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">ultimo estado conhecido</p>
                </div>

                <p className="text-2xl font-semibold leading-none text-foreground">{item.count}</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
