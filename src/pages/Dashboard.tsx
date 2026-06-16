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
  BarChart, Bar, Cell, ComposedChart, Line, Pie, PieChart, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import {
  CalendarCheck, Users, TrendingUp, CalendarIcon,
  ArrowUpRight, ArrowDownRight, Minus, ClipboardList, Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useFunnelData } from '@/hooks/useFunnelData';
import { useLiveFunnelPresence } from '@/hooks/useLiveFunnelPresence';
import { useDashboardData } from '@/hooks/useDashboardData';
import LiveFunnelPanel from '@/components/LiveFunnelPanel';
import ReservationFunnelChart from '@/components/ReservationFunnelChart';
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

const DAILY_CAPACITY_STATUS_META = {
  below: {
    label: 'Abaixo da capacidade',
    color: 'hsl(145, 63%, 42%)',
  },
  full: {
    label: 'Lotado',
    color: 'hsl(28, 85%, 55%)',
  },
  over: {
    label: 'Acima da capacidade',
    color: 'hsl(0, 72%, 51%)',
  },
  no_capacity: {
    label: 'Sem capacidade',
    color: 'hsl(0, 0%, 45%)',
  },
} as const;

function formatDashboardDateRangeLabel(range: DateRange | undefined) {
  if (!range?.from) {
    return 'Selecionar período';
  }

  if (!range.to) {
    return `${format(range.from, 'dd/MM/yyyy')} - ...`;
  }

  return `${format(range.from, 'dd/MM/yyyy')} - ${format(range.to, 'dd/MM/yyyy')}`;
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

  const [companyId, setCompanyId] = useState<string>('all');
  const [period, setPeriod] = useState('this_month');
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [uniqueFunnelOnly, setUniqueFunnelOnly] = useState(false);
  const [adsFunnelOnly, setAdsFunnelOnly] = useState(false);
  const [expectedVsActualMetric, setExpectedVsActualMetric] = useState<'reservations' | 'people'>('reservations');

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

  const {
    dailyStats,
    dailyCapacityStats,
    dailyCapacityTotals,
    createdReservationDailyStats,
    reservationLeadTrend,
    createdReservationTotals,
    reservationOriginBreakdown,
    reservationOriginDailyStats,
    waitlistDailyStats,
    totals,
    prevTotals,
    waitlistTotals,
    isLoading: dashLoading,
    isFetching: dashFetching,
    lastUpdatedAt: dashboardUpdatedAt,
  } = useDashboardData(effectiveCompanyId, startDate, endDate, comparisonStartDate, comparisonEndDate);

  const funnelCompanyId = isCompanyContext ? companyContext?.companyId : (companyId !== 'all' ? companyId : undefined);
  const {
    data: funnelResult,
    dataUpdatedAt: funnelUpdatedAt = 0,
    isFetching: funnelFetching,
  } = useFunnelData(funnelCompanyId, startDate, endDate, uniqueFunnelOnly, adsFunnelOnly);
  const funnelData = funnelResult?.points ?? [];
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
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient, effectiveCompanyId]);

  const advancedReportsEnabled = !isCompanyContext || !!featureFlags?.features.advanced_reports;
  const visibleReservationOriginItems = useMemo(
    () => reservationOriginBreakdown.items.filter((item) => item.value > 0),
    [reservationOriginBreakdown.items],
  );
  const funnelDescription = isCompanyContext
    ? 'Conversão por etapa considerando sessões e jornadas do processo de reserva'
    : 'Conversão agregada de todas as unidades considerando sessões e jornadas';
  const lastDataSyncAt = Math.max(dashboardUpdatedAt || 0, funnelUpdatedAt || 0, liveFunnelUpdatedAt || 0);
  const hasFreshnessData = lastDataSyncAt > 0;
  const dataLagMs = hasFreshnessData ? Date.now() - lastDataSyncAt : 0;
  const dataIsStale = hasFreshnessData && dataLagMs > 45000;
  const dataIsSyncing = dashFetching || funnelFetching || liveFunnelFetching;
  const freshnessLabel = dataIsSyncing ? 'Sincronizando' : dataIsStale ? 'Dados com atraso' : 'Tempo real';
  const isInitialFeatureFlagsLoading = isCompanyContext && featureFlagsLoading && !featureFlags;

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
  const expectedVsActualDailyStats = useMemo(
    () => dailyStats.map((day) => {
      const expected = day.reservations;
      const accounted = day.completed + day.noShows + day.cancellations;
      const pending = Math.max(expected - accounted, 0);

      const expectedGuests = day.totalGuests;
      const accountedGuests = day.completedGuests + day.noShowGuests + day.cancelledGuests;
      const pendingGuests = Math.max(expectedGuests - accountedGuests, 0);

      return {
        ...day,
        expected,
        pending,
        realizedRate: expected > 0 ? Math.round((day.completed / expected) * 100) : 0,
        expectedGuests,
        pendingGuests,
        realizedRateGuests: expectedGuests > 0 ? Math.round((day.completedGuests / expectedGuests) * 100) : 0,
      };
    }),
    [dailyStats],
  );
  const expectedVsActualTotals = useMemo(
    () => {
      const totalsByStatus = expectedVsActualDailyStats.reduce(
        (acc, day) => ({
          cancellations: acc.cancellations + day.cancellations,
          completed: acc.completed + day.completed,
          expected: acc.expected + day.expected,
          noShows: acc.noShows + day.noShows,
          pending: acc.pending + day.pending,
          cancelledGuests: acc.cancelledGuests + day.cancelledGuests,
          completedGuests: acc.completedGuests + day.completedGuests,
          expectedGuests: acc.expectedGuests + day.expectedGuests,
          noShowGuests: acc.noShowGuests + day.noShowGuests,
          pendingGuests: acc.pendingGuests + day.pendingGuests,
        }),
        {
          cancellations: 0,
          completed: 0,
          expected: 0,
          noShows: 0,
          pending: 0,
          cancelledGuests: 0,
          completedGuests: 0,
          expectedGuests: 0,
          noShowGuests: 0,
          pendingGuests: 0,
        },
      );

      return {
        ...totalsByStatus,
        realizedRate: totalsByStatus.expected > 0
          ? Math.round((totalsByStatus.completed / totalsByStatus.expected) * 100)
          : 0,
        realizedRateGuests: totalsByStatus.expectedGuests > 0
          ? Math.round((totalsByStatus.completedGuests / totalsByStatus.expectedGuests) * 100)
          : 0,
      };
    },
    [expectedVsActualDailyStats],
  );

  const expectedVsActualIsPeople = expectedVsActualMetric === 'people';
  const expectedVsActualConfig = expectedVsActualIsPeople
    ? {
        completedLabel: 'Compareceram',
        completedTotal: expectedVsActualTotals.completedGuests,
        expectedTotal: expectedVsActualTotals.expectedGuests,
        lossesTotal: expectedVsActualTotals.noShowGuests + expectedVsActualTotals.cancelledGuests,
        rateTotal: expectedVsActualTotals.realizedRateGuests,
      }
    : {
        completedLabel: 'Check-ins',
        completedTotal: expectedVsActualTotals.completed,
        expectedTotal: expectedVsActualTotals.expected,
        lossesTotal: expectedVsActualTotals.noShows + expectedVsActualTotals.cancellations,
        rateTotal: expectedVsActualTotals.realizedRate,
      };
  // Chaves estáveis com valores conforme o modo: o Recharts interpola a altura das barras
  // (morph) ao alternar Reservas ⇄ Pessoas, em vez de redesenhar do zero.
  const expectedVsActualChartData = useMemo(() => {
    const isPeople = expectedVsActualMetric === 'people';
    return expectedVsActualDailyStats.map((day) => ({
      label: day.label,
      expected: isPeople ? day.expectedGuests : day.expected,
      completed: isPeople ? day.completedGuests : day.completed,
      noShows: isPeople ? day.noShowGuests : day.noShows,
      cancellations: isPeople ? day.cancelledGuests : day.cancellations,
      pending: isPeople ? day.pendingGuests : day.pending,
      realizedRate: isPeople ? day.realizedRateGuests : day.realizedRate,
    }));
  }, [expectedVsActualDailyStats, expectedVsActualMetric]);
  const dailyCapacityHasCapacity = dailyCapacityTotals.totalCapacity > 0;

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
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
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
          {!isCompanyContext && (
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-full sm:w-[200px]">
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
            <SelectTrigger className="w-full sm:w-[220px]">
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

      {funnelCompanyId && liveFunnelPresence && (
        <LiveFunnelPanel
          data={liveFunnelPresence.stages}
          totalActive={liveFunnelPresence.totalActive}
          windowMinutes={liveFunnelPresence.windowMinutes}
        />
      )}

      {dashLoading || isInitialFeatureFlagsLoading ? (
        <>
          {/* KPI skeleton */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 [&>*]:min-w-0">
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
          <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <div className="lg:col-span-2 h-72 animate-pulse rounded-md border border-border bg-muted" />
            <div className="h-72 animate-pulse rounded-md border border-border bg-muted" />
          </div>
          <div className="grid gap-6 [&>*]:min-w-0">
            <div className="h-56 animate-pulse rounded-md border border-border bg-muted" />
            <div className="h-56 animate-pulse rounded-md border border-border bg-muted" />
          </div>
        </>
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

          <Card className="hidden border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <SectionTitle
                  title="Origem das Reservas"
                  tooltip="Classifica todas as reservas do período em uma única origem: Direta/Orgânica, Ads, Filiado, Manual ou Waitlist."
                />
              </CardTitle>
              <CardDescription>
                A soma das categorias fecha exatamente em {reservationOriginBreakdown.total.toLocaleString('pt-BR')} reservas no período selecionado.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {reservationOriginBreakdown.total > 0 ? (
                <div className="space-y-6">
                  <div className="hidden relative h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={visibleReservationOriginItems}
                          dataKey="value"
                          nameKey="label"
                          innerRadius={72}
                          outerRadius={104}
                          paddingAngle={2}
                          stroke="hsl(var(--background))"
                          strokeWidth={2}
                        >
                          {visibleReservationOriginItems.map((item) => (
                            <Cell key={item.key} fill={item.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: 'hsl(0, 0%, 100%)',
                            border: '1px solid hsl(0, 0%, 88%)',
                            borderRadius: '0.5rem',
                            fontSize: '0.875rem',
                          }}
                          formatter={(value, name, context) => [
                            `${Number(value).toLocaleString('pt-BR')} reserva${Number(value) === 1 ? '' : 's'} (${Number(context?.payload?.percentage ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`,
                            name,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Total</span>
                      <span className="text-3xl font-semibold text-foreground">
                        {reservationOriginBreakdown.total.toLocaleString('pt-BR')}
                      </span>
                      <span className="text-xs text-muted-foreground">reservas</span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {reservationOriginBreakdown.items.map((item) => (
                        <div
                          key={item.key}
                          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 p-3"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className="h-3 w-3 shrink-0 rounded-full"
                              style={{ backgroundColor: item.color }}
                              aria-hidden="true"
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">{item.label}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.percentage.toLocaleString('pt-BR', {
                                  minimumFractionDigits: 1,
                                  maximumFractionDigits: 1,
                                })}
                                %
                              </p>
                            </div>
                          </div>
                          <p className="shrink-0 text-lg font-semibold text-foreground">
                            {item.value.toLocaleString('pt-BR')}
                          </p>
                        </div>
                      ))}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Ads entra quando existe UTM pago ou clique Meta identificado por fbclid/fbc. _fbp sozinho não classifica como Ads.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
                  Sem reservas no período para classificar por origem.
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                <SectionTitle
                  title="Fila de Espera por Dia"
                  tooltip="Mostra, por dia, quantas pessoas entraram na fila, quantas foram atendidas, quantas saíram sem sentar e o tempo médio de espera. Agrupado pela data de entrada na fila."
                />
              </CardTitle>
              <CardDescription>
                Cada linha usa o dia em que o evento realmente aconteceu.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: 'hsl(28, 85%, 55%)' }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-muted-foreground">Entradas</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {waitlistTotals.total.toLocaleString('pt-BR')}
                  </span>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: 'hsl(145, 63%, 42%)' }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-muted-foreground">Sentados</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {waitlistTotals.seated.toLocaleString('pt-BR')}
                  </span>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: 'hsl(0, 72%, 51%)' }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-muted-foreground">Desistências</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {waitlistTotals.expired.toLocaleString('pt-BR')}
                  </span>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full bg-foreground/45"
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-muted-foreground">Conversão</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {waitlistConversionRate.toLocaleString('pt-BR')}%
                  </span>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: 'hsl(202, 89%, 48%)' }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-xs text-muted-foreground">Espera média</span>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {waitlistTotals.avgWaitMin.toLocaleString('pt-BR')}min
                  </span>
                </div>
              </div>

              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={waitlistDailyStats}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <YAxis yAxisId="count" allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                    <YAxis
                      yAxisId="wait"
                      orientation="right"
                      tick={{ fontSize: 12 }}
                      stroke="hsl(202, 89%, 48%)"
                      tickFormatter={(value: number) => `${value}m`}
                    />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: 'hsl(0, 0%, 100%)', border: '1px solid hsl(0, 0%, 88%)', borderRadius: '0.5rem', fontSize: '0.875rem' }}
                      formatter={(value: number, name: string) => {
                        if (name === 'Tempo médio de espera') {
                          return [`${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} min`, name];
                        }

                        return [`${value} cliente${value === 1 ? '' : 's'}`, name];
                      }}
                    />
                    <Legend />
                    <Line
                      yAxisId="count"
                      type="monotone"
                      dataKey="entries"
                      name="Entradas na fila"
                      stroke="hsl(28, 85%, 55%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      yAxisId="count"
                      type="monotone"
                      dataKey="seated"
                      name="Sentados"
                      stroke="hsl(145, 63%, 42%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      yAxisId="count"
                      type="monotone"
                      dataKey="dropped"
                      name="Desistências"
                      stroke="hsl(0, 72%, 51%)"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      yAxisId="wait"
                      type="monotone"
                      dataKey="avgWaitMin"
                      name="Tempo médio de espera"
                      stroke="hsl(202, 89%, 48%)"
                      strokeWidth={2.5}
                      strokeDasharray="6 4"
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {advancedReportsEnabled && (
            <Card className="border border-border shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      <SectionTitle
                        title="Esperado vs. Realizado"
                        tooltip="Compara, dia a dia, o total esperado com o que virou check-in, no-show, cancelamento ou ficou pendente/outro status. Agrupado pela data da reserva. Use o botão Reservas/Pessoas para alternar entre contar reservas e contar pessoas — em Pessoas, o esperado soma os lugares reservados (agendadas + fila de espera) e 'Compareceram' usa quem realmente fez check-in."
                      />
                    </CardTitle>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs sm:justify-end">
                    <div className="inline-flex items-center rounded-md border border-border bg-muted/20 p-0.5">
                      <button
                        type="button"
                        onClick={() => setExpectedVsActualMetric('reservations')}
                        className={cn(
                          'rounded px-2 py-0.5 font-medium transition-colors',
                          !expectedVsActualIsPeople ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        Reservas
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpectedVsActualMetric('people')}
                        className={cn(
                          'rounded px-2 py-0.5 font-medium transition-colors',
                          expectedVsActualIsPeople ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        Pessoas
                      </button>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1">
                      <span className="text-muted-foreground">Esperado</span>
                      <span className="font-semibold text-foreground">
                        {expectedVsActualConfig.expectedTotal.toLocaleString('pt-BR')}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success-soft px-2 py-1">
                      <span className="text-muted-foreground">{expectedVsActualConfig.completedLabel}</span>
                      <span className="font-semibold text-success">
                        {expectedVsActualConfig.completedTotal.toLocaleString('pt-BR')}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1">
                      <span className="text-muted-foreground">Perdas</span>
                      <span className="font-semibold text-destructive">
                        {expectedVsActualConfig.lossesTotal.toLocaleString('pt-BR')}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-info/20 bg-info-soft/40 px-2 py-1">
                      <span className="text-muted-foreground">Realização</span>
                      <span className="font-semibold text-info">
                        {expectedVsActualConfig.rateTotal.toLocaleString('pt-BR')}%
                      </span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={expectedVsActualChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis yAxisId="count" allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis
                        yAxisId="rate"
                        orientation="right"
                        domain={[0, 100]}
                        tick={{ fontSize: 12 }}
                        stroke="hsl(202, 89%, 48%)"
                        tickFormatter={(value: number) => `${value}%`}
                      />
                      <RechartsTooltip
                        content={({ active, payload, label }: any) => {
                          if (!active || !payload?.length) return null;

                          const point = payload[0]?.payload;
                          if (!point) return null;

                          return (
                            <div className="rounded-lg border border-border bg-card p-3 text-sm shadow-md">
                              <p className="font-semibold text-foreground">{label}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {expectedVsActualIsPeople ? 'Pessoas' : 'Reservas'}
                              </p>
                              <div className="mt-2 space-y-1 text-muted-foreground">
                                <p>Esperado: <span className="font-medium text-foreground">{(point.expected ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>{expectedVsActualConfig.completedLabel}: <span className="font-medium text-success">{(point.completed ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>No-shows: <span className="font-medium text-destructive">{(point.noShows ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Canceladas: <span className="font-medium text-foreground">{(point.cancellations ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Pendentes/outros: <span className="font-medium text-foreground">{(point.pending ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Taxa realizada: <span className="font-medium text-info">{(point.realizedRate ?? 0).toLocaleString('pt-BR')}%</span></p>
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Legend />
                      <Bar
                        yAxisId="count"
                        dataKey="completed"
                        name={expectedVsActualConfig.completedLabel}
                        stackId="expected"
                        fill="hsl(145, 63%, 42%)"
                        maxBarSize={48}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
                      />
                      <Bar
                        yAxisId="count"
                        dataKey="noShows"
                        name="No-shows"
                        stackId="expected"
                        fill="hsl(0, 72%, 51%)"
                        maxBarSize={48}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
                      />
                      <Bar
                        yAxisId="count"
                        dataKey="cancellations"
                        name="Canceladas"
                        stackId="expected"
                        fill="hsl(14, 72%, 58%)"
                        maxBarSize={48}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
                      />
                      <Bar
                        yAxisId="count"
                        dataKey="pending"
                        name="Pendentes/outros"
                        stackId="expected"
                        fill="hsl(0, 0%, 72%)"
                        maxBarSize={48}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
                      />
                      <Line
                        yAxisId="rate"
                        type="monotone"
                        dataKey="realizedRate"
                        name="Taxa realizada"
                        stroke="hsl(202, 89%, 48%)"
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
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
                        title="Ocupação da capacidade diária"
                        tooltip="Compara, dia a dia, a capacidade total dos horários de reserva com as pessoas que fizeram check-in. A capacidade respeita regras por capacidade, limites globais por horário, mapas ativos, bloqueios e o período selecionado no dashboard."
                      />
                    </CardTitle>
                    <CardDescription>
                      {dailyCapacityHasCapacity
                        ? `${dailyCapacityTotals.checkedInGuests.toLocaleString('pt-BR')} pessoas presentes em ${dailyCapacityTotals.totalCapacity.toLocaleString('pt-BR')} lugares disponíveis no período.`
                        : 'Sem capacidade calculada no período selecionado.'}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs sm:justify-end">
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1">
                      <span className="text-muted-foreground">Capacidade</span>
                      <span className="font-semibold text-foreground">
                        {dailyCapacityTotals.totalCapacity.toLocaleString('pt-BR')}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success-soft px-2 py-1">
                      <span className="text-muted-foreground">Pessoas presentes</span>
                      <span className="font-semibold text-success">
                        {dailyCapacityTotals.checkedInGuests.toLocaleString('pt-BR')}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border border-info/20 bg-info-soft/40 px-2 py-1">
                      <span className="text-muted-foreground">Ocupação</span>
                      <span className="font-semibold text-info">
                        {dailyCapacityTotals.occupancyRate.toLocaleString('pt-BR')}%
                      </span>
                    </div>
                    {dailyCapacityTotals.overCapacityDays > 0 && (
                      <div className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive-soft px-2 py-1">
                        <span className="text-muted-foreground">Acima</span>
                        <span className="font-semibold text-destructive">
                          {dailyCapacityTotals.overCapacityDays.toLocaleString('pt-BR')} dia{dailyCapacityTotals.overCapacityDays === 1 ? '' : 's'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  {(['below', 'full', 'over'] as const).map((status) => (
                    <span key={status} className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: DAILY_CAPACITY_STATUS_META[status].color }}
                        aria-hidden="true"
                      />
                      {DAILY_CAPACITY_STATUS_META[status].label}
                    </span>
                  ))}
                </div>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyCapacityStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis yAxisId="guests" allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                      <YAxis
                        yAxisId="rate"
                        orientation="right"
                        domain={[0, (dataMax: number) => Math.max(120, Math.ceil(dataMax / 10) * 10)]}
                        tick={{ fontSize: 12 }}
                        stroke="hsl(202, 89%, 48%)"
                        tickFormatter={(value: number) => `${value}%`}
                      />
                      <RechartsTooltip
                        content={({ active, payload, label }: any) => {
                          if (!active || !payload?.length) return null;

                          const point = payload[0]?.payload;
                          if (!point) return null;

                          const status = point.status as keyof typeof DAILY_CAPACITY_STATUS_META;
                          const statusMeta = DAILY_CAPACITY_STATUS_META[status] ?? DAILY_CAPACITY_STATUS_META.no_capacity;

                          return (
                            <div className="rounded-lg border border-border bg-card p-3 text-sm shadow-md">
                              <div className="flex items-center justify-between gap-4">
                                <p className="font-semibold text-foreground">{label}</p>
                                <span
                                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold text-white"
                                  style={{ backgroundColor: statusMeta.color }}
                                >
                                  {statusMeta.label}
                                </span>
                              </div>
                              <div className="mt-2 space-y-1 text-muted-foreground">
                                <p>Capacidade: <span className="font-medium text-foreground">{(point.totalCapacity ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Horários com capacidade: <span className="font-medium text-foreground">{(point.slotCount ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Pessoas presentes: <span className="font-medium text-success">{(point.checkedInGuests ?? 0).toLocaleString('pt-BR')}</span></p>
                                <p>Ocupação: <span className="font-medium text-info">{(point.occupancyRate ?? 0).toLocaleString('pt-BR')}%</span></p>
                                {(point.overCapacityGuests ?? 0) > 0 && (
                                  <p>Excesso: <span className="font-medium text-destructive">{point.overCapacityGuests.toLocaleString('pt-BR')} pessoa{point.overCapacityGuests === 1 ? '' : 's'}</span></p>
                                )}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Legend />
                      <Bar
                        yAxisId="guests"
                        dataKey="totalCapacity"
                        name="Capacidade"
                        fill="hsl(0, 0%, 82%)"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={42}
                      />
                      <Bar
                        yAxisId="guests"
                        dataKey="checkedInGuests"
                        name="Pessoas presentes"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={42}
                      >
                        {dailyCapacityStats.map((day) => (
                          <Cell
                            key={day.date}
                            fill={DAILY_CAPACITY_STATUS_META[day.status].color}
                          />
                        ))}
                      </Bar>
                      <ReferenceLine
                        yAxisId="rate"
                        y={100}
                        stroke="hsl(0, 72%, 51%)"
                        strokeDasharray="4 4"
                        ifOverflow="extendDomain"
                      />
                      <Line
                        yAxisId="rate"
                        type="monotone"
                        dataKey="occupancyRate"
                        name="Ocupação"
                        stroke="hsl(202, 89%, 48%)"
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                        isAnimationActive
                        animationDuration={500}
                        animationEasing="ease-out"
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
                  title="Registros em reservas por data de criação"
                  tooltip="Mostra quantos registros foram criados em reservas por dia, separando agendadas da fila. Agrupado pela data de criação da reserva — quando o cliente fez o agendamento, não quando vai visitar."
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

          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Card className="min-w-0 border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Antecedência das reservas agendadas"
                    tooltip="Mostra com quantos dias de antecedência as reservas agendadas costumam ser feitas. A fila não entra aqui. Agrupado pela data de criação da reserva — o período selecionado filtra quando o agendamento foi feito."
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
                        tooltip="Total de reservas agendadas criadas no sistema no período selecionado. Conta pela data de criação da reserva."
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

            <Card className="min-w-0 border border-border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <SectionTitle
                    title="Cancelamentos e No Show das agendadas"
                    tooltip="Mostra as perdas do período por cancelamento e por reservas que viraram No Show. Agrupado pela data da reserva — quando o cliente estava programado para visitar."
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
                      <Bar dataKey="noShows" name="No Show" fill="hsl(0, 0%, 35%)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
          <Card className="border border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <SectionTitle
                  title="Origem das Reservas"
                  tooltip="Mostra de onde vieram as reservas do período: Direta/Orgânica, Ads, Filiado, Manual ou Fila de Espera. Filtrado pela data da reserva — quando o cliente está programado para visitar."
                />
              </CardTitle>
              <CardDescription>
                Considera a data da reserva. Cada reserva entra em uma única categoria — {reservationOriginBreakdown.total.toLocaleString('pt-BR')} reservas · {reservationOriginBreakdown.totalPeople.toLocaleString('pt-BR')} pessoas no período.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {reservationOriginBreakdown.total > 0 ? (
                <div className="space-y-6">
                  <div className="hidden relative h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={visibleReservationOriginItems}
                          dataKey="value"
                          nameKey="label"
                          innerRadius={72}
                          outerRadius={104}
                          paddingAngle={2}
                          stroke="hsl(var(--background))"
                          strokeWidth={2}
                        >
                          {visibleReservationOriginItems.map((item) => (
                            <Cell key={item.key} fill={item.color} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: 'hsl(0, 0%, 100%)',
                            border: '1px solid hsl(0, 0%, 88%)',
                            borderRadius: '0.5rem',
                            fontSize: '0.875rem',
                          }}
                          formatter={(value, name, context) => [
                            `${Number(value).toLocaleString('pt-BR')} reserva${Number(value) === 1 ? '' : 's'} · ${Number(context?.payload?.people ?? 0).toLocaleString('pt-BR')} pessoas (${Number(context?.payload?.percentage ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`,
                            name,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">Total</span>
                      <span className="text-3xl font-semibold text-foreground">
                        {reservationOriginBreakdown.total.toLocaleString('pt-BR')}
                      </span>
                      <span className="text-xs text-muted-foreground">reservas</span>
                      <span className="mt-0.5 text-xs text-muted-foreground">
                        {reservationOriginBreakdown.totalPeople.toLocaleString('pt-BR')} pessoas
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    {reservationOriginBreakdown.items.map((item) => (
                      <div
                        key={item.key}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: item.color }}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium leading-tight text-foreground">{item.label}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {item.percentage.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="flex items-center justify-end gap-1 text-base font-semibold text-foreground leading-tight">
                            <CalendarCheck className="h-3 w-3 text-primary" />
                            {item.value.toLocaleString('pt-BR')}
                          </p>
                          <p className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                            <Users className="h-2.5 w-2.5 text-info" />
                            {item.people.toLocaleString('pt-BR')} {item.people === 1 ? 'pessoa' : 'pessoas'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-2xl border border-border/70 bg-background/80 p-3 shadow-sm">
                    <div className="hidden mb-3 flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">Origem por dia</p>
                        <p className="text-xs text-muted-foreground">
                          Uma barra empilhada por data da reserva, mostrando a composição diária das reservas.
                        </p>
                      </div>
                      <p className="max-w-xl text-right text-xs text-muted-foreground">
                        Ads entra quando existe UTM pago ou clique Meta identificado por fbclid/fbc. _fbp sozinho não classifica como Ads.
                      </p>
                    </div>

                    <div className="h-[320px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={reservationOriginDailyStats} barGap={2} maxBarSize={42}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0, 0%, 88%)" />
                          <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="hsl(0, 0%, 40%)" />
                          <RechartsTooltip
                            cursor={{ fill: 'hsl(28, 85%, 55%, 0.08)' }}
                            content={({ active, payload }) => {
                              if (!active || !payload?.length) return null;

                              const point = payload[0].payload as Record<string, number | string>;
                              const dayItems = visibleReservationOriginItems
                                .map((item) => {
                                  const reservations = Number(point[item.key] ?? 0);
                                  const people = Number(point[`${item.key}People`] ?? 0);
                                  return { ...item, reservations, people };
                                })
                                .filter((item) => item.reservations > 0);

                              return (
                                <div className="min-w-[220px] rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur-sm">
                                  <div className="mb-2 border-b border-border/70 pb-2">
                                    <p className="text-sm font-semibold text-foreground">{String(point.label)}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {Number(point.totalReservations ?? 0).toLocaleString('pt-BR')} reservas ·{' '}
                                      {Number(point.totalPeople ?? 0).toLocaleString('pt-BR')} pessoas
                                    </p>
                                  </div>

                                  <div className="space-y-2">
                                    {dayItems.map((item) => (
                                      <div key={item.key} className="flex items-center justify-between gap-4 text-xs">
                                        <div className="flex min-w-0 items-center gap-2">
                                          <span
                                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                                            style={{ backgroundColor: item.color }}
                                            aria-hidden="true"
                                          />
                                          <span className="truncate text-foreground">{item.label}</span>
                                        </div>
                                        <span className="shrink-0 text-muted-foreground">
                                          {item.reservations.toLocaleString('pt-BR')} · {item.people.toLocaleString('pt-BR')}p
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Legend />
                          {visibleReservationOriginItems.map((item, index) => (
                            <Bar
                              key={item.key}
                              dataKey={item.key}
                              name={item.label}
                              stackId="reservation-origin"
                              fill={item.color}
                              radius={index === visibleReservationOriginItems.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                            />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
                  Sem reservas no período para classificar por origem.
                </div>
              )}
            </CardContent>
          </Card>
          {advancedReportsEnabled ? (
            <>
          <div className="[&>*]:min-w-0">
            <ReservationFunnelChart
              data={funnelData}
              title={isCompanyContext ? 'Funil de Reservas' : 'Funil de Reservas (Global)'}
              description={funnelDescription}
              measurementLabel={uniqueFunnelOnly ? 'Únicos' : 'Sessões'}
              headerActions={(
                <div className="flex flex-wrap items-center justify-end gap-3 text-sm text-muted-foreground">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={adsFunnelOnly}
                      onChange={(event) => setAdsFunnelOnly(event.target.checked)}
                      className="h-4 w-4 rounded-sm border border-primary text-primary accent-primary"
                    />
                    Mostrar apenas origem Ads
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uniqueFunnelOnly}
                      onChange={(event) => setUniqueFunnelOnly(event.target.checked)}
                      className="h-4 w-4 rounded-sm border border-primary text-primary accent-primary"
                    />
                    Mostrar visitantes únicos
                  </label>
                </div>
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
