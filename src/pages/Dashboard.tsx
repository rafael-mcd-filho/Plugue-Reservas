import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  differenceInCalendarDays,
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
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import {
  CalendarCheck, Users, TrendingUp, CalendarIcon,
  ArrowUpRight, ArrowDownRight, Minus, ClipboardList, Info, CircleAlert, RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useLiveFunnelPresence } from '@/hooks/useLiveFunnelPresence';
import { useDashboardData } from '@/hooks/useDashboardData';
import LiveFunnelPanel from '@/components/LiveFunnelPanel';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import DashboardReportOverview from '@/components/dashboard/DashboardReportOverview';
import { useCustomerRecurrenceVisitSeries } from '@/hooks/useCustomerRecurrenceVisitSeries';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useCompanyPermissions } from '@/hooks/useCompanyPermissions';
import { useMaybeCompanySlug } from '@/contexts/CompanySlugContext';
import { buildDashboardReportSearch } from '@/lib/dashboard-report-search';
import type { DateRange } from 'react-day-picker';

const DASHBOARD_PERIOD_OPTIONS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: 'this_week', label: 'Esta semana' },
  { value: 'last_week', label: 'Semana anterior' },
  { value: 'this_month', label: 'Mês atual' },
  { value: 'last_month', label: 'Mês anterior' },
  { value: 'custom', label: 'Período personalizado' },
];

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => (
    typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }

    mediaQuery.addListener(updatePreference);
    return () => mediaQuery.removeListener(updatePreference);
  }, []);

  return prefersReducedMotion;
}

function formatComparisonPeriodRangeLabel(startDate: Date, endDate: Date) {
  if (differenceInCalendarDays(endDate, startDate) === 0) {
    return format(startDate, 'dd/MM/yyyy');
  }

  return `${format(startDate, 'dd/MM/yyyy')} - ${format(endDate, 'dd/MM/yyyy')}`;
}

function getPreviousEquivalentRange(startDate: Date, endDate: Date) {
  const periodDays = differenceInCalendarDays(endDate, startDate) + 1;
  const comparisonEndDate = subDays(startDate, 1);
  const comparisonStartDate = subDays(comparisonEndDate, periodDays - 1);

  return { comparisonStartDate, comparisonEndDate };
}

function getSameMonthToDateRange(date: Date) {
  const previousMonthStart = startOfMonth(subMonths(date, 1));
  const previousMonthEnd = endOfMonth(previousMonthStart);
  const comparisonEndDate = new Date(previousMonthStart);
  comparisonEndDate.setDate(Math.min(date.getDate(), previousMonthEnd.getDate()));

  return {
    comparisonStartDate: previousMonthStart,
    comparisonEndDate,
  };
}

function getDashboardPeriodRange(period: string, customRange?: DateRange) {
  const today = new Date();

  switch (period) {
    case 'today':
      return {
        startDate: today,
        endDate: today,
        comparisonStartDate: subDays(today, 1),
        comparisonEndDate: subDays(today, 1),
        comparisonLabel: 'ontem',
      };
    case 'yesterday': {
      const yesterday = subDays(today, 1);
      const comparisonDate = subWeeks(yesterday, 1);
      return {
        startDate: yesterday,
        endDate: yesterday,
        comparisonStartDate: comparisonDate,
        comparisonEndDate: comparisonDate,
        comparisonLabel: 'mesmo dia da semana anterior',
      };
    }
    case 'this_week': {
      const startDate = startOfWeek(today, { weekStartsOn: 1 });
      return {
        startDate,
        endDate: today,
        comparisonStartDate: subWeeks(startDate, 1),
        comparisonEndDate: subWeeks(today, 1),
        comparisonLabel: 'mesma parte da semana anterior',
      };
    }
    case 'last_week': {
      const lastWeek = subWeeks(today, 1);
      const startDate = startOfWeek(lastWeek, { weekStartsOn: 1 });
      const endDate = endOfWeek(lastWeek, { weekStartsOn: 1 });
      return {
        startDate,
        endDate,
        comparisonStartDate: subWeeks(startDate, 1),
        comparisonEndDate: subWeeks(endDate, 1),
        comparisonLabel: 'semana fechada anterior',
      };
    }
    case 'this_month': {
      const startDate = startOfMonth(today);
      const { comparisonStartDate, comparisonEndDate } = getSameMonthToDateRange(today);
      return {
        startDate,
        endDate: today,
        comparisonStartDate,
        comparisonEndDate,
        comparisonLabel: 'mesmo período do mês anterior',
      };
    }
    case 'last_month': {
      const lastMonth = subMonths(today, 1);
      const comparisonMonth = subMonths(lastMonth, 1);
      return {
        startDate: startOfMonth(lastMonth),
        endDate: endOfMonth(lastMonth),
        comparisonStartDate: startOfMonth(comparisonMonth),
        comparisonEndDate: endOfMonth(comparisonMonth),
        comparisonLabel: 'mês anterior',
      };
    }
    case 'custom':
      if (customRange?.from) {
        const startDate = customRange.from;
        const endDate = customRange.to ?? customRange.from;
        const { comparisonStartDate, comparisonEndDate } = getPreviousEquivalentRange(startDate, endDate);

        return {
          startDate,
          endDate,
          comparisonStartDate,
          comparisonEndDate,
          comparisonLabel: 'período anterior equivalente',
        };
      }

      return {
        startDate: today,
        endDate: today,
        comparisonStartDate: subDays(today, 1),
        comparisonEndDate: subDays(today, 1),
        comparisonLabel: 'período anterior equivalente',
      };
    default: {
      const startDate = subDays(today, 29);
      const endDate = today;
      const { comparisonStartDate, comparisonEndDate } = getPreviousEquivalentRange(startDate, endDate);
      return {
        startDate,
        endDate,
        comparisonStartDate,
        comparisonEndDate,
        comparisonLabel: 'período anterior equivalente',
      };
    }
  }
}

