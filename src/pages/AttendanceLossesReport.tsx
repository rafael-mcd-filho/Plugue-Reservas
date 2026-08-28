import { useCallback, useMemo } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useSearchParams } from 'react-router-dom';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  CalendarX2,
  CheckCircle2,
  Clock3,
  MessageCircle,
  ShieldAlert,
  TicketCheck,
  UserMinus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportMetricCard from '@/components/reports/ReportMetricCard';
import ReportShell from '@/components/reports/ReportShell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useAttendanceLossesReport } from '@/hooks/useAttendanceLossesReport';
import { useAttendanceOutcomeSeries } from '@/hooks/useAttendanceOutcomeSeries';
import { useReportFilters } from '@/hooks/useReportFilters';
import {
  ATTENDANCE_ENTRY_METHODS,
  ATTENDANCE_OUTCOMES,
  type AttendanceEntryMethodFilter,
  type AttendanceLossesAssociation,
  type AttendanceLossesSegment,
  type AttendanceOutcomeFilter,
  type AttendanceSegmentDimension,
} from '@/lib/attendance-losses-report';
import type { ReportGranularity } from '@/lib/report-filters';
import { cn } from '@/lib/utils';

// The report no longer lists individual reservations, but the RPC contract still
// requires a valid page window. Asking for the smallest page keeps the response
// free of personal data we do not render.
const DETAILS_PAGE_SIZE = 1;
const integerFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const OUTCOME_LABELS: Record<AttendanceOutcomeFilter, string> = {
  all: 'Todos os resultados',
  attended: 'Comparecimento',
  no_show: 'No-show',
  cancelled: 'Cancelamento',
  scheduled: 'Agendadas / abertas',
};

const ENTRY_METHOD_LABELS: Record<AttendanceEntryMethodFilter, string> = {
  all: 'Todas as formas',
  online: 'Online',
  affiliate: 'Filiados e parceiros',
  manual: 'Criada no painel',
  waitlist: 'Convertida da fila',
};

const SEGMENT_LABELS: Record<AttendanceSegmentDimension, string> = {
  weekday: 'Dia da semana',
  time_band: 'Faixa horária',
  party_size: 'Tamanho do grupo',
  lead_time: 'Antecedência',
  entry_method: 'Forma de entrada',
};

const CHART_COLORS = {
  attended: 'hsl(var(--success))',
  noShow: 'hsl(var(--destructive))',
  cancelled: 'hsl(var(--warning))',
  scheduled: 'hsl(var(--muted-foreground))',
  grid: 'hsl(var(--border))',
  axis: 'hsl(var(--muted-foreground))',
};

function isOutcomeFilter(value: string | null): value is AttendanceOutcomeFilter {
  return !!value && (ATTENDANCE_OUTCOMES as readonly string[]).includes(value);
}

function isEntryMethodFilter(value: string | null): value is AttendanceEntryMethodFilter {
  return !!value && (ATTENDANCE_ENTRY_METHODS as readonly string[]).includes(value);
}

function isSegmentDimension(value: string | null): value is AttendanceSegmentDimension {
  return !!value && Object.prototype.hasOwnProperty.call(SEGMENT_LABELS, value);
}

