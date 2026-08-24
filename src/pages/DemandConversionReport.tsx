import { useCallback, useEffect, useState } from 'react';
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
  Clock3,
  Eye,
  Filter,
  MousePointerClick,
  Search,
  Sparkles,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import ReservationDetailsDialog, { type ReservationDetails } from '@/components/ReservationDetailsDialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportShell from '@/components/reports/ReportShell';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  type DemandConversionEntryFilter,
  type DemandReservationRow,
  getDemandConversionErrorMessage,
  normalizeDemandConversionSearch,
  useDemandConversionReport,
} from '@/hooks/useDemandConversionReport';
import { useReportFilters } from '@/hooks/useReportFilters';
import type { ReportGranularity } from '@/lib/report-filters';
import { RESERVATION_ORIGIN_CONFIG, type ReservationOriginKey } from '@/lib/reservation-origin';
import { getReservationStatusLabel } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';
import { formatBrazilPhone } from '@/lib/validation';

const PAGE_SIZE = 15;
const numberFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ENTRY_COLORS: Record<ReservationOriginKey, string> = {
  online: 'hsl(202 89% 48%)',
  affiliate: 'hsl(145 63% 42%)',
  manual: 'hsl(0 0% 35%)',
  waitlist: 'hsl(338 78% 55%)',
};

