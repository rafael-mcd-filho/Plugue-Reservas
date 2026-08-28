import { useMemo } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Gauge,
  Grid3X3,
  Info,
  RefreshCcw,
  Users,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportMetricCard from '@/components/reports/ReportMetricCard';
import ReportShell from '@/components/reports/ReportShell';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useOccupancyCapacityReport } from '@/hooks/useOccupancyCapacityReport';
import { useOccupancyWaitlistSeries } from '@/hooks/useOccupancyWaitlistSeries';
import { useReportFilters } from '@/hooks/useReportFilters';
import {
  OCCUPANCY_CAPACITY_MODES,
  OCCUPANCY_CAPACITY_OUTCOMES,
  type OccupancyCapacityHeatmapCell,
  type OccupancyCapacityModeFilter,
  type OccupancyCapacityOutcomeFilter,
} from '@/lib/occupancy-capacity-report';
import { cn } from '@/lib/utils';

// The report no longer lists individual reservations, but the RPC contract still
// requires a valid page window. Asking for the smallest page keeps the response
// free of personal data we do not render.
const DETAILS_PAGE_SIZE = 1;
const numberFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const UI = {
  title: 'Ocupa\u00e7\u00e3o & Capacidade',
  description: 'Compare a capacidade publicada com a demanda reservada e os check-ins registrados por dia e hor\u00e1rio.',
  loading: 'Carregando ocupa\u00e7\u00e3o e capacidade',
  errorTitle: 'N\u00e3o foi poss\u00edvel carregar o relat\u00f3rio',
  errorDescription: 'Confira sua conex\u00e3o e tente novamente. Os dados n\u00e3o foram tratados como zero.',
  retry: 'Tentar novamente',
  capacity: 'Capacidade publicada',
  pressure: 'Press\u00e3o da demanda',
  occupancy: 'Check-ins sobre capacidade',
  checkins: 'pessoas com check-in',
  waitlist: 'Fila de espera',
  waitlistDetail: 'de espera m\u00e9dia',
  noShow: 'No-show',
  noShowDetail: 'reservas que n\u00e3o compareceram',
  estimatedTitle: 'Parte da capacidade \u00e9 estimada',
  unavailableTitle: 'Capacidade n\u00e3o encontrada',
  evolutionTitle: 'Capacidade, demanda e presen\u00e7a',
  evolutionDescription: 'A demanda inclui reservas que terminaram em no-show; cancelamentos e pagamentos expirados ficam fora.',
  heatmapTitle: 'Mapa de press\u00e3o por dia e hor\u00e1rio',
  heatmapDescription: 'Cada c\u00e9lula agrega os mesmos hor\u00e1rios no per\u00edodo. A cor representa pessoas reservadas sobre capacidade publicada.',
  waitlistHourTitle: 'Fila por hor\u00e1rio de entrada',
  waitlistHourDescription: 'Entradas, pessoas sentadas e sa\u00eddas sem sentar. O tempo m\u00e9dio considera somente quem foi sentado.',
  noShowHourTitle: 'No-show por hor\u00e1rio da reserva',
  noShowHourDescription: 'Taxa entre reservas v\u00e1lidas no hor\u00e1rio, sem depender de mesa atribu\u00edda.',
  mode: 'Modo',
  allModes: 'Todos os modos',
  allOutcomes: 'Todos os resultados',
  modeFilter: 'Modo de capacidade',
  modeCapacity: 'Por capacidade',
  modeTables: 'Por mesas',
  snapshot: 'Snapshot hist\u00f3rico',
  estimated: 'Configura\u00e7\u00e3o atual (estimativa)',
  noBase: 'Sem base publicada',
  mixed: 'Base mista',
  previousPeriod: 'vs. per\u00edodo anterior',
  noComparison: 'Sem base anterior',
  comparisonOff: 'Comparação desativada',
  comparisonLoading: 'Carregando comparação…',
  comparisonUnavailable: 'Comparação indisponível',
  comparisonLimited: 'Comparação limitada',
  waitlistScope: 'Fila de espera: os indicadores e o gráfico consideram todo o período selecionado e não mudam com “Modo de capacidade”.',
  capacityHelp: 'Soma dos lugares publicados em cada horário do período. Como acumula todos os dias analisados, fica bem acima da lotação da casa em um único dia.',
  pressureHelp: 'Pessoas reservadas divididas pela capacidade publicada, ambas somadas no mesmo período. Inclui reservas que terminaram em no-show.',
  occupancyHelp: 'Pessoas que fizeram check-in divididas pela capacidade publicada do período.',
  waitlistHelp: 'Entradas registradas na fila de espera no período. O tempo médio de espera considera apenas quem chegou a ser sentado.',
  noShowHelp: 'Reservas válidas no horário que não compareceram. Canceladas e pagamentos expirados ficam fora da contagem.',
};