function formatInteger(value: number): string {
  return integerFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  return `${decimalFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function formatDateOnly(value: string): string {
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'dd/MM/yyyy', { locale: ptBR }) : value;
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR }) : '—';
}

function formatSeriesPeriod(value: string, granularity: ReportGranularity): string {
  const parsed = parseISO(value);
  if (!isValid(parsed)) return value;
  if (granularity === 'month') return format(parsed, 'MMM/yy', { locale: ptBR }).replace('.', '');
  return format(parsed, 'dd/MM', { locale: ptBR });
}

function Trend({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  const difference = current - previous;
  const favorable = invert ? difference < 0 : difference > 0;
  if (Math.abs(difference) < 0.05) {
    return <span className="text-xs text-muted-foreground">Estável vs. período anterior</span>;
  }

  return (
    <span className={cn('text-xs font-medium', favorable ? 'text-success' : 'text-destructive')}>
      {difference > 0 ? '+' : '−'}{decimalFormatter.format(Math.abs(difference))} p.p. vs. anterior
    </span>
  );
}

function AssociationColumn({
  title,
  icon: Icon,
  rows,
  detail,
}: {
  title: string;
  icon: LucideIcon;
  rows: AttendanceLossesAssociation[];
  detail: string;
}) {
  return (
    <div className="rounded-xl bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-background p-1.5 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-foreground">{title}</h3>
          <p className="text-[11px] text-muted-foreground">{detail}</p>
        </div>
      </div>
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="rounded-lg bg-background px-3 py-2.5">
            <p className="truncate text-xs font-medium text-foreground">{row.label}</p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-lg font-semibold tabular-nums text-foreground">{formatPercent(row.no_show_rate)}</span>
              <span className="text-[11px] text-muted-foreground">no-show</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {formatInteger(row.reservations)} reservas · {formatInteger(row.attended)} comparecimentos
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando relatório">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[340px] rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-[340px] rounded-xl" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
    </div>
  );
}

export default function AttendanceLossesReport() {
  const { companyId, companyName, companyTimeZone, companyTimeZoneResolved } = useCompanySlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const reportFilters = useReportFilters({
    defaultPreset: 'current_month',
    defaultComparisonEnabled: true,
    timeZone: companyTimeZone,
  });
  const outcomeParam = searchParams.get('outcome');
  const entryMethodParam = searchParams.get('entry');
  const segmentParam = searchParams.get('segment');
  const seriesMetric = searchParams.get('attendance_metric') === 'people' ? 'people' : 'reservations';
  const outcome: AttendanceOutcomeFilter = isOutcomeFilter(outcomeParam) ? outcomeParam : 'all';
  const entryMethod: AttendanceEntryMethodFilter = isEntryMethodFilter(entryMethodParam) ? entryMethodParam : 'all';
  const segmentDimension: AttendanceSegmentDimension = isSegmentDimension(segmentParam) ? segmentParam : 'weekday';
  const { dateOnlyRange, rangeError } = reportFilters;

  const reportQuery = useAttendanceLossesReport({
    companyId,
    periodStart: dateOnlyRange.from,
    periodEnd: dateOnlyRange.to,
    outcome,
    entryMethod,
    page: 1,
    pageSize: DETAILS_PAGE_SIZE,
    comparisonEnabled: reportFilters.comparisonEnabled,
    enabled: companyTimeZoneResolved && !rangeError,
  });
  const report = reportQuery.data;
  const seriesQuery = useAttendanceOutcomeSeries({
    companyId,
    periodStart: dateOnlyRange.from,
    periodEnd: dateOnlyRange.to,
    granularity: reportFilters.granularity,
    outcome,
    entryMethod,
    enabled: companyTimeZoneResolved && !rangeError,
  });

  const selectedSegmentRows = report?.segments[segmentDimension] ?? [];
  const segmentHasData = selectedSegmentRows.some((row) => row.reservations > 0);
  const seriesData = seriesQuery.data?.series;
  const seriesHasData = seriesData?.some((row) => row.reservations > 0) ?? false;
  const seriesTotals = useMemo(() => {
    const totals = (seriesData ?? []).reduce((accumulator, point) => ({
      expectedReservations: accumulator.expectedReservations + point.expected_reservations,
      realizedReservations: accumulator.realizedReservations + point.realized_reservations,
      lostReservations: accumulator.lostReservations + point.no_show + point.cancelled,
      expectedPeople: accumulator.expectedPeople + point.expected_people,
      realizedPeople: accumulator.realizedPeople + point.realized_people,
      lostPeople: accumulator.lostPeople + point.lost_people,
    }), {
      expectedReservations: 0,
      realizedReservations: 0,
      lostReservations: 0,
      expectedPeople: 0,
      realizedPeople: 0,
      lostPeople: 0,
    });

    const expected = seriesMetric === 'people'
      ? totals.expectedPeople
      : totals.expectedReservations;
    const realized = seriesMetric === 'people'
      ? totals.realizedPeople
      : totals.realizedReservations;

    return {
      expected,
      realized,
      losses: seriesMetric === 'people' ? totals.lostPeople : totals.lostReservations,
      realizationRate: expected > 0 ? Math.round((realized / expected) * 1000) / 10 : 0,
    };
  }, [seriesData, seriesMetric]);

  const updateUrlFilter = useCallback((key: string, value: string, defaultValue: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      next.delete('attendance_page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const refreshReport = () => {
    void reportQuery.refetch();
    void seriesQuery.refetch();
  };


  return (
    <ReportShell
      title="Comparecimento & Perdas"
      description={`Entenda onde se concentram comparecimentos, no-shows e cancelamentos de ${companyName}, com abertura do histórico de cada reserva.`}
      icon={ShieldAlert}
      eyebrow="Relatório operacional"
      updatedAt={report?.meta.generated_at}
      isRefreshing={(reportQuery.isFetching || seriesQuery.isFetching) && !reportQuery.isLoading}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching || seriesQuery.isFetching}
      filters={(
        <ReportFilterBar
          filters={reportFilters}
          isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching || seriesQuery.isFetching}
          onRefresh={refreshReport}
        >
          <div className="flex min-w-0 flex-1 flex-wrap gap-2 sm:flex-none">
            <div className="min-w-0 flex-1 space-y-1 sm:w-44 sm:flex-none">
              <Label htmlFor="attendance-outcome" className="text-xs">Resultado</Label>
              <Select
                value={outcome}
                onValueChange={(value) => updateUrlFilter('outcome', value, 'all')}
              >
                <SelectTrigger id="attendance-outcome" className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ATTENDANCE_OUTCOMES.map((value) => (
                    <SelectItem key={value} value={value}>{OUTCOME_LABELS[value]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 flex-1 space-y-1 sm:w-44 sm:flex-none">
              <Label htmlFor="attendance-entry" className="text-xs">Forma de entrada</Label>
              <Select
                value={entryMethod}
                onValueChange={(value) => updateUrlFilter('entry', value, 'all')}
              >
                <SelectTrigger id="attendance-entry" className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ATTENDANCE_ENTRY_METHODS.map((value) => (
                    <SelectItem key={value} value={value}>{ENTRY_METHOD_LABELS[value]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </ReportFilterBar>
      )}
    >

      {rangeError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Período inválido</AlertTitle>
          <AlertDescription>{rangeError}</AlertDescription>
        </Alert>
      )}

      {!rangeError && (!companyTimeZoneResolved || reportQuery.isLoading) && <ReportSkeleton />}

      {!rangeError && reportQuery.isError && !report && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Não foi possível carregar o relatório</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Confira sua conexão e tente novamente. O acesso também exige perfil administrador e Relatórios Avançados ativos.</span>
            <Button variant="outline" size="sm" onClick={() => reportQuery.refetch()}>Tentar novamente</Button>
          </AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          {reportQuery.isError && (
            <Alert>
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Dados preservados</AlertTitle>
              <AlertDescription>A atualização falhou, então mantivemos a última leitura válida na tela.</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <ReportMetricCard
              label="Reservas no período"
              value={formatInteger(report.summary.reservations)}
              detail={`${formatInteger(report.summary.reserved_people)} pessoas reservadas`}
              explanation="Todas as reservas com data agendada dentro do período, no fuso da empresa, independentemente do resultado."
              icon={Users}
              tone="primary"
            />
            <ReportMetricCard
              label="Comparecimento"
              value={formatPercent(report.summary.attendance_rate)}
              detail={`${formatInteger(report.summary.attended)} reservas · ${formatInteger(report.summary.attended_people)} pessoas presentes`}
              explanation="Comparecimentos divididos por comparecimentos + no-shows. Reservas canceladas ou ainda abertas ficam fora da base."
              comparison={report.comparison
                ? <Trend current={report.summary.attendance_rate} previous={report.comparison.attendance_rate} />
                : null}
              icon={CheckCircle2}
              tone="success"
            />
            <ReportMetricCard
              label="No-show"
              value={formatPercent(report.summary.no_show_rate)}
              detail={`${formatInteger(report.summary.no_show)} reservas sem comparecimento`}
              explanation="No-shows divididos por comparecimentos + no-shows. Canceladas e abertas ficam fora da taxa."
              comparison={report.comparison
                ? <Trend current={report.summary.no_show_rate} previous={report.comparison.no_show_rate} invert />
                : null}
              icon={CalendarX2}
              tone="danger"
            />
            <ReportMetricCard
              label="Cancelamentos"
              value={formatInteger(report.summary.cancelled)}
              detail={`Taxa combinada de perdas: ${formatPercent(report.summary.loss_rate)}`}
              explanation="Reservas canceladas no período. A taxa de perdas soma cancelamentos e no-shows sobre o total de reservas."
              icon={Clock3}
              tone="warning"
            />
            <ReportMetricCard
              label="Pessoas em perdas"
              value={formatInteger(report.summary.lost_people)}
              detail="Ligadas a no-shows ou cancelamentos"
              explanation="Soma das pessoas das reservas que viraram no-show ou cancelamento. Não estima receita nem assentos não revendidos."
              icon={UserMinus}
              tone="neutral"
            />
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="gap-3 pb-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-base">
                  Evolução {reportFilters.granularity === 'day' ? 'diária' : reportFilters.granularity === 'week' ? 'semanal' : 'mensal'} dos resultados
                </CardTitle>
                <CardDescription>
                  Barras mostram todos os desfechos; a linha mostra realizado ÷ esperado no mesmo período.
                </CardDescription>
              </div>
              <div className="inline-flex self-start rounded-md border border-border bg-muted/20 p-0.5" aria-label="Unidade da evolução">
                {(['reservations', 'people'] as const).map((metric) => (
                  <button
                    key={metric}
                    type="button"
                    className={cn(
                      'rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      seriesMetric === metric ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-pressed={seriesMetric === metric}
                    onClick={() => updateUrlFilter('attendance_metric', metric, 'reservations')}
                  >
                    {metric === 'reservations' ? 'Reservas' : 'Pessoas'}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {seriesQuery.isError ? (
                <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
                  <AlertCircle className="h-7 w-7 text-destructive" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">Não foi possível carregar a evolução</p>
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => seriesQuery.refetch()}>Tentar novamente</Button>
                </div>
              ) : seriesHasData ? (
                <div>
                  <p className="sr-only">
                    No período: {formatInteger(report.summary.attended)} comparecimentos,
                    {' '}{formatInteger(report.summary.no_show)} no-shows,
                    {' '}{formatInteger(report.summary.cancelled)} cancelamentos e
                    {' '}{formatInteger(report.summary.scheduled)} reservas em aberto.
                  </p>
                  <dl
                    className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/20 p-2 sm:grid-cols-4"
                    data-testid="attendance-series-totals"
                    aria-label={`Totais da evolução em ${seriesMetric === 'people' ? 'pessoas' : 'reservas'}`}
                  >
                    <div className="rounded-md bg-card px-2.5 py-2 shadow-sm">
                      <dt className="text-[11px] text-muted-foreground">Esperado</dt>
                      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                        {formatInteger(seriesTotals.expected)}
                      </dd>
                    </div>
                    <div className="rounded-md border border-success/20 bg-success-soft px-2.5 py-2">
                      <dt className="text-[11px] text-muted-foreground">
                        {seriesMetric === 'people' ? 'Compareceram' : 'Check-ins'}
                      </dt>
                      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-success">
                        {formatInteger(seriesTotals.realized)}
                      </dd>
                    </div>
                    <div className="rounded-md bg-card px-2.5 py-2 shadow-sm">
                      <dt className="text-[11px] text-muted-foreground">Perdas</dt>
                      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-destructive">
                        {formatInteger(seriesTotals.losses)}
                      </dd>
                    </div>
                    <div className="rounded-md border border-info/20 bg-info-soft/40 px-2.5 py-2">
                      <dt className="text-[11px] text-muted-foreground">Realização</dt>
                      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-info">
                        {formatPercent(seriesTotals.realizationRate)}
                      </dd>
                    </div>
                  </dl>
                  <div className="h-[330px] w-full" role="img" aria-label={`Gráfico ${reportFilters.granularity === 'day' ? 'diário' : reportFilters.granularity === 'week' ? 'semanal' : 'mensal'} de comparecimentos, no-shows, cancelamentos e reservas em aberto`}>
                    <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={seriesData ?? []} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                      <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="period" tickFormatter={(value) => formatSeriesPeriod(value, reportFilters.granularity)} stroke={CHART_COLORS.axis} tick={{ fontSize: 11 }} minTickGap={24} />
                      <YAxis yAxisId="count" allowDecimals={false} stroke={CHART_COLORS.axis} tick={{ fontSize: 11 }} />
                      <YAxis
                        yAxisId="rate"
                        orientation="right"
                        domain={[0, (dataMax: number) => Math.max(100, Math.ceil(dataMax / 10) * 10)]}
                        tickFormatter={(value) => `${value}%`}
                        stroke="hsl(var(--info))"
                        tick={{ fontSize: 11 }}
                      />
                      <ChartTooltip
                        labelFormatter={(value) => formatDateOnly(String(value))}
                        formatter={(value, name) => [
                          String(name).includes('Realização') ? formatPercent(Number(value)) : formatInteger(Number(value)),
                          name,
                        ]}
                        contentStyle={{ borderRadius: 10, borderColor: 'hsl(var(--border))' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="count" dataKey={seriesMetric === 'people' ? 'attended_people' : 'attended'} name="Comparecimento" stackId="outcome" fill={CHART_COLORS.attended} radius={[3, 3, 0, 0]} />
                      <Bar yAxisId="count" dataKey={seriesMetric === 'people' ? 'no_show_people' : 'no_show'} name="No-show" stackId="outcome" fill={CHART_COLORS.noShow} />
                      <Bar yAxisId="count" dataKey={seriesMetric === 'people' ? 'cancelled_people' : 'cancelled'} name="Cancelamento" stackId="outcome" fill={CHART_COLORS.cancelled} />
                      <Bar yAxisId="count" dataKey={seriesMetric === 'people' ? 'scheduled_people' : 'scheduled'} name="Em aberto" stackId="outcome" fill={CHART_COLORS.scheduled} />
                      <Line
                        yAxisId="rate"
                        type="monotone"
                        dataKey={seriesMetric === 'people' ? 'realized_people_rate' : 'realized_reservation_rate'}
                        name="Realização (compareceu ÷ esperado)"
                        stroke="hsl(var(--info))"
                        strokeWidth={2.5}
                        dot={{ r: 2.5 }}
                      />
                    </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    “Realização” considera comparecimentos sobre todas as reservas/pessoas esperadas. A taxa de comparecimento dos cards continua usando apenas comparecimentos + no-shows.
                  </p>
                </div>
              ) : (
                <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
                  <CalendarX2 className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-foreground">Nenhuma reserva neste recorte</p>
                  <p className="mt-1 text-xs text-muted-foreground">Altere o período ou os filtros para consultar outros resultados.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
            <Card className="border-border shadow-sm">
              <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <CardTitle className="text-base">Onde as perdas se concentram</CardTitle>
                  <CardDescription>Compare volume, no-show e cancelamento por dimensão.</CardDescription>
                </div>
                <Select value={segmentDimension} onValueChange={(value) => updateUrlFilter('segment', value, 'weekday')}>
                  <SelectTrigger className="w-full sm:w-[190px]" aria-label="Dimensão da segmentação"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SEGMENT_LABELS) as AttendanceSegmentDimension[]).map((key) => (
                      <SelectItem key={key} value={key}>{SEGMENT_LABELS[key]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent>
                {segmentHasData ? (
                  <div className="space-y-3">
                    {selectedSegmentRows.map((row: AttendanceLossesSegment) => {
                      const max = Math.max(...selectedSegmentRows.map((item) => item.reservations), 1);
                      return (
                        <div key={row.key} className="rounded-lg bg-muted/40 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{row.label}</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {formatInteger(row.reservations)} reservas · {formatInteger(row.lost_people)} pessoas em perdas
                              </p>
                            </div>
                            <div className="text-right text-[11px] tabular-nums text-muted-foreground">
                              <p>No-show <strong className="text-destructive">{formatPercent(row.no_show_rate)}</strong></p>
                              <p>Canceladas <strong className="text-foreground">{formatInteger(row.cancelled)}</strong></p>
                            </div>
                          </div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${(row.reservations / max) * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-20 text-center text-sm text-muted-foreground">Sem dados para esta dimensão.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Curva de cancelamento</CardTitle>
                <CardDescription>Quanto tempo antes do horário o cancelamento foi registrado.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-4 rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  Cobertura auditável: <strong className="text-foreground">{formatPercent(report.cancellation_curve.coverage_percentage)}</strong>
                  {' '}({formatInteger(report.cancellation_curve.cancelled_with_audit)} de {formatInteger(report.cancellation_curve.cancelled_total)} cancelamentos).
                  {report.cancellation_curve.coverage_start && <> Histórico disponível desde {formatDateTime(report.cancellation_curve.coverage_start)}.</>}
                </div>
                <div className="space-y-3">
                  {report.cancellation_curve.buckets.map((bucket) => (
                    <div key={bucket.key}>
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-foreground">{bucket.label}</span>
                        <span className="tabular-nums text-muted-foreground">{formatInteger(bucket.reservations)} · {formatPercent(bucket.percentage)}</span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-warning" style={{ width: `${Math.max(0, Math.min(100, bucket.percentage))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Associações observadas</CardTitle>
              <CardDescription>
                Comparação descritiva entre grupos; diferenças não comprovam que WhatsApp ou pré-pagamento causaram o resultado.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 xl:grid-cols-2">
              <AssociationColumn
                title="WhatsApp antes do horário"
                icon={MessageCircle}
                rows={report.associations.whatsapp}
                detail="Envios registrados como enviados por Evolution ou PlugueChat"
              />
              <AssociationColumn
                title="Pré-pagamento"
                icon={TicketCheck}
                rows={report.associations.prepayment}
                detail="Pagamento recebido antes do horário e ainda em estado pago"
              />
            </CardContent>
          </Card>

        </>
      )}

    </ReportShell>
  );
}
