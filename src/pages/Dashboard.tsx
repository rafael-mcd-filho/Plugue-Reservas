import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { subDays, format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from 'recharts';
import {
  CalendarCheck, Users, Clock, TrendingUp, XCircle, UserX, CalendarIcon, CheckCircle,
  ArrowUpRight, ArrowDownRight, Minus, ClipboardList, Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useFunnelData } from '@/hooks/useFunnelData';
import { useDashboardData } from '@/hooks/useDashboardData';
import ReservationFunnelChart from '@/components/ReservationFunnelChart';
import ReservationHeatmap from '@/components/ReservationHeatmap';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';

const PERIOD_OPTIONS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '15', label: 'Últimos 15 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 3 meses' },
  { value: 'custom', label: 'Personalizado' },
];

const PIE_COLORS = [
  'hsl(28, 90%, 27%)',
  'hsl(28, 85%, 55%)',
  'hsl(0, 72%, 51%)',
  'hsl(0, 0%, 35%)',
];

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
      <span className="inline-flex items-center gap-0.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
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
      "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
      isNeutral && "text-muted-foreground bg-muted",
      isGood && "text-emerald-700 bg-emerald-100",
      isBad && "text-red-700 bg-red-100",
    )}>
      {isNeutral ? <Minus className="h-2.5 w-2.5" /> : isPositive ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
      {Math.abs(pct)}%
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
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
};

