import { useCallback, useMemo } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
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
  ArrowRight,
  CalendarDays,
  Filter,
  MousePointerClick,
  Sparkles,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import ReservationFunnelChart from '@/components/ReservationFunnelChart';
import ReportFilterBar, { REPORT_FILTER_TOGGLE_CLASS } from '@/components/reports/ReportFilterBar';
import ReportMetricCard from '@/components/reports/ReportMetricCard';
import ReportShell from '@/components/reports/ReportShell';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  type DemandConversionEntryFilter,
  getDemandConversionErrorMessage,
  useDemandConversionReport,
} from '@/hooks/useDemandConversionReport';
import {
  type DemandEntryModeTrendPoint,
  useDemandTemporalAnalysis,
} from '@/hooks/useDemandTemporalAnalysis';
import { useReportFilters } from '@/hooks/useReportFilters';
import type { ReportGranularity } from '@/lib/report-filters';
import { type ReservationOriginKey } from '@/lib/reservation-origin';
import { cn } from '@/lib/utils';

// The report no longer lists individual reservations, but the RPC contract still
// requires a valid page window. Asking for the smallest page keeps the response
// free of personal data we do not render.
const DETAILS_PAGE_SIZE = 1;
const numberFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ENTRY_COLORS: Record<ReservationOriginKey, string> = {
  online: 'hsl(202 89% 48%)',
  affiliate: 'hsl(145 63% 42%)',
  manual: 'hsl(0 0% 35%)',
  waitlist: 'hsl(338 78% 55%)',
};

type EntryTrendMetricKey = Exclude<keyof DemandEntryModeTrendPoint, 'period'>;

const ENTRY_ORIGINS: Array<{
  key: ReservationOriginKey;
  label: string;
  reservationsKey: EntryTrendMetricKey;
  peopleKey: EntryTrendMetricKey;
}> = [
  { key: 'online', label: 'Online', reservationsKey: 'online_reservations', peopleKey: 'online_people' },
  { key: 'affiliate', label: 'Filiados e parceiros', reservationsKey: 'affiliate_reservations', peopleKey: 'affiliate_people' },
  { key: 'manual', label: 'Criada no painel', reservationsKey: 'manual_reservations', peopleKey: 'manual_people' },
  { key: 'waitlist', label: 'Convertida da fila', reservationsKey: 'waitlist_reservations', peopleKey: 'waitlist_people' },
];

type DemandEvolutionLens = 'journey' | 'created' | 'entry_created' | 'entry_visit' | 'lead_time';
type DemandEvolutionMetric = 'reservations' | 'people';

const DEMAND_LENSES: Array<{ key: DemandEvolutionLens; label: string }> = [
  { key: 'journey', label: 'Jornada' },
  { key: 'created', label: 'Reservas criadas' },
  { key: 'entry_created', label: 'Entrada por captação' },
  { key: 'entry_visit', label: 'Entrada por visita' },
  { key: 'lead_time', label: 'Antecedência' },
];

function isDemandLens(value: string | null): value is DemandEvolutionLens {
  return DEMAND_LENSES.some((lens) => lens.key === value);
}

function isDemandMetric(value: string | null): value is DemandEvolutionMetric {
  return value === 'reservations' || value === 'people';
}

function isEntryFilter(value: string | null): value is DemandConversionEntryFilter {
  return value === 'all' || value === 'online' || value === 'affiliate' || value === 'manual' || value === 'waitlist';
}

function formatInteger(value: number) {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  return `${decimalFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function formatRelativeComparison(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 'Sem mudança vs. período anterior' : 'Sem base no período anterior';
  const change = ((current - previous) / previous) * 100;
  const prefix = change > 0 ? '+' : '';
  return `${prefix}${decimalFormatter.format(change)}% vs. período anterior`;
}

function formatPointComparison(current: number, previous: number) {
  const change = current - previous;
  const prefix = change > 0 ? '+' : '';
  return `${prefix}${decimalFormatter.format(change)} p.p. vs. período anterior`;
}

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours}h ${minutes}min` : `${hours}h`;
}

function formatDate(value: string) {
  const date = parseISO(value);
  return isValid(date) ? format(date, 'dd/MM/yyyy', { locale: ptBR }) : value;
}