const MODE_LABELS: Record<OccupancyCapacityModeFilter, string> = {
  all: UI.allModes,
  capacity: UI.modeCapacity,
  tables: UI.modeTables,
};

type CapacityEvolutionView = 'volumes' | 'rates';
type WaitlistEvolutionView = 'period' | 'hour';

function isCapacityEvolutionView(value: string | null): value is CapacityEvolutionView {
  return value === 'volumes' || value === 'rates';
}

function isWaitlistEvolutionView(value: string | null): value is WaitlistEvolutionView {
  return value === 'period' || value === 'hour';
}

function formatInteger(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  return `${decimalFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function formatMinutes(value: number): string {
  return `${decimalFormatter.format(Number.isFinite(value) ? value : 0)} min`;
}

function formatDate(value: string): string {
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'dd/MM/yyyy', { locale: ptBR }) : value;
}

function formatPeriod(value: string, granularity: 'day' | 'week' | 'month'): string {
  const parsed = parseISO(value);
  if (!isValid(parsed)) return value;
  if (granularity === 'month') return format(parsed, 'MMM/yy', { locale: ptBR }).replace('.', '');
  return format(parsed, 'dd/MM', { locale: ptBR });
}

function formatTime(value: string): string {
  return value.slice(0, 5);
}

function qualityLabel(value: string | null): string {
  if (value === 'snapshot') return UI.snapshot;
  if (value === 'estimated_current_configuration') return UI.estimated;
  if (value === 'mixed') return UI.mixed;
  return UI.noBase;
}

function comparisonDetail(current: number, previous: number, percentagePoints = false): string {
  if (!Number.isFinite(previous) || previous === 0) return UI.noComparison;
  const delta = percentagePoints
    ? current - previous
    : ((current - previous) / previous) * 100;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${decimalFormatter.format(delta)}${percentagePoints ? ' p.p.' : '%'} ${UI.previousPeriod}`;
}

function heatTone(rate: number): string {
  if (rate >= 100) return 'border-rose-300 bg-rose-100 text-rose-950';
  if (rate >= 80) return 'border-orange-300 bg-orange-100 text-orange-950';
  if (rate >= 55) return 'border-amber-300 bg-amber-50 text-amber-950';
  if (rate > 0) return 'border-emerald-200 bg-emerald-50 text-emerald-950';
  return 'border-border bg-muted/25 text-muted-foreground';
}

function ReportLoading() {
  return (
    <div className="space-y-4" aria-label={UI.loading} aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}
      </div>
      <Skeleton className="h-[360px] rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-[340px] rounded-xl" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
    </div>
  );
}

