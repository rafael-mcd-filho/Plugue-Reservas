import { useEffect, useMemo, useState } from 'react';
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
import { ReportKpiStrip, ReportKpiStripSkeleton, ReportKpiTile } from '@/components/reports/ReportKpiStrip';
import ReportShell from '@/components/reports/ReportShell';
import ReportAnalysisPanel from '@/components/reports/ReportAnalysisPanel';
import ReportRecordsSheet from '@/components/reports/ReportRecordsSheet';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useOccupancyCapacityReport } from '@/hooks/useOccupancyCapacityReport';
import { useOccupancyWaitlistSeries } from '@/hooks/useOccupancyWaitlistSeries';
import { useReportFilters } from '@/hooks/useReportFilters';
import {
  OCCUPANCY_CAPACITY_MODES,
  OCCUPANCY_CAPACITY_OUTCOMES,
  buildOccupancyCapacityRpcParams,
  normalizeOccupancyCapacityReport,
  type OccupancyCapacityHeatmapCell,
  type OccupancyCapacityModeFilter,
  type OccupancyCapacityOutcomeFilter,
  type OccupancyCapacityReservationRow,
} from '@/lib/occupancy-capacity-report';
import { buildCapacityInsights, buildCapacityMatrix, capacityMatrixValue, filterOccupancyRecords, getCapacityPeriodWindow, retainCapacityMatrixContributors, type CapacityMatrixMetric, type OccupancyRecordSelection } from '@/lib/occupancy-capacity-analysis';
import { loadCompleteReportRecords, type ReportReservationRecord } from '@/lib/report-records';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

// Detail pages are loaded only when a person opens an indicator or matrix cell.
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
  capacity: 'Lugares ofertados',
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
  heatmapTitle: 'Dias e horários',
  heatmapDescription: 'Compare os mesmos horários entre os dias da semana. Os valores somam todas as ocorrências do período selecionado.',
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
  capacityHelp: 'Soma dos lugares publicados em cada horário e dia do período. É oferta acumulada, não a lotação física simultânea da casa. A lista de reservas desse recorte não representa lugares individualizados.',
  pressureHelp: 'Pessoas reservadas divididas pela capacidade publicada, ambas somadas no mesmo período. Inclui reservas que terminaram em no-show.',
  occupancyHelp: 'Pessoas que fizeram check-in divididas pela capacidade publicada do período.',
  waitlistHelp: 'Entradas registradas na fila de espera no período. O tempo médio de espera considera apenas quem chegou a ser sentado.',
  noShowHelp: 'Reservas que não compareceram e possuem horário publicado correspondente. Canceladas e pagamentos expirados ficam fora. A análise por horário também permite investigar no-shows sem base publicada.',
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
      <ReportKpiStripSkeleton count={5} />
      <Skeleton className="h-[360px] rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-[340px] rounded-xl" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
    </div>
  );
}