function formatTrendPeriod(value: string, granularity: ReportGranularity) {
  const date = parseISO(value);
  if (!isValid(date)) return value;
  if (granularity === 'month') return format(date, 'MMM/yy', { locale: ptBR }).replace('.', '');
  return format(date, granularity === 'week' ? "dd/MM" : 'dd/MM', { locale: ptBR });
}

function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-label="Carregando relatório" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
      </div>
      <Skeleton className="h-[390px] rounded-xl" />
      <Skeleton className="h-[380px] rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

export default function DemandConversionReport() {
  const { companyId, companyName, companyTimeZone, companyTimeZoneResolved } = useCompanySlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useReportFilters({
    defaultPreset: 'last_30_days',
    defaultComparisonEnabled: true,
    timeZone: companyTimeZone,
  });
  const uniqueOnly = searchParams.get('unique') === '1';
  const entryMode: DemandConversionEntryFilter = isEntryFilter(searchParams.get('entry'))
    ? searchParams.get('entry') as DemandConversionEntryFilter
    : 'all';
  const evolutionLens: DemandEvolutionLens = isDemandLens(searchParams.get('analysis'))
    ? searchParams.get('analysis') as DemandEvolutionLens
    : 'journey';
  const evolutionMetric: DemandEvolutionMetric = isDemandMetric(searchParams.get('metric'))
    ? searchParams.get('metric') as DemandEvolutionMetric
    : 'reservations';

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(updates).forEach(([key, value]) => {
        if (!value) next.delete(key);
        else next.set(key, value);
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const reportQuery = useDemandConversionReport({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    uniqueOnly,
    comparisonEnabled: filters.comparisonEnabled,
    granularity: filters.granularity,
    page: 1,
    pageSize: DETAILS_PAGE_SIZE,
    entryMode,
    enabled: companyTimeZoneResolved && !filters.rangeError,
  });
  const temporalQuery = useDemandTemporalAnalysis({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    granularity: filters.granularity,
    enabled: companyTimeZoneResolved && !filters.rangeError,
  });
  const report = reportQuery.data;
  const temporal = temporalQuery.data;
  const trendHasData = !!report && report.trend.some((point) => (
    point.page_views > 0 || point.completed > 0 || point.created_reservations > 0
  ));
  const transitionHasData = !!report && report.transition_times.some((transition) => transition.sample_size > 0);
  const leadTimeHasData = !!report && report.lead_time_bands.some((band) => band.reservations > 0);
  const partySizeHasData = !!report && report.party_size_bands.some((band) => band.reservations > 0);
  const selectedEntryTrend = useMemo(
    () => evolutionLens === 'entry_visit'
      ? temporal?.entry_mode_visit_trend ?? []
      : temporal?.entry_mode_created_trend ?? [],
    [evolutionLens, temporal?.entry_mode_created_trend, temporal?.entry_mode_visit_trend],
  );
  const visitEntryTrend = useMemo(
    () => temporal?.entry_mode_visit_trend ?? [],
    [temporal?.entry_mode_visit_trend],
  );
  const selectedEntrySummary = useMemo(() => {
    const origins = ENTRY_ORIGINS.map((origin) => ({
      ...origin,
      reservations: selectedEntryTrend.reduce((total, point) => total + point[origin.reservationsKey], 0),
      people: selectedEntryTrend.reduce((total, point) => total + point[origin.peopleKey], 0),
    }));
    const totalReservations = origins.reduce((total, origin) => total + origin.reservations, 0);
    const totalPeople = origins.reduce((total, origin) => total + origin.people, 0);

    return {
      totalReservations,
      totalPeople,
      origins: origins.map((origin) => ({
        ...origin,
        percentage: totalReservations > 0 ? (origin.reservations / totalReservations) * 100 : 0,
      })),
    };
  }, [selectedEntryTrend]);
  const isEntryEvolution = evolutionLens === 'entry_created' || evolutionLens === 'entry_visit';
  const visitEntryTrendHasData = visitEntryTrend.some((point) => (
    point.online_reservations + point.affiliate_reservations
    + point.manual_reservations + point.waitlist_reservations
  ) > 0);
  const selectedEvolutionHasData = evolutionLens === 'journey'
    ? trendHasData
    : evolutionLens === 'created'
      ? !!report && report.trend.some((point) => point.created_reservations > 0 || point.created_people > 0)
      : evolutionLens === 'lead_time'
        ? !!temporal && temporal.lead_time_trend.some((point) => point.scheduled_reservations > 0)
        : selectedEntryTrend.some((point) => (
            point.online_reservations + point.affiliate_reservations
            + point.manual_reservations + point.waitlist_reservations
          ) > 0);

  const refreshReport = () => {
    void reportQuery.refetch();
    void temporalQuery.refetch();
  };

  return (
    <ReportShell
      title="Demanda & Conversão"
      description={`Entenda onde as jornadas avançam, onde param e com quanta antecedência as reservas de ${companyName} são criadas.`}
      icon={MousePointerClick}
      eyebrow="Relatório avançado"
      updatedAt={report?.meta.generated_at}
      isRefreshing={(reportQuery.isFetching || temporalQuery.isFetching) && !!report}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching || temporalQuery.isFetching}
      filters={(
        <ReportFilterBar
          filters={filters}
          isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching || temporalQuery.isFetching}
          onRefresh={refreshReport}
        >
          <div className={REPORT_FILTER_TOGGLE_CLASS}>
            <Label htmlFor="demand-unique" className="cursor-pointer whitespace-nowrap text-xs">Visitantes únicos</Label>
            <Switch
              id="demand-unique"
              checked={uniqueOnly}
              onCheckedChange={(checked) => updateParams({ unique: checked ? '1' : null })}
            />
          </div>
        </ReportFilterBar>
      )}
    >
      {filters.rangeError && (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" aria-hidden="true" /><AlertTitle>Período inválido</AlertTitle><AlertDescription>{filters.rangeError}</AlertDescription></Alert>
      )}

      {!filters.rangeError && (!companyTimeZoneResolved || reportQuery.isPending) && <ReportSkeleton />}

      {!filters.rangeError && reportQuery.isError && !report && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Não foi possível abrir o relatório</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{getDemandConversionErrorMessage(reportQuery.error)}</span>
            <Button variant="outline" size="sm" onClick={() => reportQuery.refetch()}>Tentar novamente</Button>
          </AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          {reportQuery.isError && (
            <Alert><AlertCircle className="h-4 w-4" aria-hidden="true" /><AlertTitle>Dados preservados</AlertTitle><AlertDescription>A atualização falhou, então mantivemos a última leitura válida na tela.</AlertDescription></Alert>
          )}

          <section aria-label="Resumo do período" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <ReportMetricCard
              label={uniqueOnly ? 'Visitantes no funil' : 'Sessões no funil'}
              value={formatInteger(report.summary.sessions)}
              detail="Funil web total; não muda com a forma de entrada"
              explanation={uniqueOnly
                ? 'Visitantes distintos que abriram a página de reserva no período. Cada pessoa conta uma vez, mesmo que volte várias vezes.'
                : 'Sessões que abriram a página de reserva no período. A mesma pessoa pode gerar mais de uma sessão.'}
              comparison={report.comparison
                ? formatRelativeComparison(report.summary.sessions, report.comparison.summary.sessions)
                : null}
              icon={MousePointerClick}
              tone="info"
            />
            <ReportMetricCard
              label="Reservas finalizadas"
              value={formatInteger(report.summary.completed)}
              detail={`${formatPercent(report.summary.overall_conversion_rate)} de conversão no funil web total`}
              explanation="Sessões que chegaram ao fim do funil e confirmaram a reserva. A taxa divide as finalizadas pelo total de sessões."
              comparison={report.comparison
                ? formatPointComparison(
                    report.summary.overall_conversion_rate,
                    report.comparison.summary.overall_conversion_rate,
                  )
                : null}
              icon={UserRoundCheck}
              tone="success"
            />
            <ReportMetricCard
              label="Reservas criadas"
              value={formatInteger(report.summary.created_reservations)}
              detail={entryMode === 'all' ? 'Por qualquer forma de entrada no período' : 'Na forma de entrada selecionada'}
              explanation="Reservas registradas no período por qualquer caminho — site, painel, fila de espera ou filiado. Não se limita ao funil web."
              comparison={report.comparison
                ? formatRelativeComparison(
                    report.summary.created_reservations,
                    report.comparison.summary.created_reservations,
                  )
                : null}
              icon={CalendarDays}
              tone="primary"
            />
            <ReportMetricCard
              label="Pessoas reservadas"
              value={formatInteger(report.summary.created_people)}
              detail={`Antecedência média de ${decimalFormatter.format(report.summary.average_lead_days)} dias`}
              explanation="Soma das pessoas de todas as reservas criadas no período. A antecedência média é a distância entre a criação e a data marcada."
              comparison={report.comparison
                ? formatRelativeComparison(report.summary.created_people, report.comparison.summary.created_people)
                : null}
              icon={UsersRound}
              tone="neutral"
            />
          </section>

          <section className="space-y-4" aria-label="Funil e evolução da demanda">
            <div className="[&>*]:min-w-0">
              <ReservationFunnelChart
                data={report.funnel.map((stage) => ({ step: stage.step, count: stage.count }))}
                title="Funil de Reservas"
                description={`${uniqueOnly ? 'Visitantes' : 'Sessões'} que acessaram a página pública no período e avançaram no processo. O percentual ao fim de cada barra é sobre a base inicial.`}
                measurementLabel={uniqueOnly ? 'Visitantes únicos' : 'Sessões'}
                state={reportQuery.isFetching
                  ? 'refreshing'
                  : report.summary.sessions > 0
                    ? 'ready'
                    : 'valid-empty'}
              />
            </div>

            <Card className="min-w-0 border-border shadow-sm">
              <CardHeader className="space-y-3">
                <div>
                  <CardTitle className="text-base">Evolução da demanda</CardTitle>
                  <CardDescription>
                    Alterne a leitura sem perder o período e a granularidade selecionados.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1" role="tablist" aria-label="Análise temporal de demanda">
                    {DEMAND_LENSES.map((lens) => (
                      <Button
                        key={lens.key}
                        type="button"
                        role="tab"
                        size="sm"
                        variant={evolutionLens === lens.key ? 'default' : 'outline'}
                        aria-selected={evolutionLens === lens.key}
                        className="h-8 px-2.5 text-xs"
                        onClick={() => updateParams({ analysis: lens.key === 'journey' ? null : lens.key })}
                      >
                        {lens.label}
                      </Button>
                    ))}
                  </div>
                  {evolutionLens !== 'journey' && evolutionLens !== 'lead_time' && (
                    <div className="inline-flex rounded-md border border-border bg-muted/20 p-0.5" aria-label="Métrica da evolução">
                      {(['reservations', 'people'] as DemandEvolutionMetric[]).map((metric) => (
                        <button
                          key={metric}
                          type="button"
                          className={cn(
                            'rounded px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            evolutionMetric === metric ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                          )}
                          aria-pressed={evolutionMetric === metric}
                          onClick={() => updateParams({ metric: metric === 'reservations' ? null : metric })}
                        >
                          {metric === 'reservations' ? 'Reservas' : 'Pessoas'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!temporalQuery.isError && selectedEvolutionHasData && isEntryEvolution && (
                  <section className="mb-4 space-y-2.5" aria-labelledby="entry-evolution-summary-title">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
                      <div className="min-w-0">
                        <h3 id="entry-evolution-summary-title" className="text-sm font-semibold text-foreground">
                          Formas de entrada das reservas
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {evolutionLens === 'entry_visit'
                            ? 'Distribuição pela data marcada para atendimento; o percentual considera o total de reservas.'
                            : 'Distribuição pela data em que a reserva foi registrada; o percentual considera o total de reservas.'}
                        </p>
                      </div>
                      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        <strong className="font-semibold text-foreground">{formatInteger(selectedEntrySummary.totalReservations)}</strong> reservas
                        {' · '}
                        <strong className="font-semibold text-foreground">{formatInteger(selectedEntrySummary.totalPeople)}</strong> pessoas
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {selectedEntrySummary.origins.map((origin) => (
                        <article
                          key={origin.key}
                          className="min-w-0 rounded-lg border border-border/70 bg-muted/25 px-3 py-2"
                          aria-label={`${origin.label}: ${formatInteger(origin.reservations)} reservas, ${formatPercent(origin.percentage)}, ${formatInteger(origin.people)} pessoas`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: ENTRY_COLORS[origin.key] }}
                                aria-hidden="true"
                              />
                              <span className="truncate">{origin.label}</span>
                            </h4>
                            <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                              {formatPercent(origin.percentage)}
                            </span>
                          </div>
                          <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
                            <span className="text-lg font-semibold tabular-nums text-foreground">
                              {formatInteger(origin.reservations)}
                            </span>
                            <span className="text-[11px] text-muted-foreground">reservas</span>
                            <span className="ml-auto truncate text-[11px] tabular-nums text-muted-foreground">
                              {formatInteger(origin.people)} pessoas
                            </span>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                {temporalQuery.isError && evolutionLens !== 'journey' && evolutionLens !== 'created' ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                    <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Não foi possível carregar esta evolução</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => temporalQuery.refetch()}>
                      Tentar novamente
                    </Button>
                  </div>
                ) : selectedEvolutionHasData ? (
                  <div
                    className="h-[310px] w-full"
                    role="tabpanel"
                    aria-label={`Evolução: ${DEMAND_LENSES.find((lens) => lens.key === evolutionLens)?.label}`}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      {evolutionLens === 'journey' ? (
                        <AreaChart data={report.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <RechartsTooltip labelFormatter={(value) => formatDate(String(value))} contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }} />
                          <Legend iconType="circle" iconSize={7} />
                          <Area type="monotone" dataKey="page_views" name="Página pública" stroke="hsl(var(--info))" fill="transparent" strokeWidth={2} />
                          <Area type="monotone" dataKey="date_selections" name="Seleção de data" stroke="hsl(var(--primary))" fill="transparent" strokeWidth={2} />
                          <Area type="monotone" dataKey="time_selections" name="Seleção de horário" stroke="hsl(var(--warning))" fill="transparent" strokeWidth={2} />
                          <Area type="monotone" dataKey="forms" name="Dados pessoais" stroke="hsl(var(--muted-foreground))" fill="transparent" strokeWidth={2} />
                          <Area type="monotone" dataKey="completed" name="Reserva finalizada" stroke="hsl(var(--success))" fill="transparent" strokeWidth={2.5} />
                        </AreaChart>
                      ) : evolutionLens === 'created' ? (
                        <ComposedChart data={report.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <RechartsTooltip labelFormatter={(value) => formatDate(String(value))} contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }} />
                          <Legend iconType="circle" iconSize={7} />
                          <Bar dataKey={evolutionMetric === 'people' ? 'created_people' : 'created_reservations'} name={evolutionMetric === 'people' ? 'Pessoas' : 'Reservas'} fill="hsl(var(--primary))" radius={[5, 5, 0, 0]} maxBarSize={44} />
                        </ComposedChart>
                      ) : evolutionLens === 'lead_time' ? (
                        <ComposedChart data={temporal?.lead_time_trend ?? []} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis yAxisId="count" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <YAxis yAxisId="days" orientation="right" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <RechartsTooltip labelFormatter={(value) => formatDate(String(value))} contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }} />
                          <Legend iconType="circle" iconSize={7} />
                          <Bar yAxisId="count" dataKey="scheduled_reservations" name="Reservas agendadas" fill="hsl(var(--primary))" radius={[5, 5, 0, 0]} maxBarSize={42} />
                          <Bar yAxisId="count" dataKey="same_day_reservations" name="Mesmo dia" fill="hsl(var(--warning))" radius={[5, 5, 0, 0]} maxBarSize={42} />
                          <Line yAxisId="days" type="monotone" dataKey="average_lead_days" name="Antecedência média (dias)" stroke="hsl(var(--info))" strokeWidth={2.5} dot={{ r: 2.5 }} />
                        </ComposedChart>
                      ) : (
                        <BarChart data={selectedEntryTrend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                          <RechartsTooltip
                            labelFormatter={(value) => formatDate(String(value))}
                            formatter={(value: number, name: string) => [
                              `${formatInteger(value)} ${evolutionMetric === 'people' ? 'pessoas' : 'reservas'}`,
                              name,
                            ]}
                            contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}
                          />
                          <Legend iconType="circle" iconSize={7} />
                          {ENTRY_ORIGINS.map((origin) => (
                            <Bar
                              key={origin.key}
                              dataKey={evolutionMetric === 'people' ? origin.peopleKey : origin.reservationsKey}
                              name={origin.label}
                              stackId="entry-mode"
                              fill={ENTRY_COLORS[origin.key]}
                              maxBarSize={48}
                            />
                          ))}
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                    <CalendarDays className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Sem dados para esta leitura</p>
                    <p className="mt-1 max-w-sm text-xs text-muted-foreground">Escolha outra análise ou amplie o período.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <Alert className="border-info/30 bg-info-soft/50">
            <Sparkles className="h-4 w-4 text-info" aria-hidden="true" />
            <AlertTitle>Como ler as etapas</AlertTitle>
            <AlertDescription>
              “Seleção de data” e “Seleção de horário” medem o avanço da jornada. Esta versão não atribui quais datas ou horários foram procurados nem declara indisponibilidade sem captura específica.
            </AlertDescription>
          </Alert>

          <section className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Tempo entre etapas</CardTitle>
                <CardDescription>Mediana calculada somente em sessões com as duas etapas registradas.</CardDescription>
              </CardHeader>
              <CardContent className={cn(transitionHasData && 'space-y-1.5')}>
                {transitionHasData ? report.transition_times.filter((transition) => transition.sample_size > 0).map((transition) => (
                  <div key={transition.key} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-1 text-xs font-medium text-foreground">
                        {transition.from_label}
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {transition.to_label}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {formatInteger(transition.sample_size)} amostras
                      </p>
                    </div>
                    <span className="shrink-0 text-lg font-semibold tabular-nums tracking-tight">
                      {formatSeconds(transition.median_seconds)}
                    </span>
                  </div>
                )) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">Sem amostra suficiente para calcular o tempo entre etapas.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Antecedência das reservas criadas</CardTitle>
                <CardDescription>Distância entre a criação e a data marcada, no fuso da empresa.</CardDescription>
              </CardHeader>
              <CardContent>
                {leadTimeHasData ? <>
                <div className="h-[290px] w-full" role="img" aria-label="Distribuição das reservas criadas por faixa de antecedência">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.lead_time_bands} layout="vertical" margin={{ top: 0, right: 16, left: 16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="label" width={112} axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
                      <RechartsTooltip formatter={(value: number) => [formatInteger(value), 'Reservas']} contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }} />
                      <Bar dataKey="reservations" fill="hsl(var(--primary))" radius={[0, 6, 6, 0]} maxBarSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="sr-only">
                  {report.lead_time_bands.map((band) => `${band.label}: ${formatInteger(band.reservations)} reservas`).join('; ')}.
                </p>
                </> : (
                  <p className="py-10 text-center text-sm text-muted-foreground">Nenhuma reserva criada neste recorte.</p>
                )}
              </CardContent>
            </Card>
          </section>

          <Card className="border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Perfil da demanda</CardTitle>
              <CardDescription>
                Tamanho dos grupos nas reservas criadas. A distribuição usa pessoas por reserva e não depende de mesa ou seção.
              </CardDescription>
            </CardHeader>
            <CardContent className={cn(partySizeHasData && 'grid gap-3 sm:grid-cols-2 xl:grid-cols-4')}>
              {partySizeHasData ? report.party_size_bands.map((band, index) => {
                const previous = report.comparison?.party_size_bands[index];
                return (
                  <article key={band.key} className="rounded-lg bg-muted/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate text-xs font-semibold text-foreground">{band.label}</h3>
                      <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                        {formatPercent(band.percentage)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="text-xl font-semibold tabular-nums">{formatInteger(band.reservations)}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        reservas · {formatInteger(band.people)} pessoas
                      </span>
                    </div>
                    <Progress
                      value={band.percentage}
                      className="mt-2 h-1.5"
                      aria-label={`${band.label}: ${formatPercent(band.percentage)} das reservas criadas`}
                    />
                    {previous && (
                      <p className="mt-1.5 text-[11px] font-medium text-foreground/75">
                        {formatPointComparison(band.percentage, previous.percentage)}
                      </p>
                    )}
                  </article>
                );
              }) : (
                <p className="py-10 text-center text-sm text-muted-foreground">Nenhum grupo reservado neste recorte.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-border shadow-sm">
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="text-base">Formas de entrada</CardTitle>
                <CardDescription>
                  Os cartões filtram as análises de reservas criadas. A evolução abaixo usa a data marcada para a visita; o funil web permanece total.
                </CardDescription>
              </div>
              <div className="inline-flex shrink-0 self-start rounded-md border border-border bg-muted/20 p-0.5" aria-label="Métrica das formas de entrada">
                {(['reservations', 'people'] as DemandEvolutionMetric[]).map((metric) => (
                  <button
                    key={metric}
                    type="button"
                    className={cn(
                      'rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      evolutionMetric === metric ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-pressed={evolutionMetric === metric}
                    onClick={() => updateParams({ metric: metric === 'reservations' ? null : metric })}
                  >
                    {metric === 'reservations' ? 'Reservas' : 'Pessoas'}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {report.entry_modes.map((mode) => {
                  const active = entryMode === mode.key;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => updateParams({ entry: active ? null : mode.key })}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active ? 'border-primary bg-primary/5' : 'border-transparent bg-muted/40 hover:bg-muted/70',
                      )}
                      aria-pressed={active}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ENTRY_COLORS[mode.key] }} aria-hidden="true" />
                          <span className="truncate">{mode.label}</span>
                        </span>
                        <Filter className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                      </div>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-xl font-semibold tabular-nums">{formatInteger(mode.reservations)}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {formatPercent(mode.percentage)} · {formatInteger(mode.people)} pessoas
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <section
                className="rounded-xl border border-border/70 bg-background/70 p-3"
                aria-label="Evolução das formas de entrada"
              >
                <div className="mb-3">
                  <h3 className="text-sm font-medium text-foreground">
                    Forma de entrada por {filters.granularity === 'day' ? 'dia' : filters.granularity === 'week' ? 'semana' : 'mês'}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Uma barra empilhada por data da visita, mostrando como as reservas foram registradas.
                  </p>
                </div>

                {temporalQuery.isError ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                    <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Não foi possível carregar a evolução das formas de entrada</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => temporalQuery.refetch()}>
                      Tentar novamente
                    </Button>
                  </div>
                ) : temporalQuery.isFetching && !temporal ? (
                  <Skeleton className="h-[310px] w-full rounded-lg" />
                ) : visitEntryTrendHasData ? (
                  <div
                    className="h-[310px] w-full"
                    role="img"
                    aria-label={`Formas de entrada por ${filters.granularity === 'day' ? 'dia' : filters.granularity === 'week' ? 'semana' : 'mês'}, em ${evolutionMetric === 'people' ? 'pessoas' : 'reservas'}`}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={visitEntryTrend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                        <RechartsTooltip
                          labelFormatter={(value) => formatDate(String(value))}
                          formatter={(value: number, name: string) => [
                            `${formatInteger(value)} ${evolutionMetric === 'people' ? 'pessoas' : 'reservas'}`,
                            name,
                          ]}
                          contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}
                        />
                        <Legend iconType="circle" iconSize={7} />
                        {ENTRY_ORIGINS.map((origin) => (
                          <Bar
                            key={origin.key}
                            dataKey={evolutionMetric === 'people' ? origin.peopleKey : origin.reservationsKey}
                            name={origin.label}
                            stackId="entry-mode-over-time"
                            fill={ENTRY_COLORS[origin.key]}
                            maxBarSize={48}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                    <CalendarDays className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Nenhuma forma de entrada neste período</p>
                    <p className="mt-1 text-xs text-muted-foreground">Amplie o período para consultar a evolução.</p>
                  </div>
                )}
              </section>
            </CardContent>
          </Card>

        </>
      )}

    </ReportShell>
  );
}