function Heatmap({ cells }: { cells: OccupancyCapacityHeatmapCell[] }) {
  const weekdays = useMemo(() => {
    const grouped = new Map<number, { label: string; cells: OccupancyCapacityHeatmapCell[] }>();
    for (const cell of cells) {
      const group = grouped.get(cell.weekday) ?? { label: cell.weekday_label, cells: [] };
      group.cells.push(cell);
      grouped.set(cell.weekday, group);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([weekday, value]) => ({ weekday, ...value, cells: value.cells.sort((a, b) => a.time_slot.localeCompare(b.time_slot)) }));
  }, [cells]);

  if (weekdays.length === 0) {
    return <p className="py-14 text-center text-sm text-muted-foreground">{UI.noBase}</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {weekdays.map((day) => (
        <section key={day.weekday} className="rounded-xl bg-muted/40 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{day.label}</h3>
          <div className="space-y-1.5">
            {day.cells.map((cell) => (
              <div
                key={`${cell.weekday}-${cell.time_slot}`}
                className={cn('grid grid-cols-[48px_1fr_auto] items-center gap-2 rounded-lg border px-2.5 py-2', heatTone(cell.capacity_pressure_rate))}
                title={`${formatInteger(cell.reserved_people)} reservadas / ${formatInteger(cell.published_capacity)} de capacidade`}
              >
                <span className="text-xs font-semibold tabular-nums">{formatTime(cell.time_slot)}</span>
                <span className="text-[11px] tabular-nums opacity-80">
                  {formatInteger(cell.reserved_people)} / {formatInteger(cell.published_capacity)}
                </span>
                <strong className="text-xs tabular-nums">{formatPercent(cell.capacity_pressure_rate)}</strong>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function OccupancyCapacityReport() {
  const { companyId, companyTimeZone, companyTimeZoneResolved } = useCompanySlug();
  const filters = useReportFilters({
    defaultPreset: 'last_30_days',
    defaultComparisonEnabled: true,
    timeZone: companyTimeZone,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const rawMode = searchParams.get('capacity_mode');
  const rawOutcome = searchParams.get('capacity_outcome');
  const availabilityMode: OccupancyCapacityModeFilter = OCCUPANCY_CAPACITY_MODES.includes(rawMode as OccupancyCapacityModeFilter)
    ? rawMode as OccupancyCapacityModeFilter
    : 'all';
  const outcome: OccupancyCapacityOutcomeFilter = OCCUPANCY_CAPACITY_OUTCOMES.includes(rawOutcome as OccupancyCapacityOutcomeFilter)
    ? rawOutcome as OccupancyCapacityOutcomeFilter
    : 'all';
  const evolutionView: CapacityEvolutionView = isCapacityEvolutionView(searchParams.get('capacity_view'))
    ? searchParams.get('capacity_view') as CapacityEvolutionView
    : 'volumes';
  const waitlistView: WaitlistEvolutionView = isWaitlistEvolutionView(searchParams.get('waitlist_view'))
    ? searchParams.get('waitlist_view') as WaitlistEvolutionView
    : 'period';

  const reportQuery = useOccupancyCapacityReport({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    granularity: filters.granularity,
    page: 1,
    pageSize: DETAILS_PAGE_SIZE,
    availabilityMode,
    outcome,
    enabled: companyTimeZoneResolved && !filters.rangeError,
  });
  const comparisonQuery = useOccupancyCapacityReport({
    companyId,
    periodStart: filters.comparisonDateOnlyRange?.from ?? filters.dateOnlyRange.from,
    periodEnd: filters.comparisonDateOnlyRange?.to ?? filters.dateOnlyRange.to,
    granularity: filters.granularity,
    page: 1,
    pageSize: 1,
    availabilityMode,
    outcome: 'all',
    enabled: companyTimeZoneResolved && !filters.rangeError && !!filters.comparisonDateOnlyRange,
  });
  const waitlistSeriesQuery = useOccupancyWaitlistSeries({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    granularity: filters.granularity,
    enabled: companyTimeZoneResolved && !filters.rangeError,
  });

  const report = reportQuery.data;
  const comparisonReport = comparisonQuery.data;
  const comparison = comparisonReport?.summary;
  const hasEquivalentSnapshotComparison = report?.meta.capacity_history === 'snapshot'
    && comparisonReport?.meta.capacity_history === 'snapshot';
  const pressureComparisonDetail = !filters.comparisonDateOnlyRange
    ? UI.comparisonOff
    : comparisonQuery.isLoading
      ? UI.comparisonLoading
      : comparisonQuery.isError
        ? UI.comparisonUnavailable
        : !comparisonReport
          ? UI.noComparison
          : hasEquivalentSnapshotComparison
            ? comparisonDetail(
                report?.summary.capacity_pressure_rate ?? 0,
                comparison.capacity_pressure_rate,
                true,
              )
            : `${UI.comparisonLimited} · período anterior: ${qualityLabel(comparisonReport.meta.capacity_history)}`;
  const evolutionHasData = !!report && report.series.some((point) => (
    point.published_capacity > 0 || point.reserved_people > 0 || point.checked_in_people > 0
  ));
  const evolutionData = useMemo(() => (report?.series ?? []).map((point) => ({
    ...point,
    excess_people: Math.max(point.reserved_people - point.published_capacity, 0),
    capacity_status: point.published_capacity === 0
      ? point.reserved_people > 0 || point.checked_in_people > 0
        ? 'no_capacity'
        : 'empty'
      : point.reserved_people > point.published_capacity
        ? 'over'
        : point.reserved_people === point.published_capacity
          ? 'full'
          : 'below',
  })), [report?.series]);
  const evolutionStatus = useMemo(() => evolutionData.reduce((totals, point) => ({
    over: totals.over + (point.capacity_status === 'over' ? 1 : 0),
    full: totals.full + (point.capacity_status === 'full' ? 1 : 0),
    noCapacity: totals.noCapacity + (point.capacity_status === 'no_capacity' ? 1 : 0),
    excessPeople: totals.excessPeople + point.excess_people,
  }), { over: 0, full: 0, noCapacity: 0, excessPeople: 0 }), [evolutionData]);
  const waitlistPeriodData = useMemo(
    () => (waitlistSeriesQuery.data?.series ?? []).map((point) => ({
      ...point,
      // A linha deve ter uma lacuna quando ninguém foi sentado no bucket.
      // Zero minutos sugeriria uma espera observada que não existiu.
      average_wait_minutes: point.seated > 0 ? point.average_wait_minutes : null,
    })),
    [waitlistSeriesQuery.data?.series],
  );
  const waitlistPeriodTotals = useMemo(() => {
    const totals = waitlistPeriodData.reduce((current, point) => ({
      entries: current.entries + point.entries,
      seated: current.seated + point.seated,
      dropped: current.dropped + point.dropped,
      waitedMinutes: current.waitedMinutes + ((point.average_wait_minutes ?? 0) * point.seated),
    }), { entries: 0, seated: 0, dropped: 0, waitedMinutes: 0 });

    return {
      entries: totals.entries,
      seated: totals.seated,
      dropped: totals.dropped,
      averageWaitMinutes: totals.seated > 0 ? totals.waitedMinutes / totals.seated : null,
    };
  }, [waitlistPeriodData]);
  const displayedWaitlistTotals = waitlistView === 'period'
    ? waitlistPeriodTotals
    : {
        entries: report?.summary.waitlist_entries ?? 0,
        seated: report?.summary.waitlist_seated ?? 0,
        dropped: report?.summary.waitlist_dropped ?? 0,
        averageWaitMinutes: (report?.summary.waitlist_seated ?? 0) > 0
          ? report?.summary.average_wait_minutes ?? 0
          : null,
      };
  // Diferentemente da série operacional (eventos no dia em que aconteceram),
  // esta taxa usa uma coorte coerente: entradas criadas no período e quantas
  // delas já chegaram a ser sentadas. Por isso ela existe apenas como KPI geral.
  const waitlistCohortEntries = report?.summary.waitlist_entries ?? 0;
  const waitlistCohortConversionRate = waitlistCohortEntries > 0
    ? (100 * (report?.summary.waitlist_seated ?? 0)) / waitlistCohortEntries
    : null;
  const waitlistHasData = waitlistView === 'period'
    ? waitlistPeriodData.some((row) => row.entries > 0 || row.seated > 0 || row.dropped > 0)
    : !!report && report.waitlist_by_hour.some((row) => row.entries > 0);
  const noShowHasData = !!report && report.no_show_by_hour.some((row) => row.eligible_reservations > 0);

  const setFilterParam = (key: string, value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === 'all') next.delete(key);
      else next.set(key, value);
      next.delete('capacity_page');
      return next;
    }, { replace: true });
  };

  const setViewParam = (key: string, value: string, defaultValue: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };

  const refresh = () => {
    void reportQuery.refetch();
    void waitlistSeriesQuery.refetch();
    if (filters.comparisonDateOnlyRange) void comparisonQuery.refetch();
  };

  const filterBar = (
    <ReportFilterBar filters={filters} isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching || waitlistSeriesQuery.isFetching} onRefresh={refresh}>
      <div className="min-w-0 flex-1 space-y-1 sm:w-44 sm:flex-none">
        <Label htmlFor="occupancy-capacity-mode" className="text-xs">{UI.modeFilter}</Label>
        <Select value={availabilityMode} onValueChange={(value) => setFilterParam('capacity_mode', value)}>
          <SelectTrigger id="occupancy-capacity-mode" className="h-9" aria-label={UI.modeFilter}><SelectValue /></SelectTrigger>
          <SelectContent>{OCCUPANCY_CAPACITY_MODES.map((mode) => <SelectItem key={mode} value={mode}>{MODE_LABELS[mode]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </ReportFilterBar>
  );

  return (
    <ReportShell
      title={UI.title}
      description={UI.description}
      icon={Gauge}
      filters={filterBar}
      updatedAt={report?.meta.generated_at ?? null}
      isRefreshing={(reportQuery.isFetching || waitlistSeriesQuery.isFetching) && !!report}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching || waitlistSeriesQuery.isFetching}
    >
      {(!companyTimeZoneResolved || (reportQuery.isLoading && !report)) ? <ReportLoading /> : reportQuery.isError && !report ? (
        <Alert variant="destructive" className="py-5">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>{UI.errorTitle}</AlertTitle>
          <AlertDescription className="mt-2 flex flex-col items-start gap-3">
            <span>{UI.errorDescription}</span>
            <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />{UI.retry}</Button>
          </AlertDescription>
        </Alert>
      ) : report ? (
        <div className="space-y-5">
          {reportQuery.isError && (
            <Alert>
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Dados preservados</AlertTitle>
              <AlertDescription>A atualização falhou, então mantivemos a última leitura válida na tela.</AlertDescription>
            </Alert>
          )}
          {report.meta.estimation_notice && (
            <Alert className={cn(
              report.meta.capacity_history === 'unavailable'
                ? 'border-rose-200 bg-rose-50 text-rose-950'
                : 'border-amber-200 bg-amber-50 text-amber-950',
            )}>
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{report.meta.capacity_history === 'unavailable' ? UI.unavailableTitle : UI.estimatedTitle}</AlertTitle>
              <AlertDescription>{report.meta.estimation_notice}</AlertDescription>
            </Alert>
          )}

          {filters.comparisonDateOnlyRange && comparisonQuery.isError && (
            <Alert>
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{UI.comparisonUnavailable}</AlertTitle>
              <AlertDescription>Os dados do período atual permanecem visíveis, mas não foi possível carregar a base anterior.</AlertDescription>
            </Alert>
          )}

          {comparisonReport && !hasEquivalentSnapshotComparison && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-950">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Bases não equivalentes para comparação</AlertTitle>
              <AlertDescription>
                Período atual: <strong>{qualityLabel(report.meta.capacity_history)}</strong>. Período anterior:{' '}
                <strong>{qualityLabel(comparisonReport.meta.capacity_history)}</strong>. A variação não é apresentada como comparação direta porque ao menos uma base não é um snapshot histórico completo.
                {comparisonReport.meta.estimation_notice && <> Base anterior: {comparisonReport.meta.estimation_notice}</>}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground" role="note">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" aria-hidden="true" />
            <p>{UI.waitlistScope}</p>
          </div>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Indicadores">
            <ReportMetricCard
              label={UI.capacity}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatInteger(report.summary.published_capacity)}
              detail={qualityLabel(report.meta.capacity_history)}
              explanation={UI.capacityHelp}
              icon={CalendarRange}
              tone="primary"
            />
            <ReportMetricCard
              label={UI.pressure}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.capacity_pressure_rate)}
              detail={report.meta.capacity_history === 'unavailable' ? UI.noBase : pressureComparisonDetail}
              explanation={UI.pressureHelp}
              icon={Users}
              tone="warning"
            />
            <ReportMetricCard
              label={UI.occupancy}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.check_in_capacity_rate)}
              detail={`${formatInteger(report.summary.checked_in_people)} ${UI.checkins}`}
              explanation={UI.occupancyHelp}
              icon={CheckCircle2}
              tone="success"
            />
            <ReportMetricCard
              label={UI.waitlist}
              value={formatInteger(report.summary.waitlist_entries)}
              detail={`${formatMinutes(report.summary.average_wait_minutes)} ${UI.waitlistDetail}`}
              explanation={UI.waitlistHelp}
              icon={Clock3}
              tone="info"
            />
            <ReportMetricCard
              label={UI.noShow}
              value={formatInteger(report.summary.no_show_reservations)}
              detail={`${formatInteger(report.summary.no_show_people)} pessoas \u00b7 ${UI.noShowDetail}`}
              explanation={UI.noShowHelp}
              icon={AlertCircle}
              tone="danger"
            />
          </section>

          <Card className="overflow-hidden border-border shadow-sm">
            <CardHeader className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">{UI.evolutionTitle}</CardTitle>
                  <CardDescription>{UI.evolutionDescription}</CardDescription>
                </div>
                <div className="inline-flex self-start rounded-md border border-border bg-muted/20 p-0.5" aria-label="Visualização da capacidade">
                  {(['volumes', 'rates'] as CapacityEvolutionView[]).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className={cn(
                        'rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        evolutionView === view ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                      aria-pressed={evolutionView === view}
                      onClick={() => setViewParam('capacity_view', view, 'volumes')}
                    >
                      {view === 'volumes' ? 'Volumes' : 'Taxas'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-md bg-muted/50 px-2 py-1"><strong className="tabular-nums text-foreground">{evolutionStatus.full}</strong> períodos em 100%</span>
                <span className="rounded-md bg-destructive/10 px-2 py-1"><strong className="tabular-nums text-destructive">{evolutionStatus.over}</strong> acima da capacidade</span>
                <span className="rounded-md bg-warning/10 px-2 py-1"><strong className="tabular-nums text-foreground">{formatInteger(evolutionStatus.excessPeople)}</strong> pessoas excedentes</span>
                {evolutionStatus.noCapacity > 0 && <span className="rounded-md bg-muted/50 px-2 py-1"><strong className="tabular-nums text-foreground">{evolutionStatus.noCapacity}</strong> sem base publicada</span>}
                <span className="rounded-md bg-muted/50 px-2 py-1">Qualidade: <strong className="text-foreground">{qualityLabel(report.meta.capacity_history)}</strong></span>
              </div>
            </CardHeader>
            <CardContent>
              {evolutionHasData ? <>
              <div className="h-[320px] w-full" role="img" aria-label={`${UI.evolutionTitle}. ${formatInteger(report.summary.reserved_people)} pessoas reservadas e ${formatInteger(report.summary.checked_in_people)} com check-in.`}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={evolutionData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="period" tickFormatter={(value) => formatPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} minTickGap={26} />
                    <YAxis domain={evolutionView === 'rates' ? [0, 'auto'] : undefined} tickFormatter={evolutionView === 'rates' ? (value) => `${value}%` : undefined} tick={{ fontSize: 11 }} />
                    <RechartsTooltip
                      labelFormatter={(value) => formatDate(String(value))}
                      formatter={(value: number, name: string) => [
                        evolutionView === 'rates' ? formatPercent(value) : formatInteger(value),
                        name,
                      ]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {evolutionView === 'volumes' ? (
                      <>
                        <Area type="monotone" dataKey="published_capacity" name={UI.capacity} fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" strokeWidth={2} />
                        <Bar dataKey="reserved_people" name="Pessoas reservadas" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} />
                        <Line type="monotone" dataKey="checked_in_people" name="Check-ins" stroke="hsl(var(--success))" strokeWidth={2.5} dot={false} />
                      </>
                    ) : (
                      <>
                        <ReferenceLine y={100} stroke="hsl(var(--destructive))" strokeDasharray="6 4" label={{ value: '100%', position: 'insideTopRight', fontSize: 11 }} />
                        <Line type="monotone" dataKey="capacity_pressure_rate" name="Pressão da demanda" stroke="hsl(var(--warning))" strokeWidth={2.5} dot={{ r: 2.5 }} />
                        <Line type="monotone" dataKey="check_in_capacity_rate" name="Check-ins sobre capacidade" stroke="hsl(var(--success))" strokeWidth={2.5} dot={{ r: 2.5 }} />
                      </>
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <p className="sr-only">
                Capacidade publicada de {formatInteger(report.summary.published_capacity)} pessoas,
                {' '}{formatInteger(report.summary.reserved_people)} pessoas reservadas e
                {' '}{formatInteger(report.summary.checked_in_people)} pessoas com check-in no período.
              </p>
              </> : (
                <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
                  <CalendarRange className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">Nenhum dado de capacidade ou demanda</p>
                  <p className="mt-1 text-xs text-muted-foreground">Altere o período ou o modo de capacidade para consultar outros resultados.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border shadow-sm">
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-primary/10 p-2 text-primary"><Grid3X3 className="h-4 w-4" aria-hidden="true" /></span>
                <div><CardTitle className="text-base">{UI.heatmapTitle}</CardTitle><CardDescription className="mt-1">{UI.heatmapDescription}</CardDescription></div>
              </div>
            </CardHeader>
            <CardContent><Heatmap cells={report.heatmap} /></CardContent>
          </Card>

          <section className="grid gap-4 xl:grid-cols-2">
            <Card className="border-border shadow-sm">
              <CardHeader className="space-y-3">
                <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
                  <div>
                    <CardTitle className="text-base">Fluxo da fila de espera</CardTitle>
                    <CardDescription>
                      {waitlistView === 'period'
                        ? 'Cada evento entra no período em que realmente ocorreu: entrada, atendimento ou saída.'
                        : UI.waitlistHourDescription}
                    </CardDescription>
                  </div>
                  <div className="inline-flex shrink-0 rounded-md border border-border bg-muted/20 p-0.5" aria-label="Visualização da fila">
                    {(['period', 'hour'] as WaitlistEvolutionView[]).map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={cn(
                          'rounded px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          waitlistView === view ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                        )}
                        aria-pressed={waitlistView === view}
                        onClick={() => setViewParam('waitlist_view', view, 'period')}
                      >
                        {view === 'period' ? 'Por período' : 'Por horário'}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Resumo da fila de espera">
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[hsl(28_85%_55%)]" aria-hidden="true" />
                      <span className="truncate text-xs text-muted-foreground">Entradas</span>
                    </div>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {waitlistView === 'period' && waitlistSeriesQuery.isError
                        ? '—'
                        : formatInteger(displayedWaitlistTotals.entries)}
                    </strong>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[hsl(var(--success))]" aria-hidden="true" />
                      <span className="truncate text-xs text-muted-foreground">Sentados</span>
                    </div>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {waitlistView === 'period' && waitlistSeriesQuery.isError
                        ? '—'
                        : formatInteger(displayedWaitlistTotals.seated)}
                    </strong>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                      <span className="truncate text-xs text-muted-foreground">Saídas sem sentar</span>
                    </div>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {waitlistView === 'period' && waitlistSeriesQuery.isError
                        ? '—'
                        : formatInteger(displayedWaitlistTotals.dropped)}
                    </strong>
                  </div>
                  <div
                    className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2"
                    title="Percentual das entradas criadas no período que já foram sentadas."
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-foreground/45" aria-hidden="true" />
                      <span className="truncate text-xs text-muted-foreground">Conversão geral</span>
                    </div>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {waitlistCohortConversionRate === null ? '—' : formatPercent(waitlistCohortConversionRate)}
                    </strong>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[hsl(var(--info))]" aria-hidden="true" />
                      <span className="truncate text-xs text-muted-foreground">Espera média</span>
                    </div>
                    <strong className="shrink-0 text-sm tabular-nums">
                      {waitlistView === 'period' && waitlistSeriesQuery.isError
                        ? '—'
                        : displayedWaitlistTotals.averageWaitMinutes === null
                          ? '—'
                          : formatMinutes(displayedWaitlistTotals.averageWaitMinutes)}
                    </strong>
                  </div>
                </div>

                <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <p>
                    A conversão geral acompanha a mesma coorte: entradas criadas no período que já foram sentadas.
                    Ela não é calculada dia a dia, pois entrada e atendimento podem acontecer em datas diferentes.
                  </p>
                </div>

                {waitlistSeriesQuery.isError && waitlistView === 'period' ? (
                  <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
                    <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Não foi possível carregar o fluxo por período</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => waitlistSeriesQuery.refetch()}>
                      Tentar novamente
                    </Button>
                  </div>
                ) : waitlistHasData ? <>
                <div
                  className="h-[280px] w-full"
                  role="img"
                  aria-label={`Fluxo da fila. ${formatInteger(displayedWaitlistTotals.entries)} entradas no recorte atual.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={waitlistView === 'period' ? waitlistPeriodData : report.waitlist_by_hour} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey={waitlistView === 'period' ? 'period' : 'hour'}
                        tickFormatter={(value) => waitlistView === 'period'
                          ? formatPeriod(value, filters.granularity)
                          : formatTime(value)}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis yAxisId="count" tick={{ fontSize: 11 }} />
                      {waitlistView === 'period' && <YAxis yAxisId="minutes" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(value) => `${value} min`} />}
                      <RechartsTooltip
                        labelFormatter={(value) => waitlistView === 'period' ? formatDate(String(value)) : formatTime(String(value))}
                        formatter={(value: number, name: string) => [
                          name === 'Espera média' ? formatMinutes(value) : formatInteger(value),
                          name,
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {waitlistView === 'period' ? (
                        <>
                          <Line yAxisId="count" type="monotone" dataKey="entries" name="Entradas na fila" stroke="hsl(28, 85%, 55%)" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                          <Line yAxisId="count" type="monotone" dataKey="seated" name="Sentados" stroke="hsl(var(--success))" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                          <Line yAxisId="count" type="monotone" dataKey="dropped" name="Saídas sem sentar" stroke="hsl(var(--destructive))" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                          <Line yAxisId="minutes" type="monotone" dataKey="average_wait_minutes" name="Espera média" stroke="hsl(var(--info))" strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />
                        </>
                      ) : (
                        <>
                          <Bar yAxisId="count" dataKey="entries" name="Entradas" fill="hsl(var(--info))" radius={[3, 3, 0, 0]} />
                          <Bar yAxisId="count" dataKey="seated" name="Sentados" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                          <Bar yAxisId="count" dataKey="dropped" name="Saídas sem sentar" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                        </>
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <p className="sr-only">
                  {formatInteger(displayedWaitlistTotals.entries)} entradas na fila,
                  {' '}{formatInteger(displayedWaitlistTotals.seated)} atendidas e
                  {' '}{formatInteger(displayedWaitlistTotals.dropped)} saídas sem sentar.
                </p>
                </> : (
                  <p className="py-16 text-center text-sm text-muted-foreground">Nenhum evento da fila neste recorte.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm">
              <CardHeader><CardTitle className="text-base">{UI.noShowHourTitle}</CardTitle><CardDescription>{UI.noShowHourDescription}</CardDescription></CardHeader>
              <CardContent>
                {noShowHasData ? <>
                <div
                  className="h-[280px] w-full"
                  role="img"
                  aria-label={`${UI.noShowHourTitle}. ${formatInteger(report.summary.no_show_reservations)} reservas não compareceram, somando ${formatInteger(report.summary.no_show_people)} pessoas.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={report.no_show_by_hour} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="count" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="rate" orientation="right" tickFormatter={(value) => `${value}%`} tick={{ fontSize: 11 }} />
                      <RechartsTooltip labelFormatter={(value) => formatTime(String(value))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="count" dataKey="reservations" name="No-shows" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                      <Line yAxisId="rate" type="monotone" dataKey="rate" name="Taxa" stroke="hsl(var(--warning))" strokeWidth={2.5} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <p className="sr-only">
                  {formatInteger(report.summary.no_show_reservations)} reservas não compareceram,
                  somando {formatInteger(report.summary.no_show_people)} pessoas.
                </p>
                </> : (
                  <p className="py-16 text-center text-sm text-muted-foreground">Sem reservas elegíveis para calcular no-show por horário.</p>
                )}
              </CardContent>
            </Card>
          </section>

        </div>
      ) : null}
    </ReportShell>
  );
}
