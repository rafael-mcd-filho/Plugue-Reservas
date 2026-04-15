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

const STAGE_CONFIG: Record<LiveFunnelStage, {
  color: string;
  icon: typeof MousePointerClick;
  label: string;
}> = {
  page_view: {
    label: 'Página Pública',
    icon: MousePointerClick,
    color: 'bg-primary/10 text-primary',
  },
  date_select: {
    label: 'Seleção de Data',
    icon: Activity,
    color: 'bg-amber-500/10 text-amber-700',
  },
  time_select: {
    label: 'Seleção de Horário',
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
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <span className="inline-flex items-center gap-1.5">
            <span>Ao Vivo Agora</span>
            <InfoTooltip
              content={`Mostra em qual etapa estão as sessões ativas nos últimos ${windowMinutes} minutos, considerando apenas o último estado conhecido de cada sessão.`}
              ariaLabel="Entender o painel ao vivo do funil"
            />
          </span>
        </CardTitle>
        <CardDescription>
          {totalActive} sessões com atividade nos últimos {windowMinutes} minutos
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 [&>*]:min-w-0">
          {data.map((item) => {
            const config = STAGE_CONFIG[item.stage];
            const Icon = config.icon;

            return (
              <div key={item.stage} className="min-w-0 rounded-xl border border-border bg-background p-4">
                <div className={`inline-flex rounded-lg p-2 ${config.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <p className="mt-3 break-words text-xs uppercase tracking-wide text-muted-foreground">{config.label}</p>
                <p className="mt-2 text-3xl font-semibold text-foreground">{item.count}</p>
                <p className="mt-1 text-xs text-muted-foreground">ultimo estado conhecido</p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