function Heatmap({ cells, metric, onMetricChange, onSelect }: {
  cells: OccupancyCapacityHeatmapCell[];
  metric: CapacityMatrixMetric;
  onMetricChange: (metric: CapacityMatrixMetric) => void;
  onSelect: (cell: OccupancyCapacityHeatmapCell) => void;
}) {
  const matrix = useMemo(() => buildCapacityMatrix(cells), [cells]);
  const labels = { offer: 'Oferta', reserved: 'Reservas', checked_in: 'Check-ins' };
  if (matrix.rows.length === 0) {
    return <p className="py-14 text-center text-sm text-muted-foreground">{UI.noBase}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-muted/30 p-1" aria-label="Métrica da matriz">
          {(Object.keys(labels) as CapacityMatrixMetric[]).map(value => (
            <button key={value} type="button" aria-pressed={metric === value} onClick={() => onMetricChange(value)} className={cn('min-h-9 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', metric === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {labels[value]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{metric === 'offer' ? 'Lugares ofertados · soma dos horários publicados' : 'Pessoas / lugares ofertados · taxa sobre a oferta'}</p>
      </div>
      <div className="max-w-full overflow-x-auto rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} role="region" aria-label="Matriz por dia da semana e horário; role para ver todos os horários">
        <table className="w-full border-separate border-spacing-0 text-left" aria-label={`Matriz de ${labels[metric].toLowerCase()} por dia e horário`}>
          <caption className="sr-only">Dias da semana nas linhas e horários nas colunas. Selecione uma célula para abrir as reservas desse recorte.</caption>
          <thead><tr><th scope="col" className="sticky left-0 z-10 min-w-20 border-b border-border bg-card px-3 py-3 text-xs font-semibold">Dia</th>{matrix.times.map(time => <th key={time} scope="col" className="min-w-36 border-b border-border bg-muted/20 px-2 py-3 text-center text-xs font-semibold">{formatTime(time)}</th>)}</tr></thead>
          <tbody>{matrix.rows.map(day => <tr key={day.weekday}>
            <th scope="row" className="sticky left-0 z-10 border-b border-border bg-card px-3 py-3 text-xs font-semibold">{day.label}</th>
            {day.cells.map((cell, index) => {
              if (!cell) return <td key={matrix.times[index]} className="border-b border-border p-1 text-center text-muted-foreground"><span aria-label="Sem horário publicado">—</span></td>;
              const value = capacityMatrixValue(cell, metric);
              return <td key={cell.time_slot} className="border-b border-border p-1">
                <button type="button" onClick={() => onSelect(cell)} aria-label={`Abrir reservas de ${day.label} às ${formatTime(cell.time_slot)}: ${formatInteger(value.people)} ${metric === 'offer' ? 'lugares ofertados' : 'pessoas'}`} className={cn('flex min-h-24 w-full flex-col items-center justify-center rounded-lg border px-3 py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', metric === 'offer' ? 'border-primary/15 bg-primary/5 text-foreground' : heatTone(value.rate ?? 0))}>
                  <strong className="text-base tabular-nums">{formatInteger(value.people)}{metric !== 'offer' && <span className="text-xs font-normal opacity-80"> / {formatInteger(cell.published_capacity)}</span>}</strong>
                  {metric !== 'offer' && <span className="text-xs font-medium tabular-nums">{value.rate === null ? 'Sem base para taxa' : formatPercent(value.rate)}</span>}
                  <span className="mt-1 text-[11px] opacity-80">{cell.slot_count} {cell.slot_count === 1 ? 'horário' : 'horários'} · {cell.data_quality === 'snapshot' ? 'Histórico' : cell.data_quality === 'mixed' ? 'Base mista' : 'Estimativa'}</span>
                </button>
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Legenda da matriz">
        {metric !== 'offer' && <><span>0%: sem pessoas registradas</span><span>Até 79%: abaixo da oferta</span><span>80–99%: próximo da oferta</span><span>100% ou mais: oferta atingida</span></>}
        <span>—: sem horário publicado</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">A matriz é uma análise acumulada do período. Não representa a ocupação física simultânea do salão. A oferta informa o contexto; ao selecionar uma célula, são abertas as reservas correspondentes, conforme a métrica.</p>
    </div>
  );
}

export default function OccupancyCapacityReport() {
  const { companyId, slug, companyTimeZone, companyTimeZoneResolved } = useCompanySlug();
  const [selectedRecords, setSelectedRecords] = useState<OccupancyRecordSelection | null>(null);
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
  const matrixMetric: CapacityMatrixMetric = ['offer', 'reserved', 'checked_in'].includes(searchParams.get('capacity_matrix') ?? '')
    ? searchParams.get('capacity_matrix') as CapacityMatrixMetric : 'reserved';
  useEffect(() => { setSelectedRecords(null); }, [companyId, filters.dateOnlyRange.from, filters.dateOnlyRange.to, availabilityMode]);

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

  const loadSelectedRecords = async (signal?: AbortSignal): Promise<ReportReservationRecord[]> => {
    if (!companyId || !selectedRecords) return [];
    const rows = await loadCompleteReportRecords<OccupancyCapacityReservationRow>({
      signal,
      fetchPage: async page => {
        const params = buildOccupancyCapacityRpcParams({
          companyId,
          periodStart: filters.dateOnlyRange.from,
          periodEnd: filters.dateOnlyRange.to,
          granularity: filters.granularity,
          availabilityMode,
          outcome: 'all',
          page,
          pageSize: 100,
        });
        let request = (supabase as any).rpc('get_occupancy_capacity_report', params);
        if (signal && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
        const { data, error } = await request;
        if (error) throw error;
        const response = normalizeOccupancyCapacityReport(data, params);
        return { rows: response.details, total: response.meta.details_total };
      },
    });
    let selectedRows = filterOccupancyRecords(rows, selectedRecords);
    // In a matrix cell, the published slot's mode must also match. A legacy
    // reservation's created mode alone is not enough to prove contribution.
    if (availabilityMode !== 'all' && selectedRecords.weekday !== undefined) {
      selectedRows = await retainCapacityMatrixContributors(selectedRows, selectedRecords, async date => {
        const params = buildOccupancyCapacityRpcParams({
          companyId, periodStart: date, periodEnd: date, granularity: 'day',
          availabilityMode, outcome: 'all', page: 1, pageSize: 1,
        });
        let request = (supabase as any).rpc('get_occupancy_capacity_report', params);
        if (signal && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
        const { data, error } = await request;
        if (error) throw error;
        return normalizeOccupancyCapacityReport(data, params).heatmap;
      }, signal);
    }
    return selectedRows.map(row => ({
      id: row.id, guest_name: row.guest_name, date: row.date, time: row.time,
      party_size: row.party_size, status: row.status,
      note: row.outcome === 'checked_in'
        ? `${row.checked_in_party_size ?? row.party_size} pessoas com check-in`
        : `${row.party_size} pessoas reservadas`,
    }));
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

          <ReportKpiStrip aria-label="Indicadores">
            <ReportKpiTile
              label={UI.capacity}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatInteger(report.summary.published_capacity)}
              detail={qualityLabel(report.meta.capacity_history)}
              explanation={UI.capacityHelp}
              icon={CalendarRange}
              onClick={() => setSelectedRecords({ title: 'Reservas associadas à oferta do período', metric: 'offer' })}
            />
            <ReportKpiTile
              label={UI.pressure}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.capacity_pressure_rate)}
              detail={report.meta.capacity_history === 'unavailable' ? UI.noBase : pressureComparisonDetail}
              explanation={UI.pressureHelp}
              icon={Users}
              onClick={() => setSelectedRecords({ title: 'Reservas da pressão da demanda', metric: 'reserved' })}
            />
            <ReportKpiTile
              label={UI.occupancy}
              value={report.meta.capacity_history === 'unavailable' ? '\u2014' : formatPercent(report.summary.check_in_capacity_rate)}
              detail={`${formatInteger(report.summary.checked_in_people)} ${UI.checkins}`}
              explanation={UI.occupancyHelp}
              icon={CheckCircle2}
              onClick={() => setSelectedRecords({ title: 'Reservas com check-in e base de capacidade', metric: 'checked_in' })}
            />
            <ReportKpiTile
              label={UI.waitlist}
              value={formatInteger(report.summary.waitlist_entries)}
              detail={`${formatMinutes(report.summary.average_wait_minutes)} ${UI.waitlistDetail}`}
              explanation={UI.waitlistHelp}
              icon={Clock3}
            />
            <ReportKpiTile
              label={UI.noShow}
              value={formatInteger(report.summary.no_show_reservations)}
              detail={`${formatInteger(report.summary.no_show_people)} pessoas \u00b7 ${UI.noShowDetail}`}
              explanation={UI.noShowHelp}
              icon={AlertCircle}
              onClick={() => setSelectedRecords({ title: 'No-shows com base de capacidade', metric: 'no_show' })}
            />
          </ReportKpiStrip>

          <p className="text-xs leading-relaxed text-muted-foreground">Base: {formatDate(filters.dateOnlyRange.from)} a {formatDate(filters.dateOnlyRange.to)} · fuso {companyTimeZone}. Os lugares ofertados e as pessoas são somados por horário; reservas sem base publicada ficam identificadas separadamente.</p>
          <ReportAnalysisPanel insights={buildCapacityInsights(report)}>
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
                        <Bar dataKey="reserved_people" name="Pessoas reservadas" fill="hsl(var(--warning))" radius={[3, 3, 0, 0]} cursor="pointer" onClick={(point: any) => {
                          if (point?.payload?.period) setSelectedRecords({ title: `Reservas de ${formatDate(point.payload.period)}`, metric: 'reserved', ...getCapacityPeriodWindow(point.payload.period, filters.granularity) });
                        }} />
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
            <CardContent><Heatmap cells={report.heatmap} metric={matrixMetric} onMetricChange={value => setViewParam('capacity_matrix', value, 'reserved')} onSelect={cell => setSelectedRecords({
              title: `${matrixMetric === 'checked_in' ? 'Check-ins' : matrixMetric === 'offer' ? 'Reservas na oferta' : 'Reservas'} · ${cell.weekday_label}, ${formatTime(cell.time_slot)}`,
              metric: matrixMetric,
              weekday: cell.weekday,
              timeSlot: cell.time_slot,
            })} /></CardContent>
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
                      <Bar yAxisId="count" dataKey="reservations" name="No-shows" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} cursor="pointer" onClick={(point: any) => {
                        if (point?.payload?.hour) setSelectedRecords({ title: `No-shows às ${formatTime(point.payload.hour)}`, metric: 'no_show', hour: point.payload.hour, basisOnly: false });
                      }} />
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
          </ReportAnalysisPanel>
          {companyId && selectedRecords && <ReportRecordsSheet
            open={!!selectedRecords}
            onOpenChange={open => { if (!open) setSelectedRecords(null); }}
            title={selectedRecords.title}
            description={`${formatDate(filters.dateOnlyRange.from)} a ${formatDate(filters.dateOnlyRange.to)} · ${MODE_LABELS[availabilityMode]}. ${selectedRecords.metric === 'offer' ? 'A oferta é o denominador; esta lista mostra as reservas de demanda associadas aos horários publicados.' : selectedRecords.basisOnly === false ? 'Inclui os resultados do horário mesmo quando não há capacidade publicada correspondente.' : 'Mesma base publicada usada no indicador; a quantidade de registros representa reservas, enquanto os indicadores de pessoas somam os tamanhos dos grupos.'}`}
            companyId={companyId}
            slug={slug ?? ''}
            scopeKey={['capacity', filters.dateOnlyRange.from, filters.dateOnlyRange.to, availabilityMode, report.meta.generated_at, selectedRecords]}
            loadRecords={loadSelectedRecords}
          />}
        </div>
      ) : null}
    </ReportShell>
  );
}
