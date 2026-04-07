import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  endOfMonth,
  endOfWeek,
  format,
  formatDistanceToNow,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from 'recharts';
import {
  CalendarCheck, Users, Clock, TrendingUp, XCircle, UserX, CalendarIcon, CheckCircle,
  ArrowUpRight, ArrowDownRight, Minus, ClipboardList, Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useFunnelData } from '@/hooks/useFunnelData';
import { useLiveFunnelPresence } from '@/hooks/useLiveFunnelPresence';
import { useDashboardData } from '@/hooks/useDashboardData';
import LiveFunnelPanel from '@/components/LiveFunnelPanel';
import ReservationFunnelChart from '@/components/ReservationFunnelChart';
import ReservationHeatmap from '@/components/ReservationHeatmap';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import type { DateRange } from 'react-day-picker';

const PERIOD_OPTIONS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '15', label: 'Últimos 15 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 3 meses' },
  { value: 'custom', label: 'Personalizado' },
];

const DASHBOARD_PERIOD_OPTIONS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: 'this_week', label: 'Esta semana' },
  { value: 'last_week', label: 'Semana anterior' },
  { value: 'this_month', label: 'Mês atual' },
  { value: 'last_month', label: 'Mês anterior' },
  { value: 'custom', label: 'Período personalizado' },
];

const CHART_COLORS = {
  primary: 'hsl(var(--primary))',
  success: 'hsl(var(--success))',
  destructive: 'hsl(var(--destructive))',
  muted: 'hsl(var(--muted-foreground))',
  grid: 'rgba(0, 0, 0, 0.08)',
  surface: 'hsl(var(--card))',
  border: 'rgba(0, 0, 0, 0.08)',
};

function formatDashboardDateRangeLabel(range: DateRange | undefined) {
  if (!range?.from) {
    return 'Selecionar periodo';
  }

  if (!range.to) {
    return `${format(range.from, 'dd/MM/yyyy')} - ...`;
  }

  return `${format(range.from, 'dd/MM/yyyy')} - ${format(range.to, 'dd/MM/yyyy')}`;
}

function getDashboardPeriodRange(period: string, customRange?: DateRange) {
  const today = new Date();

  switch (period) {
    case 'today':
      return { startDate: today, endDate: today };
    case 'yesterday': {
      const yesterday = subDays(today, 1);
      return { startDate: yesterday, endDate: yesterday };
    }
    case 'this_week':
      return {
        startDate: startOfWeek(today, { weekStartsOn: 1 }),
        endDate: today,
      };
    case 'last_week': {
      const lastWeek = subWeeks(today, 1);
      return {
        startDate: startOfWeek(lastWeek, { weekStartsOn: 1 }),
        endDate: endOfWeek(lastWeek, { weekStartsOn: 1 }),
      };
    }
    case 'this_month':
      return {
        startDate: startOfMonth(today),
        endDate: today,
      };
    case 'last_month': {
      const lastMonth = subMonths(today, 1);
      return {
        startDate: startOfMonth(lastMonth),
        endDate: endOfMonth(lastMonth),
      };
    }
    case 'custom':
      if (customRange?.from) {
        return {
          startDate: customRange.from,
          endDate: customRange.to ?? customRange.from,
        };
      }

      return { startDate: today, endDate: today };
    default:
      return { startDate: subDays(today, 29), endDate: today };
  }
}

const PIE_COLORS = [CHART_COLORS.success, CHART_COLORS.primary, CHART_COLORS.destructive, CHART_COLORS.muted];

function VariationBadge({
  current,
  previous,
  goodWhenDecreases = false,
}: {
  current: number;
  previous: number;
  goodWhenDecreases?: boolean;
}) {
  if (previous === 0 && current === 0) return null;

  if (previous === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-info-soft px-1.5 py-0.5 text-xs font-semibold text-info">
        <ArrowUpRight className="h-2.5 w-2.5" />
        Novo
      </span>
    );
  }

  const pct = Math.round(((current - previous) / previous) * 100);

  const isPositive = pct > 0;
  const isNeutral = pct === 0;
  const isGood = goodWhenDecreases ? pct < 0 : pct > 0;
  const isBad = !isNeutral && !isGood;

  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold",
      isNeutral && "text-muted-foreground bg-muted",
      isGood && "text-success bg-success-soft",
      isBad && "text-destructive bg-destructive-soft",
    )}>
      {isNeutral ? <Minus className="h-2.5 w-2.5" /> : isPositive ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
      {Math.abs(pct)}%
    </span>
  );
}