export default function Dashboard() {
  const companyContext = useMaybeCompanySlug();
  const isCompanyContext = !!companyContext;
  const queryClient = useQueryClient();

  const [companyId, setCompanyId] = useState<string>('all');
  const [period, setPeriod] = useState('30');
  const [customStart, setCustomStart] = useState<Date | undefined>();
  const [customEnd, setCustomEnd] = useState<Date | undefined>();

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
    if (period === 'custom' && customStart && customEnd) {
      return { startDate: customStart, endDate: customEnd };
    }
    const days = parseInt(period) || 30;
    return { startDate: subDays(new Date(), days - 1), endDate: new Date() };
  }, [period, customStart, customEnd]);

  const effectiveCompanyId = isCompanyContext ? companyContext?.companyId : (companyId !== 'all' ? companyId : undefined);

  const {
    dailyStats,
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
  } = useFunnelData(funnelCompanyId, startDate, endDate);

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
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'reservation_funnel_logs',
          ...(funnelCompanyId ? { filter: `company_id=eq.${funnelCompanyId}` } : {}),
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['funnel-data'] });
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

  const pieData = [
    { name: 'Concluídas', value: totals.completed },
    { name: 'Confirmadas', value: totals.confirmed },
    { name: 'Cancelamentos', value: totals.cancellations },
    { name: 'No-shows', value: totals.noShows },
  ].filter(d => d.value > 0);

  const stats = [
    { label: 'Total Reservas', value: totals.reservations, prev: prevTotals.reservations, icon: CalendarCheck, color: 'text-primary' },
    { label: 'Total Pessoas', value: totals.totalGuests, prev: prevTotals.totalGuests, icon: Users, color: 'text-primary' },
    { label: 'Concluídas', value: totals.completed, prev: prevTotals.completed, icon: CheckCircle, color: 'text-accent' },
    { label: 'Cancelamentos', value: totals.cancellations, prev: prevTotals.cancellations, icon: XCircle, color: 'text-destructive', goodWhenDecreases: true },
    { label: 'Média/Dia', value: avgPerDay, prev: prevAvgPerDay, compareCurrent: avgPerDayRaw, comparePrevious: prevAvgPerDayRaw, icon: TrendingUp, color: 'text-primary' },
  ];
  const advancedReportsEnabled = !isCompanyContext || !!featureFlags?.features.advanced_reports;
  const lastDataSyncAt = Math.max(dashboardUpdatedAt || 0, funnelUpdatedAt || 0);
  const hasFreshnessData = lastDataSyncAt > 0;
  const dataLagMs = hasFreshnessData ? Date.now() - lastDataSyncAt : 0;
  const dataIsStale = hasFreshnessData && dataLagMs > 45000;
  const dataIsSyncing = dashFetching || funnelFetching;
  const freshnessLabel = dataIsSyncing ? 'Sincronizando' : dataIsStale ? 'Dados com atraso' : 'Tempo real';

  const periodLabel = period === 'custom' ? 'periodo anterior' : `${Math.max(dailyStats.length, 1)} dias anteriores`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
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
                    O dashboard usa atualização em tempo real via Supabase Realtime e polling a cada 30 segundos.
                    {dataIsStale ? ' Pode haver um atraso momentâneo na exibição.' : ''}
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
              {PERIOD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {period === 'custom' && (
            <div className="flex gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !customStart && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customStart ? format(customStart, 'dd/MM/yyyy') : 'Início'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customStart} onSelect={setCustomStart} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !customEnd && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customEnd ? format(customEnd, 'dd/MM/yyyy') : 'Fim'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customEnd} onSelect={setCustomEnd} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </div>

      {dashLoading || (isCompanyContext && featureFlagsLoading) ? (
        <>
          {/* KPI skeleton */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 animate-pulse rounded-xl bg-muted" />
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
            <div className="lg:col-span-2 h-72 animate-pulse rounded-xl border border-border bg-muted" />
            <div className="h-72 animate-pulse rounded-xl border border-border bg-muted" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="h-56 animate-pulse rounded-xl border border-border bg-muted" />
            <div className="h-56 animate-pulse rounded-xl border border-border bg-muted" />
          </div>
        </>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {stats.map(stat => (
              <Card key={stat.label} className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 pt-5 pb-4">
                  <div className={`p-2.5 rounded-xl bg-muted ${stat.color}`}>
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
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="text-[10px] text-muted-foreground/60">vs. {periodLabel}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Waitlist KPIs */}
          {isCompanyContext && (
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 pt-5 pb-4">
                  <div className="p-2.5 rounded-xl bg-muted text-amber-600">
                    <ClipboardList className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.total}</p>
                    <p className="text-xs text-muted-foreground">Fila — Total</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 pt-5 pb-4">
                  <div className="p-2.5 rounded-xl bg-muted text-primary">
                    <CheckCircle className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.seated}</p>
                    <p className="text-xs text-muted-foreground">Fila — Sentados</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 pt-5 pb-4">
                  <div className="p-2.5 rounded-xl bg-muted text-destructive">
                    <UserX className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.expired}</p>
                    <p className="text-xs text-muted-foreground">Fila — Desistências</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border border-border shadow-sm">
                <CardContent className="flex items-center gap-3 pt-5 pb-4">
                  <div className="p-2.5 rounded-xl bg-muted text-muted-foreground">
                    <Clock className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xl font-bold">{waitlistTotals.avgWaitMin}min</p>
                    <p className="text-xs text-muted-foreground">Fila — Espera Média</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          {advancedReportsEnabled ? (
            <>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="border border-border shadow-sm lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Reservas por Dia</CardTitle>
                <CardDescription>Total de reservas no período selecionado</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={dailyStats}>
                      <defs>
                        <linearGradient id="colorRes" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(28, 85%, 55%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(28, 85%, 55%)" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorComp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(28, 90%, 27%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(28, 90%, 27%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <RechartsTooltip contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }} />
                      <Legend />
                      <Area type="monotone" dataKey="reservations" name="Total" stroke="hsl(28, 85%, 55%)" fill="url(#colorRes)" strokeWidth={2} />
                      <Area type="monotone" dataKey="completed" name="Concluídas" stroke="hsl(28, 90%, 27%)" fill="url(#colorComp)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Distribuição</CardTitle>
                <CardDescription>Status das reservas</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px] flex items-center justify-center">
                  {pieData.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sem dados no período</p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={3}
                          dataKey="value"
                          label={renderCustomLabel}
                          labelLine={false}
                        >
                          {pieData.map((_, i) => (
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
          </div>

          {/* Charts Row 2 */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Confirmadas vs Concluídas</CardTitle>
                <CardDescription>Comparativo diário</CardDescription>
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
                      <Bar dataKey="completed" name="Concluídas" fill="hsl(28, 90%, 27%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Cancelamentos e No-Shows</CardTitle>
                <CardDescription>Acompanhamento diário de perdas</CardDescription>
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
              description={isCompanyContext ? 'Conversão por etapa do processo de reserva' : 'Conversão agregada de todas as unidades'}
            />
          </div>
            </>
          ) : (
            <Card className="border border-amber-200 bg-amber-50 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Relatório avançado bloqueado</CardTitle>
                <CardDescription>Esta empresa ainda não tem acesso aos gráficos detalhados, heatmap e funil.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-amber-900">
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