function parsePositivePage(value: string | null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
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

function maskPhone(value: string) {
  const formatted = formatBrazilPhone(value);
  const digits = formatted.replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '—';
}

function getVisiblePages(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 3) return [1, 2, 3, 4, 'ellipsis', totalPages];
  if (currentPage >= totalPages - 2) return [1, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
}

function toReservationDetails(row: DemandReservationRow, companyId: string): ReservationDetails {
  return {
    id: row.id,
    company_id: companyId,
    table_id: row.table_id,
    created_in_mode: row.created_in_mode,
    guest_name: row.guest_name,
    guest_phone: row.guest_phone,
    guest_email: row.guest_email,
    source: row.source,
    origin_affiliate_code: row.origin_affiliate_code,
    origin_affiliate_name: row.origin_affiliate_name,
    date: row.reservation_date,
    time: row.reservation_time,
    party_size: row.party_size,
    status: row.status as ReservationDetails['status'],
    occasion: row.occasion,
    notes: row.notes,
    checked_in_at: row.checked_in_at,
    checked_in_party_size: row.checked_in_party_size,
    created_at: row.created_at,
    updated_at: row.updated_at,
    public_tracking_code: row.public_tracking_code,
  };
}

function KpiCard({
  label,
  value,
  detail,
  comparison,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  comparison?: string | null;
  icon: typeof MousePointerClick;
  tone: 'orange' | 'blue' | 'green' | 'neutral';
}) {
  const tones = {
    orange: 'border-primary/20 bg-primary/10 text-primary',
    blue: 'border-info/20 bg-info-soft text-info',
    green: 'border-success/20 bg-success-soft text-success',
    neutral: 'border-border bg-muted/70 text-foreground',
  };
  return (
    <Card className="overflow-hidden border-border/80 shadow-none">
      <CardContent className="flex min-h-36 flex-col justify-between p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
          <span className={cn('rounded-xl border p-2', tones[tone])}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
        <div>
          <p className="text-3xl font-semibold tracking-tight text-foreground">{value}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          {comparison && <p className="mt-2 text-xs font-medium text-foreground/80">{comparison}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-5" aria-label="Carregando relatório" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-36 rounded-xl" />)}
      </div>
      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.4fr]">
        <Skeleton className="h-[390px] rounded-xl" />
        <Skeleton className="h-[390px] rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

export default function DemandConversionReport() {
  const { companyId, companyName, companyTimeZone, companyTimeZoneResolved, slug } = useCompanySlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useReportFilters({
    defaultPreset: 'last_30_days',
    defaultComparisonEnabled: true,
    timeZone: companyTimeZone,
  });
  const uniqueOnly = searchParams.get('unique') === '1';
  const page = parsePositivePage(searchParams.get('page'));
  const entryMode: DemandConversionEntryFilter = isEntryFilter(searchParams.get('entry'))
    ? searchParams.get('entry') as DemandConversionEntryFilter
    : 'all';
  const [searchInput, setSearchInput] = useState('');
  const [querySearch, setQuerySearch] = useState('');
  const [selectedReservation, setSelectedReservation] = useState<DemandReservationRow | null>(null);

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

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const normalized = normalizeDemandConversionSearch(searchInput);
      if (normalized !== querySearch) {
        setQuerySearch(normalized);
        updateParams({ page: null });
      }
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [searchInput, querySearch, updateParams]);

  const reportQuery = useDemandConversionReport({
    companyId,
    periodStart: filters.dateOnlyRange.from,
    periodEnd: filters.dateOnlyRange.to,
    uniqueOnly,
    comparisonEnabled: filters.comparisonEnabled,
    granularity: filters.granularity,
    page,
    pageSize: PAGE_SIZE,
    search: querySearch,
    entryMode,
    enabled: companyTimeZoneResolved && !filters.rangeError,
  });
  const report = reportQuery.data;
  const reportPage = report?.meta.page;
  const totalPages = Math.max(1, Math.ceil((report?.meta.details_total ?? 0) / PAGE_SIZE));
  const trendHasData = !!report && report.trend.some((point) => (
    point.page_views > 0 || point.completed > 0 || point.created_reservations > 0
  ));
  const transitionHasData = !!report && report.transition_times.some((transition) => transition.sample_size > 0);
  const leadTimeHasData = !!report && report.lead_time_bands.some((band) => band.reservations > 0);
  const partySizeHasData = !!report && report.party_size_bands.some((band) => band.reservations > 0);

  useEffect(() => {
    if (reportPage && reportPage !== page) updateParams({ page: reportPage === 1 ? null : String(reportPage) });
  }, [reportPage, page, updateParams]);

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
          <div className="flex h-9 min-w-44 flex-1 items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3">
            <Label htmlFor="demand-unique" className="cursor-pointer whitespace-nowrap text-xs">Visitantes únicos</Label>
            <Switch
              id="demand-unique"
              checked={uniqueOnly}
              onCheckedChange={(checked) => updateParams({ unique: checked ? '1' : null, page: null })}
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
            <KpiCard
              label={uniqueOnly ? 'Visitantes no funil' : 'Sessões no funil'}
              value={formatInteger(report.summary.sessions)}
              detail="Funil web total; não muda com a forma de entrada"
              comparison={report.comparison
                ? formatRelativeComparison(report.summary.sessions, report.comparison.summary.sessions)
                : null}
              icon={MousePointerClick}
              tone="blue"
            />
            <KpiCard
              label="Reservas finalizadas"
              value={formatInteger(report.summary.completed)}
              detail={`${formatPercent(report.summary.overall_conversion_rate)} de conversão no funil web total`}
              comparison={report.comparison
                ? formatPointComparison(
                    report.summary.overall_conversion_rate,
                    report.comparison.summary.overall_conversion_rate,
                  )
                : null}
              icon={UserRoundCheck}
              tone="green"
            />
            <KpiCard
              label="Reservas criadas"
              value={formatInteger(report.summary.created_reservations)}
              detail={entryMode === 'all' ? 'Por qualquer forma de entrada no período' : 'Na forma de entrada selecionada'}
              comparison={report.comparison
                ? formatRelativeComparison(
                    report.summary.created_reservations,
                    report.comparison.summary.created_reservations,
                  )
                : null}
              icon={CalendarDays}
              tone="orange"
            />
            <KpiCard
              label="Pessoas reservadas"
              value={formatInteger(report.summary.created_people)}
              detail={`Antecedência média de ${decimalFormatter.format(report.summary.average_lead_days)} dias`}
              comparison={report.comparison
                ? formatRelativeComparison(report.summary.created_people, report.comparison.summary.created_people)
                : null}
              icon={UsersRound}
              tone="neutral"
            />
          </section>

          <section className="grid gap-5 xl:grid-cols-[0.9fr_1.4fr]">
            <Card className="border-border/80 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Avanço pelo funil</CardTitle>
                <CardDescription>Cada etapa mostra retenção e abandono em relação à etapa anterior.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {report.summary.sessions > 0 ? report.funnel.map((stage, index) => (
                  <div key={stage.step} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{stage.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {index === 0 ? 'Base do funil' : `${formatPercent(stage.conversion_from_previous)} avançaram`}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold tabular-nums">{formatInteger(stage.count)}</p>
                        {index < report.funnel.length - 1 && stage.dropoff > 0 && (
                          <p className="text-xs text-destructive">−{formatInteger(stage.dropoff)} ({formatPercent(stage.dropoff_rate)})</p>
                        )}
                      </div>
                    </div>
                    <Progress value={stage.conversion_from_start} className="h-2" aria-label={`${stage.label}: ${formatPercent(stage.conversion_from_start)} da base`} />
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">Nenhuma jornada iniciou no período.</div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/80 shadow-none">
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

          <section className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
            <Card className="border-border/80 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Tempo entre etapas</CardTitle>
                <CardDescription>Mediana calculada somente em sessões com as duas etapas registradas.</CardDescription>
              </CardHeader>
              <CardContent className={cn(transitionHasData && 'grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2')}>
                {transitionHasData ? report.transition_times.filter((transition) => transition.sample_size > 0).map((transition) => (
                  <div key={transition.key} className="rounded-xl border border-border bg-muted/25 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <Clock3 className="h-4 w-4 text-primary" aria-hidden="true" />
                      <Badge variant="secondary">{formatInteger(transition.sample_size)} amostras</Badge>
                    </div>
                    <p className="mt-4 text-2xl font-semibold tracking-tight">{formatSeconds(transition.median_seconds)}</p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      {transition.from_label}<ArrowRight className="h-3 w-3" aria-hidden="true" />{transition.to_label}
                    </p>
                  </div>
                )) : (
                  <p className="py-16 text-center text-sm text-muted-foreground">Sem amostra suficiente para calcular o tempo entre etapas.</p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/80 shadow-none">
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
                  <p className="py-16 text-center text-sm text-muted-foreground">Nenhuma reserva criada neste recorte.</p>
                )}
              </CardContent>
            </Card>
          </section>

          <Card className="border-border/80 shadow-none">
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
                  <article key={band.key} className="rounded-xl border border-border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-foreground">{band.label}</h3>
                      <Badge variant="secondary">{formatPercent(band.percentage)}</Badge>
                    </div>
                    <p className="mt-4 text-2xl font-semibold tabular-nums">{formatInteger(band.reservations)}</p>
                    <p className="text-xs text-muted-foreground">
                      reservas · {formatInteger(band.people)} pessoas
                    </p>
                    <Progress
                      value={band.percentage}
                      className="mt-4 h-2"
                      aria-label={`${band.label}: ${formatPercent(band.percentage)} das reservas criadas`}
                    />
                    {previous && (
                      <p className="mt-3 text-xs font-medium text-foreground/75">
                        {formatPointComparison(band.percentage, previous.percentage)}
                      </p>
                    )}
                  </article>
                );
              }) : (
                <p className="py-12 text-center text-sm text-muted-foreground">Nenhum grupo reservado neste recorte.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/80 shadow-none">
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
                    onClick={() => updateParams({ entry: active ? null : mode.key, page: null })}
                    className={cn(
                      'rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/30',
                    )}
                    aria-pressed={active}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ENTRY_COLORS[mode.key] }} aria-hidden="true" /><span className="truncate">{mode.label}</span></span>
                      <Filter className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-3">
                      <span className="text-2xl font-semibold">{formatInteger(mode.reservations)}</span>
                      <span className="text-xs text-muted-foreground">{formatPercent(mode.percentage)} · {formatInteger(mode.people)} pessoas</span>
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/80 shadow-none">
            <CardHeader className="gap-4 border-b border-border sm:flex-row sm:items-end sm:justify-between">
              <div>
                <CardTitle className="text-base">Reservas criadas no período</CardTitle>
                <CardDescription>{formatInteger(report.meta.details_total)} resultados no filtro atual. Use “Abrir” para ver os detalhes.</CardDescription>
              </div>
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  name="demand-reservation-search"
                  autoComplete="off"
                  placeholder="Nome ou telefone…"
                  className="pl-9"
                  maxLength={200}
                  aria-label="Buscar reserva por nome ou telefone"
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {report.details.length === 0 ? (
                <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-5 text-center">
                  <Search className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                  <p className="text-sm font-medium">Nenhuma reserva encontrada</p>
                  <p className="text-xs text-muted-foreground">Ajuste a busca, a forma de entrada ou o período.</p>
                </div>
              ) : (
                <>
                  <div className="divide-y divide-border lg:hidden">
                    {report.details.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => setSelectedReservation(row)}
                        className="w-full p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        aria-label={`Abrir detalhes da reserva de ${row.guest_name}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{row.guest_name}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{maskPhone(row.guest_phone)}</p>
                          </div>
                          <Badge variant="outline">{getReservationStatusLabel(row.status)}</Badge>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                          <div><p className="text-muted-foreground">Reserva</p><p className="mt-0.5 font-medium">{formatDate(row.reservation_date)} · {row.reservation_time.slice(0, 5)}</p></div>
                          <div><p className="text-muted-foreground">Entrada</p><p className="mt-0.5 font-medium">{RESERVATION_ORIGIN_CONFIG[row.entry_mode].label}</p></div>
                          <div><p className="text-muted-foreground">Pessoas</p><p className="mt-0.5 font-medium">{formatInteger(row.party_size)}</p></div>
                          <div><p className="text-muted-foreground">Antecedência</p><p className="mt-0.5 font-medium">{row.lead_days} dias</p></div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="hidden lg:block">
                    <Table>
                      <TableHeader><TableRow><TableHead>Cliente</TableHead><TableHead>Reserva</TableHead><TableHead>Pessoas</TableHead><TableHead>Entrada</TableHead><TableHead>Antecedência</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Ação</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {report.details.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell><p className="max-w-[220px] truncate font-medium">{row.guest_name}</p><p className="text-xs text-muted-foreground">{maskPhone(row.guest_phone)}</p></TableCell>
                            <TableCell>{formatDate(row.reservation_date)} <span className="text-muted-foreground">· {row.reservation_time.slice(0, 5)}</span></TableCell>
                            <TableCell>{formatInteger(row.party_size)}</TableCell>
                            <TableCell><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: ENTRY_COLORS[row.entry_mode] }} aria-hidden="true" />{RESERVATION_ORIGIN_CONFIG[row.entry_mode].label}</span></TableCell>
                            <TableCell>{row.lead_days === 0 ? 'Mesmo dia' : `${row.lead_days} dias`}</TableCell>
                            <TableCell><Badge variant="outline">{getReservationStatusLabel(row.status)}</Badge></TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Abrir detalhes da reserva de ${row.guest_name}`}
                                onClick={(event) => { event.stopPropagation(); setSelectedReservation(row); }}
                              >
                                <Eye className="mr-2 h-4 w-4" aria-hidden="true" />Abrir
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
              {report.meta.details_total > 0 && (
                <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">Página {report.meta.page} de {totalPages}</p>
                  <nav className="flex flex-wrap items-center gap-1" aria-label="Paginação das reservas">
                    <Button variant="outline" size="sm" disabled={report.meta.page <= 1} onClick={() => updateParams({ page: report.meta.page - 1 <= 1 ? null : String(report.meta.page - 1) })}>Anterior</Button>
                    {getVisiblePages(report.meta.page, totalPages).map((item, index) => item === 'ellipsis'
                      ? <span key={`ellipsis-${index}`} className="px-2 text-muted-foreground">…</span>
                      : <Button key={item} variant={item === report.meta.page ? 'default' : 'ghost'} size="sm" className="min-w-9" aria-current={item === report.meta.page ? 'page' : undefined} aria-label={`Ir para a página ${item}`} onClick={() => updateParams({ page: item === 1 ? null : String(item) })}>{item}</Button>)}
                    <Button variant="outline" size="sm" disabled={report.meta.page >= totalPages} onClick={() => updateParams({ page: String(report.meta.page + 1) })}>Próxima</Button>
                  </nav>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <ReservationDetailsDialog
        open={!!selectedReservation}
        onOpenChange={(open) => { if (!open) setSelectedReservation(null); }}
        reservation={selectedReservation ? toReservationDetails(selectedReservation, companyId) : null}
        slug={slug}
        companyId={companyId}
        showEventHistory
        showLeadHistory
      />
    </ReportShell>
  );
}