function MetricLabel({
  label,
  tooltip,
}: {
  label: string;
  tooltip: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <InfoTooltip content={tooltip} ariaLabel={`Entender a métrica ${label}`} />
    </span>
  );
}

function SectionTitle({
  title,
  tooltip,
}: {
  title: string;
  tooltip: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{title}</span>
      <InfoTooltip content={tooltip} ariaLabel={`Entender o gráfico ${title}`} />
    </span>
  );
}

// Custom label renderer for the donut chart - renders inside the slices
const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: any) => {
  if (percent < 0.05) return null; // Don't render labels for very small slices
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
};

export default function Dashboard() {
  const companyContext = useMaybeCompanySlug();
  const isCompanyContext = !!companyContext;
  const queryClient = useQueryClient();

  const [companyId, setCompanyId] = useState<string>('all');
  const [period, setPeriod] = useState('this_month');
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [uniqueFunnelOnly, setUniqueFunnelOnly] = useState(false);

  const { data: companies = [] } = useQuery({
    queryKey: ['dashboard-companies'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('id, name, status')
        .order('name');
      if (error) throw error;
      return (data as any[]).filter((c: any) => c.status === 'active') as { id: string; name: string }[];
    },
    enabled: !isCompanyContext,
  });
  const { data: featureFlags, isLoading: featureFlagsLoading } = useCompanyFeatureFlags(
    isCompanyContext ? companyContext?.companyId : undefined,
  );

  const { startDate, endDate } = useMemo(() => {
    return getDashboardPeriodRange(period, customRange);
  }, [period, customRange]);

  const effectiveCompanyId = isCompanyContext ? companyContext?.companyId : (companyId !== 'all' ? companyId : undefined);

  const {
    dailyStats,
    createdReservationDailyStats,
    reservationLeadTrend,
    createdReservationTotals,
    waitlistDailyStats,
    totals,
    prevTotals,
    waitlistTotals,
    heatmapData,
    isLoading: dashLoading,
    isFetching: dashFetching,
    lastUpdatedAt: dashboardUpdatedAt,
  } = useDashboardData(effectiveCompanyId, startDate, endDate);

  const funnelCompanyId = isCompanyContext ? companyContext?.companyId : (companyId !== 'all' ? companyId : undefined);
  const {
    data: funnelData = [],
    dataUpdatedAt: funnelUpdatedAt = 0,
    isFetching: funnelFetching,
  } = useFunnelData(funnelCompanyId, startDate, endDate, uniqueFunnelOnly);
  const {
    data: liveFunnelPresence,
    dataUpdatedAt: liveFunnelUpdatedAt = 0,
    isFetching: liveFunnelFetching,
  } = useLiveFunnelPresence(funnelCompanyId);

  useEffect(() => {
    const channel = supabase
      .channel(`dashboard-live:${effectiveCompanyId ?? 'all'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'reservations',
          ...(effectiveCompanyId ? { filter: `company_id=eq.${effectiveCompanyId}` } : {}),
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['dashboard-reservations'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard-reservations-prev'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard-reservations-created'] });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'waitlist',
          ...(effectiveCompanyId ? { filter: `company_id=eq.${effectiveCompanyId}` } : {}),
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['dashboard-waitlist'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard-waitlist-seated'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard-waitlist-dropped'] });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tracking_events',
          ...(funnelCompanyId ? { filter: `company_id=eq.${funnelCompanyId}` } : {}),
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['funnel-data'] });
          queryClient.invalidateQueries({ queryKey: ['live-funnel-presence'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, effectiveCompanyId, funnelCompanyId]);

  const avgPerDayRaw = dailyStats.length > 0 ? totals.reservations / dailyStats.length : 0;
  const prevAvgPerDayRaw = dailyStats.length > 0 ? prevTotals.reservations / dailyStats.length : 0;
  const avgPerDay = Math.round(avgPerDayRaw);
  const prevAvgPerDay = Math.round(prevAvgPerDayRaw);

  const scheduledStatusPieData = [
    { name: 'Check-ins de agendadas', value: totals.scheduledCompleted },
    { name: 'Confirmadas', value: totals.confirmed },
    { name: 'Cancelamentos', value: totals.cancellations },
    { name: 'No-shows', value: totals.noShows },
  ].filter((entry) => entry.value > 0);

  const mainStats = [
    { label: 'Total Reservas', tooltip: 'Número de reservas marcadas para acontecer no período selecionado.', value: totals.reservations, prev: prevTotals.reservations, icon: CalendarCheck, color: 'text-primary' },
    { label: 'Total Pessoas', tooltip: 'Total de pessoas somadas nas reservas do período selecionado.', value: totals.totalGuests, prev: prevTotals.totalGuests, icon: Users, color: 'text-primary' },
    { label: 'Check-ins realizados', tooltip: 'Reservas do período em que o cliente realmente chegou ao local.', value: totals.completed, prev: prevTotals.completed, icon: CheckCircle, color: 'text-accent' },
    { label: 'Cancelamentos', tooltip: 'Reservas do período que foram canceladas.', value: totals.cancellations, prev: prevTotals.cancellations, icon: XCircle, color: 'text-destructive', goodWhenDecreases: true },
    { label: 'Média/Dia', tooltip: 'Média de reservas por dia no período selecionado.', value: avgPerDay, prev: prevAvgPerDay, compareCurrent: avgPerDayRaw, comparePrevious: prevAvgPerDayRaw, icon: TrendingUp, color: 'text-primary' },
  ];
  const dashboardStats = [
    {
      label: 'Reservas agendadas',
      tooltip: 'Reservas marcadas previamente para o periodo. Nao inclui quem entrou pela fila.',
      value: totals.scheduledReservations,
      prev: prevTotals.scheduledReservations,
      icon: CalendarCheck,
      color: 'text-primary',
    },
    {
      label: 'Fila convertida',
      tooltip: 'Pessoas ou grupos que entraram na fila e depois viraram registro em reservas.',
      value: totals.waitlistReservations,
      prev: prevTotals.waitlistReservations,
      icon: ClipboardList,
      color: 'text-success',
    },
    {
      label: 'Atendimentos totais',
      tooltip: 'Total registrado em reservas no periodo: agendadas mais o que veio da fila.',
      value: totals.reservations,
      prev: prevTotals.reservations,
      icon: CalendarIcon,
      color: 'text-info',
    },
    {
      label: 'Total pessoas',
      tooltip: 'Soma das pessoas em todos os atendimentos registrados no periodo.',
      value: totals.totalGuests,
      prev: prevTotals.totalGuests,
      icon: Users,
      color: 'text-info',
    },
    {
      label: 'Check-ins totais',
      tooltip: 'Atendimentos do periodo em que o cliente realmente chegou, incluindo agendadas e fila convertida.',
      value: totals.completed,
      prev: prevTotals.completed,
      icon: CheckCircle,
      color: 'text-success',
    },
    {
      label: 'Cancelamentos agendados',
      tooltip: 'Reservas agendadas que foram canceladas no periodo. A fila nao entra aqui.',
      value: totals.cancellations,
      prev: prevTotals.cancellations,
      icon: XCircle,
      color: 'text-destructive',
      goodWhenDecreases: true,
    },
  ];
  const advancedReportsEnabled = !isCompanyContext || !!featureFlags?.features.advanced_reports;
  const lastDataSyncAt = Math.max(dashboardUpdatedAt || 0, funnelUpdatedAt || 0, liveFunnelUpdatedAt || 0);
  const hasFreshnessData = lastDataSyncAt > 0;
  const dataLagMs = hasFreshnessData ? Date.now() - lastDataSyncAt : 0;
  const dataIsStale = hasFreshnessData && dataLagMs > 45000;
  const dataIsSyncing = dashFetching || funnelFetching || liveFunnelFetching;
  const freshnessLabel = dataIsSyncing ? 'Sincronizando' : dataIsStale ? 'Dados com atraso' : 'Tempo real';

  const periodLabel = 'período anterior equivalente';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant={dataIsStale ? 'destructive' : dataIsSyncing ? 'secondary' : 'outline'} className="gap-1.5">
                    <Info className="h-3.5 w-3.5" />
                    {freshnessLabel}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-sm">
                  <p>
                    {hasFreshnessData
                      ? `Última sincronização ${formatDistanceToNow(new Date(lastDataSyncAt), { addSuffix: true, locale: ptBR })}.`
                      : 'Aguardando a primeira sincronização.'}
                  </p>
                  <p className="mt-1">
                    O painel se atualiza sozinho e pode levar alguns segundos para refletir mudanças recentes.
                    {dataIsStale ? ' Neste momento existe um pequeno atraso na atualização.' : ''}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-muted-foreground mt-1">Análise de reservas em tempo real</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {!isCompanyContext && (
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Todas as unidades" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as unidades</SelectItem>
                {companies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DASHBOARD_PERIOD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {period === 'custom' && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn("w-[280px] justify-start text-left text-sm", !customRange?.from && "text-muted-foreground")}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {formatDashboardDateRangeLabel(customRange)}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={customRange}
                  onSelect={setCustomRange}
                  numberOfMonths={typeof window !== 'undefined' && window.innerWidth < 640 ? 1 : 2}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          )}

        </div>
      </div>

      {isCompanyContext && liveFunnelPresence && (
        <LiveFunnelPanel
          data={liveFunnelPresence.stages}
          totalActive={liveFunnelPresence.totalActive}
          windowMinutes={liveFunnelPresence.windowMinutes}
        />
      )}

      {dashLoading || (isCompanyContext && featureFlagsLoading) ? (
        <>
          {/* KPI skeleton */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 animate-pulse rounded-md bg-muted" />
                  <div className="space-y-2">
                    <div className="h-6 w-12 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Chart skeleton */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 h-72 animate-pulse rounded-md border border-border bg-muted" />
            <div className="h-72 animate-pulse rounded-md border border-border bg-muted" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="h-56 animate-pulse rounded-md border border-border bg-muted" />
            <div className="h-56 animate-pulse rounded-md border border-border bg-muted" />
          </div>
        </>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            {dashboardStats.map(stat => (
              <Card key={stat.label} className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className={`p-2.5 rounded-md bg-muted ${stat.color}`}>
                    <stat.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xl font-bold">{stat.value.toLocaleString('pt-BR')}</p>
                      <VariationBadge
                        current={stat.compareCurrent ?? stat.value}
                        previous={stat.comparePrevious ?? stat.prev}
                        goodWhenDecreases={stat.goodWhenDecreases}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <MetricLabel label={stat.label} tooltip={stat.tooltip} />
                    </p>
                    <p className="text-xs text-muted-foreground/60">vs. {periodLabel}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Waitlist KPIs */}
          {isCompanyContext && (
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="rounded-md bg-primary-soft p-2.5 text-primary">
                    <ClipboardList className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.total}</p>
                    <p className="text-xs text-muted-foreground">
                      <MetricLabel
                        label="Fila — Total"
                        tooltip="Número de pessoas ou grupos que entraram na fila no período."
                      />
                    </p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="rounded-md bg-success-soft p-2.5 text-success">
                    <CheckCircle className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.seated}</p>
                    <p className="text-xs text-muted-foreground">
                      <MetricLabel
                        label="Fila — Sentados"
                        tooltip="Número de pessoas ou grupos da fila que foram atendidos e sentados no período."
                      />
                    </p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="rounded-md bg-destructive-soft p-2.5 text-destructive">
                    <UserX className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.expired}</p>
                    <p className="text-xs text-muted-foreground">
                      <MetricLabel
                        label="Fila — Desistências"
                        tooltip="Número de pessoas ou grupos da fila que saíram sem sentar, por desistência ou por tempo esgotado."
                      />
                    </p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="rounded-md bg-info-soft p-2.5 text-info">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.avgWaitMin}min</p>
                    <p className="text-xs text-muted-foreground">
                      <MetricLabel
                        label="Fila — Espera Média"
                        tooltip="Tempo médio entre entrar na fila e ser atendido."
                      />
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {advancedReportsEnabled && (
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Atendimentos por Dia"
                    tooltip="Mostra por dia o que foi agendado, o que veio da fila e o total registrado em reservas."
                  />
                </CardTitle>
                <CardDescription>Separação diária entre agendadas, fila convertida e total</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }}
                        formatter={(value: number, name: string) => [`${value} atendimento${value === 1 ? '' : 's'}`, name]}
                      />
                      <Legend />
                      <Bar
                        dataKey="scheduledReservations"
                        name="Agendadas"
                        fill="hsl(28, 85%, 55%)"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="waitlistReservations"
                        name="Fila convertida"
                        fill="hsl(145, 63%, 42%)"
                        radius={[4, 4, 0, 0]}
                      />
                      <Line
                        type="monotone"
                        dataKey="reservations"
                        name="Total"
                        stroke="hsl(202, 89%, 48%)"
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <SectionTitle
                  title="Fila de Espera por Dia"
                  tooltip="Mostra, por dia, quantas pessoas entraram na fila, quantas foram atendidas e quantas saíram sem sentar."
                />
              </CardTitle>
              <CardDescription>
                Cada linha usa o dia em que o evento realmente aconteceu.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={waitlistDailyStats}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }}
                      formatter={(value: number, name: string) => [`${value} cliente${value === 1 ? '' : 's'}`, name]}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="entries"
                      name="Entradas na fila"
                      stroke="hsl(28, 85%, 55%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="seated"
                      name="Sentados"
                      stroke="hsl(145, 63%, 42%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="dropped"
                      name="Desistências"
                      stroke="hsl(0, 72%, 51%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <SectionTitle
                  title="Registros em reservas por data de criação"
                  tooltip="Mostra quantos registros entraram em reservas por dia, separando o que foi agendado do que veio da fila."
                />
              </CardTitle>
              <CardDescription>
                {createdReservationTotals.totalCreated > 0
                  ? `${createdReservationTotals.scheduledCreated} agendadas e ${createdReservationTotals.waitlistCreated} vindas da fila foram registradas em reservas no período.`
                  : 'Sem novos registros em reservas no período selecionado.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={createdReservationDailyStats}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }}
                      formatter={(value: number, name: string) => [`${value} registro${value === 1 ? '' : 's'}`, name]}
                    />
                    <Legend />
                    <Bar
                      dataKey="scheduledCreatedReservations"
                      name="Agendadas"
                      fill="hsl(28, 85%, 55%)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="waitlistCreatedReservations"
                      name="Fila convertida"
                      fill="hsl(145, 63%, 42%)"
                      radius={[4, 4, 0, 0]}
                    />
                    <Line
                      type="monotone"
                      dataKey="createdReservations"
                      name="Total em reservations"
                      stroke="hsl(202, 89%, 48%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Antecedência das reservas agendadas"
                    tooltip="Mostra com quantos dias de antecedência as reservas agendadas costumam ser feitas. A fila não entra aqui."
                  />
                </CardTitle>
                <CardDescription>
                  Média de {createdReservationTotals.avgLeadDays.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dias entre a criação e o dia marcado nas reservas agendadas.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-border bg-muted/20 p-3">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      <MetricLabel
                        label="Média geral"
                        tooltip="Média de dias entre o momento em que a reserva agendada foi feita e o dia marcado para a visita."
                      />
                    </p>
                    <p className="mt-1 text-lg font-semibold text-foreground">
                      {createdReservationTotals.avgLeadDays.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dias
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted/20 p-3">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      <MetricLabel
                        label="Mesmo dia"
                        tooltip="Reservas feitas para o próprio dia."
                      />
                    </p>
                    <p className="mt-1 text-lg font-semibold text-foreground">{createdReservationTotals.sameDayReservations}</p>
                  </div>
                  <div className="rounded-xl border border-border bg-muted/20 p-3">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                      <MetricLabel
                        label="Agendadas criadas"
                        tooltip="Total de reservas agendadas registradas no sistema no período."
                      />
                    </p>
                    <p className="mt-1 text-lg font-semibold text-foreground">{createdReservationTotals.scheduledCreated}</p>
                  </div>
                </div>

                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={reservationLeadTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis yAxisId="left" allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }}
                        formatter={(value: number, name: string) => {
                          if (name === 'Antecedência média (dias)') {
                            return [`${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dias`, name];
                          }

                          return [`${value} reserva${value === 1 ? '' : 's'}`, name];
                        }}
                      />
                      <Legend />
                      <Bar
                        yAxisId="left"
                        dataKey="createdReservations"
                        name="Agendadas criadas"
                        fill="hsl(28, 85%, 55%)"
                        radius={[4, 4, 0, 0]}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="avgLeadDays"
                        name="Antecedência média (dias)"
                        stroke="hsl(202, 89%, 48%)"
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {advancedReportsEnabled && (
              <Card className="border border-border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    <SectionTitle
                      title="Distribuição das agendadas"
                      tooltip="Mostra como as reservas agendadas do período se dividem entre os principais status."
                    />
                  </CardTitle>
                  <CardDescription>Status das reservas agendadas</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px] flex items-center justify-center">
                    {scheduledStatusPieData.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Sem dados no período</p>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={scheduledStatusPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={3}
                            dataKey="value"
                            label={renderCustomLabel}
                            labelLine={false}
                          >
                            {scheduledStatusPieData.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <RechartsTooltip />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
          {advancedReportsEnabled ? (
            <>
          {/* Charts Row 2 */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Confirmadas vs Check-ins das agendadas"
                    tooltip="Compara o que foi agendado com o que realmente aconteceu nas reservas agendadas."
                  />
                </CardTitle>
                <CardDescription>Comparativo diário apenas das reservas agendadas</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <RechartsTooltip contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }} />
                      <Legend />
                      <Bar dataKey="confirmed" name="Confirmadas" fill="hsl(28, 85%, 55%)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="scheduledCompleted" name="Check-ins de agendadas" fill="hsl(28, 90%, 27%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Cancelamentos e No-Shows das agendadas"
                    tooltip="Mostra as perdas do período por cancelamento e por cliente que não compareceu nas reservas agendadas."
                  />
                </CardTitle>
                <CardDescription>Acompanhamento diário das perdas nas reservas agendadas</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <RechartsTooltip contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }} />
                      <Legend />
                      <Bar dataKey="cancellations" name="Cancelamentos" fill="hsl(0, 72%, 51%)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="noShows" name="No-Shows" fill="hsl(0, 0%, 35%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Heatmap + Funnel */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ReservationHeatmap {...heatmapData} />
            <ReservationFunnelChart
              data={funnelData}
              title={isCompanyContext ? 'Funil de Reservas' : 'Funil de Reservas (Global)'}
              description={
                uniqueFunnelOnly
                  ? 'Conversao por etapa considerando apenas navegadores ou dispositivos anonimos unicos no periodo'
                  : isCompanyContext
                    ? 'Conversao por etapa considerando sessoes e jornadas do processo de reserva'
                    : 'Conversao agregada de todas as unidades considerando sessoes e jornadas'
              }
              measurementLabel={uniqueFunnelOnly ? 'Unicos' : 'Sessoes'}
              headerActions={(
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={uniqueFunnelOnly}
                    onCheckedChange={(checked) => setUniqueFunnelOnly(checked === true)}
                  />
                  Mostrar apenas unicos
                </label>
              )}
            />
          </div>
            </>
          ) : (
            <Card className="border border-primary/20 bg-primary-soft shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Relatório avançado bloqueado</CardTitle>
                <CardDescription>Esta empresa ainda não tem acesso aos gráficos detalhados, heatmap e funil.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-primary/85">
                  Os indicadores básicos continuam disponíveis acima. Libere a feature no perfil da empresa para habilitar a análise avançada.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
