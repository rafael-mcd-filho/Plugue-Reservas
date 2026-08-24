import { useCallback, useEffect, useMemo, useRef } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  Armchair,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gauge,
  Grid3X3,
  Info,
  RefreshCcw,
  Table2,
  Users,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportMetricCard from '@/components/reports/ReportMetricCard';
import ReportShell from '@/components/reports/ReportShell';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useOccupancyCapacityReport } from '@/hooks/useOccupancyCapacityReport';
import { useReportFilters } from '@/hooks/useReportFilters';
import {
  OCCUPANCY_CAPACITY_MODES,
  OCCUPANCY_CAPACITY_OUTCOMES,
  type OccupancyCapacityHeatmapCell,
  type OccupancyCapacityModeFilter,
  type OccupancyCapacityOutcomeFilter,
  type OccupancyCapacityReservationRow,
} from '@/lib/occupancy-capacity-report';
import { getReservationStatusLabel } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;
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
  tablesTitle: 'Mesas e se\u00e7\u00f5es',
  tablesDescription: 'Detalhamento somente de reservas em modo por mesas que possuem table_id registrado.',
  noTables: 'N\u00e3o h\u00e1 reservas eleg\u00edveis com mesa atribu\u00edda neste per\u00edodo.',
  detailsTitle: 'Reservas do per\u00edodo',
  detailsDescription: 'Lista paginada no servidor com a base de capacidade associada a cada reserva.',
  listOutcome: 'Resultado da lista',
  emptyDetails: 'Nenhuma reserva corresponde aos filtros selecionados.',
  mode: 'Modo',
  allModes: 'Todos os modos',
  allOutcomes: 'Todos os resultados',
  modeFilter: 'Modo de capacidade',
  modeCapacity: 'Por capacidade',
  modeTables: 'Por mesas',
  scheduled: 'Agendada',
  checkedIn: 'Check-in',
  cancelled: 'Cancelada',
  guest: 'Cliente',
  dateTime: 'Data e hor\u00e1rio',
  people: 'Pessoas',
  table: 'Mesa',
  status: 'Status',
  capacityBase: 'Base de capacidade',
  snapshot: 'Snapshot hist\u00f3rico',
  estimated: 'Configura\u00e7\u00e3o atual (estimativa)',
  noBase: 'Sem base publicada',
  mixed: 'Base mista',
  assignmentCoverage: 'Cobertura de atribui\u00e7\u00e3o',
  withoutTable: 'sem mesa',
  of: 'de',
  previousPeriod: 'vs. per\u00edodo anterior',
  noComparison: 'Sem base anterior',
  comparisonOff: 'Comparação desativada',
  comparisonLoading: 'Carregando comparação…',
  comparisonUnavailable: 'Comparação indisponível',
  comparisonLimited: 'Comparação limitada',
  waitlistScope: 'Fila de espera: os indicadores e o gráfico consideram todo o período selecionado e não mudam com “Modo de capacidade”.',
};

const MODE_LABELS: Record<OccupancyCapacityModeFilter, string> = {
  all: UI.allModes,
  capacity: UI.modeCapacity,
  tables: UI.modeTables,
};

const OUTCOME_LABELS: Record<OccupancyCapacityOutcomeFilter, string> = {
  all: UI.allOutcomes,
  scheduled: UI.scheduled,
  checked_in: UI.checkedIn,
  no_show: 'No-show',
  cancelled: UI.cancelled,
};

function parsePositivePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
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

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}` : value;
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

function DataQualityBadge({ quality }: { quality: string | null }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-normal text-left text-[10px] font-medium',
        quality === 'snapshot' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
        quality === 'estimated_current_configuration' && 'border-amber-200 bg-amber-50 text-amber-800',
      )}
    >
      {qualityLabel(quality)}
    </Badge>
  );
}

function ReportLoading() {
  return (
    <div className="space-y-5" aria-label={UI.loading} aria-busy="true">
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
        <section key={day.weekday} className="rounded-xl border border-border/80 bg-background/70 p-3">
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

function MobileReservationCard({ row }: { row: OccupancyCapacityReservationRow }) {
  return (
    <article className="border-b border-border p-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{row.guest_name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatPhone(row.guest_phone)}</p>
        </div>
        <Badge variant="outline">{getReservationStatusLabel(row.status)}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-muted-foreground">{UI.dateTime}</span><strong className="mt-0.5 block">{formatDate(row.date)} {formatTime(row.time)}</strong></div>
        <div><span className="text-muted-foreground">{UI.people}</span><strong className="mt-0.5 block">{formatInteger(row.party_size)}</strong></div>
        <div><span className="text-muted-foreground">{UI.mode}</span><strong className="mt-0.5 block">{MODE_LABELS[row.availability_mode]}</strong></div>
        <div><span className="text-muted-foreground">{UI.table}</span><strong className="mt-0.5 block">{row.table_number ? `${UI.table} ${row.table_number}` : '\u2014'}</strong></div>
      </div>
      <div className="mt-3"><DataQualityBadge quality={row.data_quality} /></div>
    </article>
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
  const page = parsePositivePage(searchParams.get('capacity_page'));

  const setPage = useCallback((nextPage: number) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextPage <= 1) next.delete('capacity_page');
      else next.set('capacity_page', String(nextPage));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const reportRangeKey = `${filters.dateOnlyRange.from}:${filters.dateOnlyRange.to}`;
  const previousRangeKey = useRef(reportRangeKey);
  useEffect(() => {
    if (previousRangeKey.current === reportRangeKey) return;
    previousRangeKey.current = reportRangeKey;
    setPage(1);
  }, [reportRangeKey, setPage]);

  const reportQuery = useOccupancyCapacityReport({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    granularity: filters.granularity,
    page,
    pageSize: PAGE_SIZE,
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
  const totalPages = Math.max(1, Math.ceil((report?.meta.details_total ?? 0) / PAGE_SIZE));
  const evolutionHasData = !!report && report.series.some((point) => (
    point.published_capacity > 0 || point.reserved_people > 0 || point.checked_in_people > 0
  ));
  const waitlistHasData = !!report && report.waitlist_by_hour.some((row) => row.entries > 0);
  const noShowHasData = !!report && report.no_show_by_hour.some((row) => row.eligible_reservations > 0);

  useEffect(() => {
    if (reportQuery.isPlaceholderData) return;
    if (report && report.meta.page !== page) setPage(report.meta.page);
  }, [page, report, setPage, reportQuery.isPlaceholderData]);

  const setFilterParam = (key: string, value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === 'all') next.delete(key);
      else next.set(key, value);
      next.delete('capacity_page');
      return next;
    }, { replace: true });
  };

  const refresh = () => {
    void reportQuery.refetch();
    if (filters.comparisonDateOnlyRange) void comparisonQuery.refetch();
  };

  const filterBar = (
    <ReportFilterBar filters={filters} isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching} onRefresh={refresh}>
      <div className="grid min-w-0 flex-1 grid-cols-1 gap-1 md:min-w-44">
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
      isRefreshing={reportQuery.isFetching && !!report}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching}
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
              icon={CalendarRange}
              tone="primary"
            />
            <ReportMetricCard
              label={UI.pressure}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.capacity_pressure_rate)}
              detail={report.meta.capacity_history === 'unavailable' ? UI.noBase : pressureComparisonDetail}
              icon={Users}
              tone="warning"
            />
            <ReportMetricCard
              label={UI.occupancy}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.check_in_capacity_rate)}
              detail={`${formatInteger(report.summary.checked_in_people)} ${UI.checkins}`}
              icon={CheckCircle2}
              tone="success"
            />
            <ReportMetricCard
              label={UI.waitlist}
              value={formatInteger(report.summary.waitlist_entries)}
              detail={`${formatMinutes(report.summary.average_wait_minutes)} ${UI.waitlistDetail}`}
              icon={Clock3}
              tone="info"
            />
            <ReportMetricCard
              label={UI.noShow}
              value={formatInteger(report.summary.no_show_reservations)}
              detail={`${formatInteger(report.summary.no_show_people)} pessoas \u00b7 ${UI.noShowDetail}`}
              icon={AlertCircle}
              tone="danger"
            />
          </section>

          <Card className="overflow-hidden border-border/80 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">{UI.evolutionTitle}</CardTitle>
              <CardDescription>{UI.evolutionDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              {evolutionHasData ? <>
              <div className="h-[320px] w-full" role="img" aria-label={`${UI.evolutionTitle}. ${formatInteger(report.summary.reserved_people)} pessoas reservadas e ${formatInteger(report.summary.checked_in_people)} com check-in.`}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={report.series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="period" tickFormatter={(value) => formatPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} minTickGap={26} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <RechartsTooltip labelFormatter={(value) => formatDate(String(value))} formatter={(value: number, name: string) => [formatInteger(value), name]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="published_capacity" name={UI.capacity} fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" strokeWidth={2} />
                    <Bar dataKey="reserved_people" name="Pessoas reservadas" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} />
                    <Line type="monotone" dataKey="checked_in_people" name="Check-ins" stroke="hsl(var(--success))" strokeWidth={2.5} dot={false} />
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

          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-primary/10 p-2 text-primary"><Grid3X3 className="h-4 w-4" aria-hidden="true" /></span>
                <div><CardTitle className="text-base">{UI.heatmapTitle}</CardTitle><CardDescription className="mt-1">{UI.heatmapDescription}</CardDescription></div>
              </div>
            </CardHeader>
            <CardContent><Heatmap cells={report.heatmap} /></CardContent>
          </Card>

          <section className="grid gap-5 xl:grid-cols-2">
            <Card className="border-border/80 shadow-sm">
              <CardHeader><CardTitle className="text-base">{UI.waitlistHourTitle}</CardTitle><CardDescription>{UI.waitlistHourDescription}</CardDescription></CardHeader>
              <CardContent>
                {waitlistHasData ? <>
                <div
                  className="h-[280px] w-full"
                  role="img"
                  aria-label={`${UI.waitlistHourTitle}. ${formatInteger(report.summary.waitlist_entries)} entradas, ${formatInteger(report.summary.waitlist_seated)} pessoas sentadas e ${formatInteger(report.summary.waitlist_dropped)} saídas sem sentar.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={report.waitlist_by_hour} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="hour" tickFormatter={formatTime} tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <RechartsTooltip labelFormatter={(value) => formatTime(String(value))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="entries" name="Entradas" fill="hsl(var(--info))" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="seated" name="Sentados" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="dropped" name="Sa\u00eddas sem sentar" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <p className="sr-only">
                  {formatInteger(report.summary.waitlist_entries)} entradas na fila,
                  {' '}{formatInteger(report.summary.waitlist_seated)} pessoas sentadas e
                  {' '}{formatInteger(report.summary.waitlist_dropped)} saídas sem sentar.
                </p>
                </> : (
                  <p className="py-16 text-center text-sm text-muted-foreground">Nenhuma entrada na fila neste recorte.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/80 shadow-sm">
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

          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div><CardTitle className="text-base">{UI.tablesTitle}</CardTitle><CardDescription className="mt-1">{UI.tablesDescription}</CardDescription></div>
                <div className="w-full max-w-xs rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-3 text-xs"><span>{UI.assignmentCoverage}</span><strong>{formatPercent(report.table_assignment.coverage_rate)}</strong></div>
                  <Progress
                    value={Math.min(report.table_assignment.coverage_rate, 100)}
                    className="mt-2 h-1.5"
                    aria-label={`${UI.assignmentCoverage}: ${formatPercent(report.table_assignment.coverage_rate)}`}
                  />
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{formatInteger(report.table_assignment.unassigned_reservations)} {UI.withoutTable} {UI.of} {formatInteger(report.table_assignment.eligible_reservations)}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {report.table_breakdown.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">{UI.noTables}</p> : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {report.table_breakdown.map((item) => (
                    <article key={item.table_id} className="rounded-xl border border-border/80 bg-background p-3.5">
                      <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-xs text-muted-foreground">{item.section_name}</p><h3 className="mt-0.5 font-semibold">{UI.table} {item.table_number}</h3></div><Armchair className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" /></div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><span className="text-muted-foreground">Reservadas</span><strong className="mt-0.5 block text-base tabular-nums">{formatInteger(item.reserved_people)}</strong></div><div><span className="text-muted-foreground">Check-in</span><strong className="mt-0.5 block text-base tabular-nums">{formatInteger(item.checked_in_people)}</strong></div></div>
                    </article>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/80 shadow-sm">
            <CardHeader>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3"><span className="rounded-lg bg-muted p-2 text-muted-foreground"><Table2 className="h-4 w-4" aria-hidden="true" /></span><div><CardTitle className="text-base">{UI.detailsTitle}</CardTitle><CardDescription className="mt-1">{UI.detailsDescription}</CardDescription></div></div>
                <div className="w-full space-y-1 sm:w-52">
                  <Label htmlFor="occupancy-list-outcome" className="text-xs">{UI.listOutcome}</Label>
                  <Select value={outcome} onValueChange={(value) => setFilterParam('capacity_outcome', value)}>
                    <SelectTrigger id="occupancy-list-outcome" className="h-9" aria-label={UI.listOutcome}><SelectValue /></SelectTrigger>
                    <SelectContent>{OCCUPANCY_CAPACITY_OUTCOMES.map((item) => <SelectItem key={item} value={item}>{OUTCOME_LABELS[item]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {report.details.length === 0 ? <p className="px-4 py-12 text-center text-sm text-muted-foreground">{UI.emptyDetails}</p> : (
                <>
                  <div className="divide-y divide-border md:hidden">{report.details.map((row) => <MobileReservationCard key={row.id} row={row} />)}</div>
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader><TableRow><TableHead>{UI.guest}</TableHead><TableHead>{UI.dateTime}</TableHead><TableHead className="text-center">{UI.people}</TableHead><TableHead>{UI.mode}</TableHead><TableHead>{UI.table}</TableHead><TableHead>{UI.capacityBase}</TableHead><TableHead>{UI.status}</TableHead></TableRow></TableHeader>
                      <TableBody>{report.details.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell><div className="font-medium">{row.guest_name}</div><div className="text-xs text-muted-foreground">{formatPhone(row.guest_phone)}</div></TableCell>
                          <TableCell className="tabular-nums"><div>{formatDate(row.date)}</div><div className="text-xs text-muted-foreground">{formatTime(row.time)}</div></TableCell>
                          <TableCell className="text-center font-medium tabular-nums">{formatInteger(row.party_size)}</TableCell>
                          <TableCell><Badge variant="secondary">{MODE_LABELS[row.availability_mode]}</Badge></TableCell>
                          <TableCell>{row.table_number ? `${UI.table} ${row.table_number}` : '\u2014'}{row.section_name && <div className="text-xs text-muted-foreground">{row.section_name}</div>}</TableCell>
                          <TableCell><DataQualityBadge quality={row.data_quality} /></TableCell>
                          <TableCell><Badge variant="outline">{getReservationStatusLabel(row.status)}</Badge></TableCell>
                        </TableRow>
                      ))}</TableBody>
                    </Table>
                  </div>
                </>
              )}
              <footer className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">{formatInteger(report.meta.details_total)} reservas \u00b7 p\u00e1gina {report.meta.page} {UI.of} {totalPages}</p>
                <nav className="flex gap-2" aria-label="Paginação das reservas"><Button size="sm" variant="outline" onClick={() => setPage(Math.max(1, page - 1))} disabled={report.meta.page <= 1 || reportQuery.isFetching}><ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />Anterior</Button><Button size="sm" variant="outline" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={report.meta.page >= totalPages || reportQuery.isFetching}>Pr\u00f3xima<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" /></Button></nav>
              </footer>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </ReportShell>
  );
}
