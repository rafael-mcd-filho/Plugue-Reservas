import { useCallback } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
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
import ReportFilterBar, { REPORT_FILTER_TOGGLE_CLASS } from '@/components/reports/ReportFilterBar';
import ReportMetricCard from '@/components/reports/ReportMetricCard';
import ReportShell from '@/components/reports/ReportShell';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  type DemandConversionEntryFilter,
  getDemandConversionErrorMessage,
  useDemandConversionReport,
} from '@/hooks/useDemandConversionReport';
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
      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.4fr]">
        <Skeleton className="h-[340px] rounded-xl" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
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
  const report = reportQuery.data;
  const trendHasData = !!report && report.trend.some((point) => (
    point.page_views > 0 || point.completed > 0 || point.created_reservations > 0
  ));
  const transitionHasData = !!report && report.transition_times.some((transition) => transition.sample_size > 0);
  const leadTimeHasData = !!report && report.lead_time_bands.some((band) => band.reservations > 0);
  const partySizeHasData = !!report && report.party_size_bands.some((band) => band.reservations > 0);

  return (
    <ReportShell
      title="Demanda & Conversão"
      description={`Entenda onde as jornadas avançam, onde param e com quanta antecedência as reservas de ${companyName} são criadas.`}
      icon={MousePointerClick}
      eyebrow="Relatório avançado"
      updatedAt={report?.meta.generated_at}
      isRefreshing={reportQuery.isFetching && !!report}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching}
      filters={(
        <ReportFilterBar
          filters={filters}
          isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching}
          onRefresh={() => reportQuery.refetch()}
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

          <section className="grid gap-4 xl:grid-cols-[0.9fr_1.4fr]">
            <Card className="border-border shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Avanço pelo funil</CardTitle>
                <CardDescription>Cada etapa mostra retenção e abandono em relação à etapa anterior.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {report.summary.sessions > 0 ? report.funnel.map((stage, index) => (
                  <div key={stage.step} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{stage.label}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {index === 0 ? 'Base do funil' : `${formatPercent(stage.conversion_from_previous)} avançaram`}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-base font-semibold tabular-nums">{formatInteger(stage.count)}</p>
                        {index < report.funnel.length - 1 && stage.dropoff > 0 && (
                          <p className="text-[11px] text-destructive">−{formatInteger(stage.dropoff)} ({formatPercent(stage.dropoff_rate)})</p>
                        )}
                      </div>
                    </div>
                    <Progress value={stage.conversion_from_start} className="h-1.5" aria-label={`${stage.label}: ${formatPercent(stage.conversion_from_start)} da base`} />
                  </div>
                )) : (
                  <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">Nenhuma jornada iniciou no período.</div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-sm">
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-base">Demanda ao longo do tempo</CardTitle>
                  <CardDescription>
                    O funil web permanece total; “criadas” respeita a forma de entrada selecionada.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-info" /> Inícios</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-primary" /> Finalizadas</span>
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-success" /> Criadas</span>
                </div>
              </CardHeader>
              <CardContent>
                {trendHasData ? <>
                <div className="h-[300px] w-full" role="img" aria-label={`Série de demanda com ${report.trend.length} períodos`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={report.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="demandPageFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--info))" stopOpacity={0.24} />
                          <stop offset="95%" stopColor="hsl(var(--info))" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="period" tickFormatter={(value) => formatTrendPeriod(value, filters.granularity)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <RechartsTooltip
                        labelFormatter={(value) => formatDate(String(value))}
                        formatter={(value: number, name: string) => [
                          formatInteger(value),
                          name === 'page_views' ? 'Inícios' : name === 'completed' ? 'Finalizadas' : 'Criadas',
                        ]}
                        contentStyle={{ borderRadius: 12, borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}
                      />
                      <Area type="monotone" dataKey="page_views" name="page_views" stroke="hsl(var(--info))" strokeWidth={2} fill="url(#demandPageFill)" />
                      <Area type="monotone" dataKey="completed" name="completed" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="transparent" />
                      <Area type="monotone" dataKey="created_reservations" name="created_reservations" stroke="hsl(var(--success))" strokeWidth={2} strokeDasharray="5 4" fill="transparent" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <p className="sr-only">
                  No período, {formatInteger(report.summary.sessions)} jornadas iniciaram e {formatInteger(report.summary.completed)} finalizaram uma reserva.
                </p>
                </> : (
                  <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
                    <CalendarDays className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">Nenhuma demanda registrada</p>
                    <p className="mt-1 text-xs text-muted-foreground">Altere o período ou a forma de entrada para consultar outros resultados.</p>
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
            <CardHeader>
              <CardTitle className="text-base">Formas de entrada</CardTitle>
              <CardDescription>
                Selecione uma forma para filtrar os indicadores e as análises de reservas criadas. Os indicadores e etapas do funil web permanecem totais.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
            </CardContent>
          </Card>

        </>
      )}

    </ReportShell>
  );
}