function VariationBadge({
  current,
  previous,
  metricLabel = 'Métrica',
  currentPeriodLabel = 'Período atual',
  comparisonPeriodLabel = 'Período comparado',
  comparisonLabel = 'período comparado',
  valueSingular = 'registro',
  valuePlural = 'registros',
  goodWhenDecreases = false,
}: {
  current: number;
  previous: number;
  metricLabel?: string;
  currentPeriodLabel?: string;
  comparisonPeriodLabel?: string;
  comparisonLabel?: string;
  valueSingular?: string;
  valuePlural?: string;
  goodWhenDecreases?: boolean;
}) {
  if (previous === 0 && current === 0) return null;

  const formatValueWithUnit = (value: number) => {
    const unit = Math.abs(value) === 1 ? valueSingular : valuePlural;
    return `${value.toLocaleString('pt-BR')} ${unit}`;
  };
  const difference = current - previous;

  if (previous === 0) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-info-soft px-1 py-0.5 text-[10px] font-semibold text-info transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-1.5 sm:text-xs"
            title={`Ver cálculo de ${metricLabel}`}
          >
            <ArrowUpRight className="h-2.5 w-2.5" />
            Novo
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Comparativo: {metricLabel}</DialogTitle>
            <DialogDescription>Comparativo vs. {comparisonLabel}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">Período atual</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{currentPeriodLabel}</p>
                <p className="mt-2 text-lg font-bold text-foreground">{formatValueWithUnit(current)}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">Período comparado</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{comparisonPeriodLabel}</p>
                <p className="mt-2 text-lg font-bold text-foreground">{formatValueWithUnit(previous)}</p>
              </div>
            </div>
            <div className="rounded-lg border border-info/20 bg-info-soft/40 p-3 text-sm text-muted-foreground">
              O período comparado teve zero registros, então o sistema não divide por zero. O badge mostra
              {' '}<span className="font-semibold text-info">Novo</span>{' '}para indicar que houve atividade apenas no período atual.
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const pct = Math.round(((current - previous) / previous) * 100);

  const isPositive = pct > 0;
  const isNeutral = pct === 0;
  const isGood = goodWhenDecreases ? pct < 0 : pct > 0;
  const isBad = !isNeutral && !isGood;
  const signedPct = `${pct > 0 ? '+' : ''}${pct}%`;
  const formulaLabel = `((${current.toLocaleString('pt-BR')} - ${previous.toLocaleString('pt-BR')}) / ${previous.toLocaleString('pt-BR')}) × 100 = ${signedPct}`;
  const maxValue = Math.max(current, previous, 1);
  const currentBarPct = Math.round((current / maxValue) * 100);
  const previousBarPct = Math.round((previous / maxValue) * 100);
  const barColor = isGood ? 'bg-success' : isBad ? 'bg-destructive' : 'bg-muted-foreground/40';

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1 py-0.5 text-[10px] font-semibold transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-1.5 sm:text-xs",
            isNeutral && "text-muted-foreground bg-muted",
            isGood && "text-success bg-success-soft",
            isBad && "text-destructive bg-destructive-soft",
          )}
          title={`Ver cálculo de ${metricLabel}`}
        >
          {isNeutral ? <Minus className="h-2.5 w-2.5" /> : isPositive ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
          {Math.abs(pct)}%
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Comparativo: {metricLabel}</DialogTitle>
          <DialogDescription>Comparativo vs. {comparisonLabel}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div
            className={cn(
              'flex flex-col items-center gap-1 rounded-xl border p-4 text-center',
              isNeutral && 'border-border bg-muted/20',
              isGood && 'border-success/20 bg-success-soft/40',
              isBad && 'border-destructive/20 bg-destructive-soft/40',
            )}
          >
            <div
              className={cn(
                'flex items-center gap-1 text-3xl font-bold tabular-nums',
                isNeutral && 'text-muted-foreground',
                isGood && 'text-success',
                isBad && 'text-destructive',
              )}
            >
              {isNeutral ? <Minus className="h-6 w-6" /> : isPositive ? <ArrowUpRight className="h-6 w-6" /> : <ArrowDownRight className="h-6 w-6" />}
              {Math.abs(pct).toLocaleString('pt-BR')}%
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              {isNeutral
                ? 'Sem variação no período'
                : `${formatValueWithUnit(Math.abs(difference))} ${difference > 0 ? 'a mais' : 'a menos'}`}
            </p>
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-muted/10 p-3">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0 font-medium text-foreground">Atual</span>
                <span className="truncate text-right text-muted-foreground">{currentPeriodLabel}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${currentBarPct}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right text-sm font-bold tabular-nums text-foreground">
                  {current.toLocaleString('pt-BR')}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0 font-medium text-foreground">Anterior</span>
                <span className="truncate text-right text-muted-foreground">{comparisonPeriodLabel}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-muted-foreground/30 transition-all" style={{ width: `${previousBarPct}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right text-sm font-bold tabular-nums text-foreground">
                  {previous.toLocaleString('pt-BR')}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Como calculamos</p>
            <p className="mt-1.5 font-mono text-xs text-muted-foreground">{formulaLabel}</p>
            {goodWhenDecreases && !isNeutral && (
              <p className="mt-2 text-xs text-muted-foreground">
                Nesta métrica, queda é considerada melhoria e aumento é considerado piora.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
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

export default function Dashboard() {
  const companyContext = useMaybeCompanySlug();
  const isCompanyContext = !!companyContext;
  const queryClient = useQueryClient();
  const prefersReducedMotion = usePrefersReducedMotion();
  const {
    activeRoles,
    hasPermission,
    permissionsError,
    permissionsLoading,
  } = useCompanyPermissions();

  const [companyId, setCompanyId] = useState<string>('all');
  const [period, setPeriod] = useState('this_month');
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [reservationVolumeMetric, setReservationVolumeMetric] = useState<'reservations' | 'people'>('reservations');

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

  const { startDate, endDate, comparisonStartDate, comparisonEndDate, comparisonLabel } = useMemo(() => {
    return getDashboardPeriodRange(period, customRange);
  }, [period, customRange]);

  const effectiveCompanyId = isCompanyContext ? companyContext?.companyId : (companyId !== 'all' ? companyId : undefined);
  const isInitialFeatureFlagsLoading = isCompanyContext && featureFlagsLoading && !featureFlags;
  const advancedReportsEnabled = !isCompanyContext || (!featureFlagsLoading && !!featureFlags?.features.advanced_reports);
  const hasAdvancedReportRole = activeRoles.includes('admin') || activeRoles.includes('superadmin');
  const showCompanyReportOverview = !!companyContext?.slug
    && advancedReportsEnabled
    && !permissionsLoading
    && !permissionsError
    && hasAdvancedReportRole
    && hasPermission('dashboard_view');

  const {
    dailyStats,
    dailyCapacityTotals,
    createdReservationTotals,
    reservationOriginBreakdown,
    totals,
    prevTotals,
    waitlistTotals,
    isLoading: dashLoading,
    isFetching: dashFetching,
    lastUpdatedAt: dashboardUpdatedAt,
    operationalIsError: dashboardOperationalIsError,
    reportOverviewIsError: dashboardReportOverviewIsError,
    refetch: refetchDashboard,
  } = useDashboardData(
    effectiveCompanyId,
    startDate,
    endDate,
    comparisonStartDate,
    comparisonEndDate,
    { includeReportOverview: showCompanyReportOverview },
  );

  const liveFunnelCompanyId = effectiveCompanyId;
  const {
    data: liveFunnelPresence,
    dataUpdatedAt: liveFunnelUpdatedAt = 0,
    isFetching: liveFunnelFetching,
    isPending: liveFunnelPending,
    isError: liveFunnelIsError,
  } = useLiveFunnelPresence(liveFunnelCompanyId);

  useEffect(() => {
    // No agregado global, qualquer evento de qualquer unidade causaria uma
    // invalidação em massa. O polling mantém esse contexto atualizado sem
    // abrir uma assinatura global de alto volume.
    if (!effectiveCompanyId) return undefined;

    let channel = supabase
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
          if (showCompanyReportOverview) {
            queryClient.invalidateQueries({ queryKey: ['dashboard-reservations-created'] });
          }
        },
      );

    if (showCompanyReportOverview) {
      channel = channel.on(
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
      );
    }

    channel = channel.subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [effectiveCompanyId, queryClient, showCompanyReportOverview]);

  const dominantReservationOrigin = reservationOriginBreakdown.items.reduce<
    (typeof reservationOriginBreakdown.items)[number] | undefined
  >(
    (dominant, item) => (!dominant || item.value > dominant.value ? item : dominant),
    undefined,
  );
  const lastDataSyncAt = Math.max(dashboardUpdatedAt || 0, liveFunnelUpdatedAt || 0);
  const hasFreshnessData = lastDataSyncAt > 0;
  const dataLagMs = hasFreshnessData ? Date.now() - lastDataSyncAt : 0;
  const dataIsStale = hasFreshnessData && dataLagMs > 45000;
  const dataIsSyncing = dashFetching || liveFunnelFetching;
  const dashboardHasVisibleError = Boolean(
    dashboardOperationalIsError || dashboardReportOverviewIsError || liveFunnelIsError,
  );
  const freshnessLabel = dashboardHasVisibleError
    ? 'Erro parcial'
    : dataIsSyncing
      ? 'Sincronizando'
      : dataIsStale
        ? 'Dados com atraso'
        : 'Atualizado';

  const periodLabel = comparisonLabel;
  const currentPeriodRangeLabel = formatComparisonPeriodRangeLabel(startDate, endDate);
  const comparisonPeriodRangeLabel = formatComparisonPeriodRangeLabel(comparisonStartDate, comparisonEndDate);
  const comparisonBadgeContext = {
    comparisonLabel: periodLabel,
    comparisonPeriodLabel: comparisonPeriodRangeLabel,
    currentPeriodLabel: currentPeriodRangeLabel,
  };
  const waitlistConversionRate = waitlistTotals.total > 0
    ? Math.round((waitlistTotals.seated / waitlistTotals.total) * 100)
    : 0;
  const reservationVolumeIsPeople = reservationVolumeMetric === 'people';
  const reservationVolumeMetricLabel = reservationVolumeIsPeople ? 'Pessoas' : 'Reservas';
  const reservationVolumeMetricLabelLower = reservationVolumeIsPeople ? 'pessoas' : 'reservas';
  const reservationVolumeChartData = useMemo(
    () => dailyStats.map((day) => ({
      date: day.date,
      label: day.label,
      value: reservationVolumeIsPeople ? day.activeGuests : day.activeReservations,
    })),
    [dailyStats, reservationVolumeIsPeople],
  );
  const reservationVolumeSummary = useMemo(() => {
    const total = reservationVolumeChartData.reduce((sum, day) => sum + day.value, 0);
    const peakDay = reservationVolumeChartData.reduce<(typeof reservationVolumeChartData)[number] | null>(
      (peak, day) => (!peak || day.value > peak.value ? day : peak),
      null,
    );

    return {
      total,
      averagePerDay: reservationVolumeChartData.length > 0
        ? total / reservationVolumeChartData.length
        : 0,
      peakDay: peakDay && peakDay.value > 0 ? peakDay : null,
    };
  }, [reservationVolumeChartData]);
  const reservationVolumeAverageLabel = reservationVolumeSummary.averagePerDay.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const attendanceOverviewRate = totals.reservations > 0
    ? Math.round((totals.completed / totals.reservations) * 100)
    : 0;
  // Granularidade mensal: o card só precisa dos totais do período, então buscamos o menor payload possível.
  const recurrenceVisitSeries = useCustomerRecurrenceVisitSeries({
    companyId: showCompanyReportOverview ? companyContext?.companyId : undefined,
    periodStart: format(startDate, 'yyyy-MM-dd'),
    periodEnd: format(endDate, 'yyyy-MM-dd'),
    granularity: 'month',
    includeCompanions: false,
    enabled: showCompanyReportOverview && hasPermission('leads_view'),
  });
  const recurrenceOverview = useMemo(() => {
    const series = recurrenceVisitSeries.data?.series;
    if (!series?.length) return null;

    const totalsByVisit = series.reduce(
      (acc, point) => ({
        totalVisits: acc.totalVisits + point.total_visits,
        firstVisits: acc.firstVisits + point.first_visits,
        returnVisits: acc.returnVisits + point.return_visits,
      }),
      { totalVisits: 0, firstVisits: 0, returnVisits: 0 },
    );

    return {
      ...totalsByVisit,
      returnRate: totalsByVisit.totalVisits > 0
        ? (totalsByVisit.returnVisits / totalsByVisit.totalVisits) * 100
        : 0,
    };
  }, [recurrenceVisitSeries.data]);
  const attendanceOverviewLosses = totals.noShows + totals.cancellations;
  // Reservas do período que ainda não receberam desfecho (nem check-in, nem no-show, nem cancelamento).
  const attendanceOverviewPending = Math.max(
    totals.reservations - totals.completed - attendanceOverviewLosses,
    0,
  );
  const dailyCapacityHasCapacity = dailyCapacityTotals.totalCapacity > 0;
  const dailyCapacityIdleSeats = Math.max(
    dailyCapacityTotals.totalCapacity - dailyCapacityTotals.checkedInGuests,
    0,
  );
  const reportSearch = useMemo(
    () => buildDashboardReportSearch({ period, startDate, endDate }),
    [endDate, period, startDate],
  );

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant={dashboardHasVisibleError || dataIsStale ? 'destructive' : dataIsSyncing ? 'secondary' : 'outline'}
                    className="gap-1.5"
                    tabIndex={0}
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                  >
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
                    {dashboardHasVisibleError ? ' Parte dos dados não pôde ser atualizada neste momento.' : ''}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="text-muted-foreground mt-1">Análise de reservas em tempo real</p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
          {!isCompanyContext && (
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-full sm:w-[200px]" aria-label="Unidade analisada">
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
            <SelectTrigger className="w-full sm:w-[220px]" aria-label="Período da dashboard">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DASHBOARD_PERIOD_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {period === 'custom' && (
            <DateRangePicker
              value={customRange}
              onChange={setCustomRange}
              className="w-full sm:w-[280px]"
            />
          )}

        </div>
      </div>

      {liveFunnelCompanyId && (
        <LiveFunnelPanel
          data={liveFunnelPresence?.stages ?? []}
          totalActive={liveFunnelPresence?.totalActive ?? 0}
          windowMinutes={liveFunnelPresence?.windowMinutes ?? 5}
          isLoading={liveFunnelPending}
          isUnavailable={liveFunnelIsError && !liveFunnelPresence}
        />
      )}

      {dashLoading || isInitialFeatureFlagsLoading ? (
        <div className="space-y-4" role="status" aria-label="Carregando dados da Dashboard">
          <span className="sr-only">Carregando dados da Dashboard…</span>
          <div aria-hidden="true" className="space-y-4">
            <div className="h-[140px] animate-pulse rounded-xl border border-border bg-muted/60 motion-reduce:animate-none" />
            <div className="h-[230px] animate-pulse rounded-xl border border-border bg-muted/60 motion-reduce:animate-none" />
            {advancedReportsEnabled && (
              <div className="h-[360px] animate-pulse rounded-xl border border-border bg-muted/60 motion-reduce:animate-none" />
            )}
            {showCompanyReportOverview && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-[180px] animate-pulse rounded-2xl border border-border bg-muted/60 motion-reduce:animate-none"
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : dashboardOperationalIsError ? (
        <Card className="border border-destructive/25 bg-destructive/5 shadow-sm" role="alert">
          <CardContent className="flex flex-col items-start gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <CircleAlert className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Não foi possível carregar a Dashboard</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Os dados operacionais não serão exibidos como zero. Tente novamente em instantes.
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetchDashboard()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI — linha 1: equação de atendimentos + pessoas */}
          <Card className="border border-border shadow-sm">
            <CardContent className="py-4">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CalendarIcon className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Resumo de Atendimentos</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Baseado na data da reserva/atendimento, não na data de criação.
                  </p>
                </div>
                <p className="text-xs text-muted-foreground sm:pt-0.5">Comparativo vs. {periodLabel}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-stretch sm:gap-2">
                {/* Reservas */}
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-3 sm:flex-1 sm:gap-3 sm:px-3">
                  <div className="shrink-0 rounded-md bg-muted p-2 text-primary sm:p-2.5">
                    <CalendarCheck className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <p className="text-lg font-bold leading-none sm:text-xl">{totals.scheduledReservations.toLocaleString('pt-BR')}</p>
                      <VariationBadge
                        {...comparisonBadgeContext}
                        current={totals.scheduledReservations}
                        metricLabel="Reservas"
                        previous={prevTotals.scheduledReservations}
                        valuePlural="reservas agendadas"
                        valueSingular="reserva agendada"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Reservas
                    </p>
                  </div>
                </div>

                <div className="hidden items-center px-1 text-lg font-semibold text-muted-foreground sm:flex">+</div>

                {/* Fila convertida */}
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-3 sm:flex-1 sm:gap-3 sm:px-3">
                  <div className="shrink-0 rounded-md bg-muted p-2 text-success sm:p-2.5">
                    <ClipboardList className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <p className="text-lg font-bold leading-none sm:text-xl">{totals.waitlistReservations.toLocaleString('pt-BR')}</p>
                      <VariationBadge
                        {...comparisonBadgeContext}
                        current={totals.waitlistReservations}
                        metricLabel="Fila convertida"
                        previous={prevTotals.waitlistReservations}
                        valuePlural="atendimentos da fila"
                        valueSingular="atendimento da fila"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fila convertida
                    </p>
                  </div>
                </div>

                <div className="hidden items-center px-1 text-lg font-semibold text-muted-foreground sm:flex">=</div>

                {/* Atendimentos */}
                <div className="flex min-w-0 items-center gap-2 rounded-lg border-2 border-primary/30 bg-primary/5 px-2.5 py-3 sm:flex-1 sm:gap-3 sm:px-3">
                  <div className="shrink-0 rounded-md bg-muted p-2 text-info sm:p-2.5">
                    <CalendarIcon className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <p className="text-lg font-bold leading-none sm:text-xl">{totals.reservations.toLocaleString('pt-BR')}</p>
                      <VariationBadge
                        {...comparisonBadgeContext}
                        current={totals.reservations}
                        metricLabel="Atendimentos"
                        previous={prevTotals.reservations}
                        valuePlural="atendimentos"
                        valueSingular="atendimento"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Atendimentos
                    </p>
                  </div>
                </div>

                {/* Pessoas */}
                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-3 sm:flex-1 sm:gap-3 sm:px-3">
                  <div className="shrink-0 rounded-md bg-muted p-2 text-info sm:p-2.5">
                    <Users className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <p className="text-lg font-bold leading-none sm:text-xl">{totals.totalGuests.toLocaleString('pt-BR')}</p>
                      <VariationBadge
                        {...comparisonBadgeContext}
                        current={totals.totalGuests}
                        metricLabel="Pessoas"
                        previous={prevTotals.totalGuests}
                        valuePlural="pessoas"
                        valueSingular="pessoa"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Pessoas
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Conversion Funnel */}
          {(
            <Card className="border border-border shadow-sm">
              <CardContent className="py-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-primary" />
                      <p className="text-sm font-medium text-foreground">Funil de Conversão</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Reservas e pessoas agrupadas pela data em que a visita estava agendada.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground sm:pt-0.5">Comparativo vs. {periodLabel}</p>
                </div>
                <div className="space-y-3">
                  {/* Linha 1: Reservas */}
                  {(() => {
                    const total = totals.reservations;
                    const checkIns = totals.completed;
                    const noShows = totals.noShows;
                    const cancelled = totals.cancellations;
                    const pctCheckIn = total > 0 ? Math.round((checkIns / total) * 100) : 0;
                    const pctNoShow = total > 0 ? Math.round((noShows / total) * 100) : 0;
                    const pctCancelled = total > 0 ? Math.round((cancelled / total) * 100) : 0;
                    return (
                      <div>
                        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Reservas</p>
                        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                          <div className="flex w-full flex-col items-center rounded-lg border border-border bg-muted/40 px-3 py-2 sm:w-auto sm:min-w-[110px]">
                            <span className="text-lg font-bold leading-none text-foreground">{total.toLocaleString('pt-BR')}</span>
                            <span className="mt-0.5 text-[11px] text-muted-foreground">Agendamentos</span>
                          </div>
                          <div className="flex items-center justify-center gap-1 sm:flex-1">
                            <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">{pctCheckIn}%</span>
                            <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                          </div>
                          <div className="flex w-full flex-col items-center rounded-lg border border-success/40 bg-success-soft px-3 py-2 sm:w-auto sm:min-w-[132px]">
                            <div className="flex items-center justify-center gap-1.5">
                              <span className="text-lg font-bold leading-none text-success">{checkIns.toLocaleString('pt-BR')}</span>
                              <VariationBadge
                                {...comparisonBadgeContext}
                                current={checkIns}
                                metricLabel="Check-ins"
                                previous={prevTotals.completed}
                                valuePlural="check-ins"
                                valueSingular="check-in"
                              />
                            </div>
                            <span className="mt-0.5 text-[11px] text-muted-foreground">Check-ins</span>
                          </div>
                          {noShows > 0 && (
                            <>
                              <div className="flex items-center justify-center gap-1 sm:flex-1">
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                                <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">{pctNoShow}%</span>
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                              </div>
                              <div className="flex w-full flex-col items-center rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 sm:w-auto sm:min-w-[132px]">
                                <div className="flex items-center justify-center gap-1.5">
                                  <span className="text-lg font-bold leading-none text-destructive">{noShows.toLocaleString('pt-BR')}</span>
                                  <VariationBadge
                                    {...comparisonBadgeContext}
                                    current={noShows}
                                    goodWhenDecreases
                                    metricLabel="Não compareceram"
                                    previous={prevTotals.noShows}
                                    valuePlural="não comparecimentos"
                                    valueSingular="não comparecimento"
                                  />
                                </div>
                                <span className="mt-0.5 text-[11px] text-muted-foreground">Não compareceram</span>
                              </div>
                            </>
                          )}
                          {cancelled > 0 && (
                            <>
                              <div className="flex items-center justify-center gap-1 sm:flex-1">
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{pctCancelled}%</span>
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                              </div>
                              <div className="flex w-full flex-col items-center rounded-lg border border-border bg-muted/40 px-3 py-2 sm:w-auto sm:min-w-[132px]">
                                <div className="flex items-center justify-center gap-1.5">
                                  <span className="text-lg font-bold leading-none text-foreground">{cancelled.toLocaleString('pt-BR')}</span>
                                  <VariationBadge
                                    {...comparisonBadgeContext}
                                    current={cancelled}
                                    goodWhenDecreases
                                    metricLabel="Cancelados"
                                    previous={prevTotals.cancellations}
                                    valuePlural="cancelamentos"
                                    valueSingular="cancelamento"
                                  />
                                </div>
                                <span className="mt-0.5 text-[11px] text-muted-foreground">Cancelados</span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {/* Linha 2: Pessoas */}
                  {(() => {
                    const totalGuests = totals.totalGuests;
                    const checkedInGuests = totals.checkedInGuests;
                    const noShowGuests = totals.noShowGuests;
                    const cancelledGuests = totals.cancelledGuests;
                    const pctGuests = totalGuests > 0 ? Math.round((checkedInGuests / totalGuests) * 100) : 0;
                    const pctNoShowGuests = totalGuests > 0 ? Math.round((noShowGuests / totalGuests) * 100) : 0;
                    const pctCancelledGuests = totalGuests > 0 ? Math.round((cancelledGuests / totalGuests) * 100) : 0;
                    return (
                      <div>
                        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pessoas</p>
                        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                          <div className="flex w-full flex-col items-center rounded-lg border border-border bg-muted/40 px-3 py-2 sm:w-auto sm:min-w-[110px]">
                            <span className="text-lg font-bold leading-none text-foreground">{totalGuests.toLocaleString('pt-BR')}</span>
                            <span className="mt-0.5 text-[11px] text-muted-foreground">Programadas</span>
                          </div>
                          <div className="flex items-center justify-center gap-1 sm:flex-1">
                            <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">{pctGuests}%</span>
                            <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                          </div>
                          <div className="flex w-full flex-col items-center rounded-lg border border-success/40 bg-success-soft px-3 py-2 sm:w-auto sm:min-w-[132px]">
                            <div className="flex items-center justify-center gap-1.5">
                              <span className="text-lg font-bold leading-none text-success">{checkedInGuests.toLocaleString('pt-BR')}</span>
                              <VariationBadge
                                {...comparisonBadgeContext}
                                current={checkedInGuests}
                                metricLabel="Pessoas que compareceram"
                                previous={prevTotals.checkedInGuests}
                                valuePlural="pessoas"
                                valueSingular="pessoa"
                              />
                            </div>
                            <span className="mt-0.5 text-[11px] text-muted-foreground">Compareceram</span>
                          </div>
                          {noShowGuests > 0 && (
                            <>
                              <div className="flex items-center justify-center gap-1 sm:flex-1">
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                                <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">{pctNoShowGuests}%</span>
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                              </div>
                              <div className="flex w-full flex-col items-center rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 sm:w-auto sm:min-w-[132px]">
                                <div className="flex items-center justify-center gap-1.5">
                                  <span className="text-lg font-bold leading-none text-destructive">{noShowGuests.toLocaleString('pt-BR')}</span>
                                  <VariationBadge
                                    {...comparisonBadgeContext}
                                    current={noShowGuests}
                                    goodWhenDecreases
                                    metricLabel="Pessoas que não compareceram"
                                    previous={prevTotals.noShowGuests}
                                    valuePlural="pessoas"
                                    valueSingular="pessoa"
                                  />
                                </div>
                                <span className="mt-0.5 text-[11px] text-muted-foreground">Não compareceram</span>
                              </div>
                            </>
                          )}
                          {cancelledGuests > 0 && (
                            <>
                              <div className="flex items-center justify-center gap-1 sm:flex-1">
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{pctCancelledGuests}%</span>
                                <div className="h-px w-4 bg-border sm:h-0.5 sm:flex-1 sm:w-auto" />
                              </div>
                              <div className="flex w-full flex-col items-center rounded-lg border border-border bg-muted/40 px-3 py-2 sm:w-auto sm:min-w-[132px]">
                                <div className="flex items-center justify-center gap-1.5">
                                  <span className="text-lg font-bold leading-none text-foreground">{cancelledGuests.toLocaleString('pt-BR')}</span>
                                  <VariationBadge
                                    {...comparisonBadgeContext}
                                    current={cancelledGuests}
                                    goodWhenDecreases
                                    metricLabel="Pessoas canceladas"
                                    previous={prevTotals.cancelledGuests}
                                    valuePlural="pessoas"
                                    valueSingular="pessoa"
                                  />
                                </div>
                                <span className="mt-0.5 text-[11px] text-muted-foreground">Cancelados</span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </CardContent>
            </Card>
          )}


          {advancedReportsEnabled && (
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      <SectionTitle
                        title="Reservas por dia"
                        tooltip="Mostra somente reservas ativas — confirmadas ou com check-in — agrupadas pela data da visita. Alterne entre Reservas e Pessoas; a linha tracejada indica a média diária da métrica selecionada no período."
                      />
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Reservas ativas pela data da visita no período selecionado.
                    </CardDescription>
                  </div>
                  <div
                    className="inline-flex w-fit items-center rounded-md border border-border bg-muted/20 p-0.5"
                    role="group"
                    aria-label="Alternar métrica do gráfico"
                  >
                    {(['reservations', 'people'] as const).map((metric) => (
                      <button
                        key={metric}
                        type="button"
                        aria-pressed={reservationVolumeMetric === metric}
                        onClick={() => setReservationVolumeMetric(metric)}
                        className={cn(
                          'touch-manipulation rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                          reservationVolumeMetric === metric
                            ? 'bg-card text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {metric === 'reservations' ? 'Reservas' : 'Pessoas'}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-3">
                  <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">
                      {reservationVolumeIsPeople ? 'Pessoas em reservas ativas' : 'Reservas ativas'}
                    </p>
                    <p className="text-lg font-semibold leading-tight tabular-nums text-foreground">
                      {reservationVolumeSummary.total.toLocaleString('pt-BR')}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
                    <p className="text-[11px] text-muted-foreground">Média/dia no período</p>
                    <p className="text-lg font-semibold leading-tight tabular-nums text-foreground">
                      {reservationVolumeAverageLabel}
                    </p>
                  </div>
                  <div className="col-span-2 min-w-0 rounded-lg border border-border bg-muted/15 px-3 py-2 lg:col-span-1">
                    <p className="text-[11px] text-muted-foreground">Dia de pico</p>
                    <p className="text-lg font-semibold leading-tight tabular-nums text-foreground">
                      {reservationVolumeSummary.peakDay?.label ?? '—'}
                    </p>
                    {reservationVolumeSummary.peakDay && (
                      <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
                        {reservationVolumeSummary.peakDay.value.toLocaleString('pt-BR')} {reservationVolumeMetricLabelLower}
                      </p>
                    )}
                  </div>
                </div>

                {reservationVolumeSummary.total > 0 ? (
                  <>
                    <table className="sr-only">
                      <caption>{reservationVolumeMetricLabel} em reservas ativas por data da visita</caption>
                      <thead>
                        <tr>
                          <th scope="col">Data</th>
                          <th scope="col">{reservationVolumeMetricLabel}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reservationVolumeChartData.map((day) => (
                          <tr key={day.date}>
                            <th scope="row">{day.label}</th>
                            <td>{day.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          accessibilityLayer
                          data={reservationVolumeChartData}
                          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                          <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(28, 85%, 55%)" />
                          <RechartsTooltip
                            content={({ active, payload, label }: any) => {
                              if (!active || !payload?.length) return null;

                              const point = payload[0]?.payload;
                              if (!point) return null;

                              return (
                                <div className="rounded-lg border border-border bg-card p-3 text-sm shadow-md">
                                  <p className="font-semibold text-foreground">{label}</p>
                                  <p className="text-[11px] text-muted-foreground">Data da visita</p>
                                  <div className="mt-2 space-y-1 text-muted-foreground">
                                    <p>
                                      {reservationVolumeMetricLabel}:{' '}
                                      <span className="font-medium text-primary">
                                        {(point.value ?? 0).toLocaleString('pt-BR')}
                                      </span>
                                    </p>
                                    <p>
                                      Média diária:{' '}
                                      <span className="font-medium text-info">{reservationVolumeAverageLabel}</span>
                                    </p>
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <ReferenceLine
                            y={reservationVolumeSummary.averagePerDay}
                            isFront
                            stroke="hsl(202, 89%, 48%)"
                            strokeDasharray="6 4"
                            strokeWidth={2}
                            ifOverflow="extendDomain"
                            label={{
                              value: `Média ${reservationVolumeAverageLabel}`,
                              position: 'insideTopRight',
                              fill: 'hsl(202, 89%, 38%)',
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          />
                          <Bar
                            dataKey="value"
                            name={reservationVolumeMetricLabel}
                            fill="hsl(var(--primary))"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={46}
                            isAnimationActive={!prefersReducedMotion}
                            animationDuration={500}
                            animationEasing="ease-out"
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                ) : (
                  <div
                    role="status"
                    className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 px-4 text-center"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Nenhuma reserva ativa no período
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Altere o período da dashboard para consultar outras datas.
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {showCompanyReportOverview && companyContext && (
            dashboardReportOverviewIsError ? (
              <Card className="border border-destructive/20 bg-destructive/5 shadow-sm" role="alert">
                <CardContent className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Resumo dos relatórios indisponível</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Os indicadores operacionais acima continuam válidos.
                      </p>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void refetchDashboard()}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Tentar novamente
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <DashboardReportOverview
              slug={companyContext.slug}
              search={reportSearch}
              canViewRecurrence={hasPermission('leads_view')}
              demand={{
                createdReservations: createdReservationTotals.totalCreated,
                scheduledCreated: createdReservationTotals.scheduledCreated,
                sameDayReservations: createdReservationTotals.sameDayReservations,
                waitlistCreated: createdReservationTotals.waitlistCreated,
                averageLeadDays: createdReservationTotals.avgLeadDays,
                dominantEntryLabel: dominantReservationOrigin?.value
                  ? dominantReservationOrigin.label
                  : undefined,
                dominantEntryPercentage: dominantReservationOrigin?.value
                  ? dominantReservationOrigin.percentage
                  : undefined,
              }}
              attendance={{
                realizationRate: attendanceOverviewRate,
                losses: attendanceOverviewLosses,
                noShows: totals.noShows,
                cancellations: totals.cancellations,
                pending: attendanceOverviewPending,
              }}
              capacity={{
                hasCapacity: dailyCapacityHasCapacity,
                occupancyRate: dailyCapacityTotals.occupancyRate,
                pressureDays: dailyCapacityTotals.fullDays + dailyCapacityTotals.overCapacityDays,
                idleSeats: dailyCapacityIdleSeats,
              }}
              waitlist={{
                entries: waitlistTotals.total,
                conversionRate: waitlistConversionRate,
                averageWaitMinutes: waitlistTotals.avgWaitMin,
                dropped: waitlistTotals.expired,
              }}
              recurrence={recurrenceOverview}
              recurrenceStatus={
                recurrenceVisitSeries.isLoading
                  ? 'loading'
                  : recurrenceVisitSeries.isError
                    ? 'error'
                    : recurrenceOverview
                      ? 'ready'
                      : 'empty'
              }
              />
            )
          )}
        </>
      )}
    </div>
  );
}
