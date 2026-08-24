import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  CalendarX2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  Loader2,
  MessageCircle,
  Search,
  ShieldAlert,
  TicketCheck,
  UserMinus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import ReservationDetailsDialog, {
  type ReservationDetails,
} from '@/components/ReservationDetailsDialog';
import ReportFilterBar from '@/components/reports/ReportFilterBar';
import ReportShell from '@/components/reports/ReportShell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useAttendanceLossesReport } from '@/hooks/useAttendanceLossesReport';
import { useReportFilters } from '@/hooks/useReportFilters';
import {
  ATTENDANCE_ENTRY_METHODS,
  ATTENDANCE_OUTCOMES,
  aggregateAttendanceLossesSeries,
  normalizeAttendanceLossesSearch,
  type AttendanceEntryMethodFilter,
  type AttendanceLossesAssociation,
  type AttendanceLossesReservationRow,
  type AttendanceLossesSegment,
  type AttendanceOutcome,
  type AttendanceOutcomeFilter,
  type AttendanceSegmentDimension,
} from '@/lib/attendance-losses-report';
import { normalizeReservationStatus } from '@/lib/reservation-status';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;
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

const OUTCOME_PRESENTATION: Record<AttendanceOutcome, { label: string; className: string }> = {
  attended: { label: 'Compareceu', className: 'border-success/20 bg-success-soft text-success' },
  no_show: { label: 'No-show', className: 'border-destructive/20 bg-destructive-soft text-destructive' },
  cancelled: { label: 'Cancelada', className: 'border-warning/25 bg-warning-soft text-warning-foreground' },
  scheduled: { label: 'Em aberto', className: 'border-border bg-muted text-muted-foreground' },
};

const CHART_COLORS = {
  attended: 'hsl(var(--success))',
  noShow: 'hsl(var(--destructive))',
  cancelled: 'hsl(var(--warning))',
  scheduled: 'hsl(var(--muted-foreground))',
  grid: 'hsl(var(--border))',
  axis: 'hsl(var(--muted-foreground))',
};

function parsePositivePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

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

function formatChartDate(value: string): string {
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'dd/MM', { locale: ptBR }) : value;
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

function KpiCard({
  label,
  value,
  helper,
  icon: Icon,
  iconClassName,
  current,
  previous,
  invert,
}: {
  label: string;
  value: string;
  helper: string;
  icon: LucideIcon;
  iconClassName: string;
  current?: number;
  previous?: number;
  invert?: boolean;
}) {
  return (
    <Card className="min-w-0 overflow-hidden border-border shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
          </div>
          <div className={cn('rounded-xl p-2.5', iconClassName)}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
        </div>
        {current !== undefined && previous !== undefined && (
          <div className="mt-3"><Trend current={current} previous={previous} invert={invert} /></div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
      </CardContent>
    </Card>
  );
}

function OutcomeBadge({ outcome }: { outcome: AttendanceOutcome }) {
  const presentation = OUTCOME_PRESENTATION[outcome];
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap', presentation.className)}>
      {presentation.label}
    </Badge>
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
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-background p-2 text-primary ring-1 ring-border">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-[11px] text-muted-foreground">{detail}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="rounded-lg border border-border bg-background p-3">
            <p className="text-xs font-medium text-foreground">{row.label}</p>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">No-show</p>
                <p className="text-xl font-semibold tabular-nums text-foreground">{formatPercent(row.no_show_rate)}</p>
              </div>
              <p className="text-right text-[11px] leading-relaxed text-muted-foreground">
                {formatInteger(row.reservations)} reservas<br />
                {formatInteger(row.attended)} comparecimentos
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReservationMobileCard({
  reservation,
  onOpen,
}: {
  reservation: AttendanceLossesReservationRow;
  onOpen: (reservation: AttendanceLossesReservationRow) => void;
}) {
  return (
    <button
      type="button"
      className="w-full border-b border-border p-4 text-left transition-colors last:border-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={() => onOpen(reservation)}
      aria-label={`Abrir reserva de ${reservation.guest_name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{reservation.guest_name}</p>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {formatDateOnly(reservation.date)} · {reservation.time.slice(0, 5)}
          </p>
        </div>
        <OutcomeBadge outcome={reservation.outcome} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatInteger(reservation.party_size)} {reservation.party_size === 1 ? 'pessoa' : 'pessoas'} · {ENTRY_METHOD_LABELS[reservation.entry_method]}</span>
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      </div>
    </button>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Carregando relatório">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-40 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[390px] rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-[380px] rounded-xl" />
        <Skeleton className="h-[380px] rounded-xl" />
      </div>
    </div>
  );
}

export default function AttendanceLossesReport() {
  const { companyId, slug, companyName, companyTimeZone, companyTimeZoneResolved } = useCompanySlug();
  const [searchParams, setSearchParams] = useSearchParams();
  const reportFilters = useReportFilters({
    defaultPreset: 'current_month',
    defaultComparisonEnabled: true,
    timeZone: companyTimeZone,
  });
  const outcomeParam = searchParams.get('outcome');
  const entryMethodParam = searchParams.get('entry');
  const segmentParam = searchParams.get('segment');
  const outcome: AttendanceOutcomeFilter = isOutcomeFilter(outcomeParam) ? outcomeParam : 'all';
  const entryMethod: AttendanceEntryMethodFilter = isEntryMethodFilter(entryMethodParam) ? entryMethodParam : 'all';
  const segmentDimension: AttendanceSegmentDimension = isSegmentDimension(segmentParam) ? segmentParam : 'weekday';
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const page = parsePositivePage(searchParams.get('attendance_page'));
  const [selectedReservation, setSelectedReservation] = useState<AttendanceLossesReservationRow | null>(null);

  const setPage = useCallback((nextPage: number) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (nextPage <= 1) next.delete('attendance_page');
      else next.set('attendance_page', String(nextPage));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const normalized = normalizeAttendanceLossesSearch(searchInput);
    const timer = window.setTimeout(() => {
      if (normalized !== debouncedSearch) {
        setDebouncedSearch(normalized);
        setPage(1);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [debouncedSearch, searchInput, setPage]);

  const reportRangeKey = `${reportFilters.dateOnlyRange.from}:${reportFilters.dateOnlyRange.to}`;
  const previousRangeKey = useRef(reportRangeKey);
  useEffect(() => {
    if (previousRangeKey.current === reportRangeKey) return;
    previousRangeKey.current = reportRangeKey;
    setPage(1);
  }, [reportRangeKey, setPage]);

  const { dateOnlyRange, rangeError } = reportFilters;

  const reportQuery = useAttendanceLossesReport({
    companyId,
    periodStart: dateOnlyRange.from,
    periodEnd: dateOnlyRange.to,
    outcome,
    entryMethod,
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch,
    comparisonEnabled: reportFilters.comparisonEnabled,
    enabled: companyTimeZoneResolved && !rangeError,
  });
  const report = reportQuery.data;
  const totalPages = Math.max(1, Math.ceil((report?.meta.filtered_reservations_total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (report && report.meta.page !== page) setPage(report.meta.page);
  }, [page, report, setPage]);

  const selectedSegmentRows = report?.segments[segmentDimension] ?? [];
  const segmentHasData = selectedSegmentRows.some((row) => row.reservations > 0);
  const seriesData = useMemo(
    () => aggregateAttendanceLossesSeries(report?.daily_series ?? [], reportFilters.granularity),
    [report?.daily_series, reportFilters.granularity],
  );
  const seriesHasData = seriesData.some((row) => row.reservations > 0);

  const updateUrlFilter = useCallback((key: string, value: string, defaultValue: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      next.delete('attendance_page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const openReservation = (reservation: AttendanceLossesReservationRow) => {
    setSelectedReservation(reservation);
  };

  const selectedReservationDetails: ReservationDetails | null = selectedReservation ? {
    id: selectedReservation.id,
    company_id: selectedReservation.company_id,
    guest_name: selectedReservation.guest_name,
    guest_phone: selectedReservation.guest_phone,
    guest_email: selectedReservation.guest_email,
    source: selectedReservation.source,
    origin_affiliate_code: selectedReservation.origin_affiliate_code,
    origin_affiliate_name: selectedReservation.origin_affiliate_name,
    date: selectedReservation.date,
    time: selectedReservation.time,
    party_size: selectedReservation.party_size,
    status: normalizeReservationStatus(selectedReservation.status),
    occasion: selectedReservation.occasion,
    notes: selectedReservation.notes,
    checked_in_at: selectedReservation.checked_in_at,
    checked_in_party_size: selectedReservation.checked_in_party_size,
    created_at: selectedReservation.created_at,
    updated_at: selectedReservation.updated_at,
    public_tracking_code: selectedReservation.public_tracking_code,
  } : null;

  return (
    <ReportShell
      title="Comparecimento & Perdas"
      description={`Entenda onde se concentram comparecimentos, no-shows e cancelamentos de ${companyName}, com abertura do histórico de cada reserva.`}
      icon={ShieldAlert}
      eyebrow="Relatório operacional"
      updatedAt={report?.meta.generated_at}
      isRefreshing={reportQuery.isFetching && !reportQuery.isLoading}
      ariaBusy={!companyTimeZoneResolved || reportQuery.isFetching}
      filters={(
        <ReportFilterBar
          filters={reportFilters}
          isRefreshing={!companyTimeZoneResolved || reportQuery.isFetching}
          onRefresh={() => reportQuery.refetch()}
        >
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 md:min-w-[320px]">
            <div className="min-w-0 space-y-1">
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
            <div className="min-w-0 space-y-1">
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
            <KpiCard
              label="Reservas no período"
              value={formatInteger(report.summary.reservations)}
              helper={`${formatInteger(report.summary.reserved_people)} pessoas reservadas`}
              icon={Users}
              iconClassName="bg-primary-soft text-primary"
            />
            <KpiCard
              label="Comparecimento"
              value={formatPercent(report.summary.attendance_rate)}
              helper={`${formatInteger(report.summary.attended)} reservas · ${formatInteger(report.summary.attended_people)} pessoas presentes · base: comparecimentos + no-shows`}
              icon={CheckCircle2}
              iconClassName="bg-success-soft text-success"
              current={report.comparison ? report.summary.attendance_rate : undefined}
              previous={report.comparison?.attendance_rate}
            />
            <KpiCard
              label="No-show"
              value={formatPercent(report.summary.no_show_rate)}
              helper={`${formatInteger(report.summary.no_show)} reservas · canceladas e abertas ficam fora da taxa`}
              icon={CalendarX2}
              iconClassName="bg-destructive-soft text-destructive"
              current={report.comparison ? report.summary.no_show_rate : undefined}
              previous={report.comparison?.no_show_rate}
              invert
            />
            <KpiCard
              label="Cancelamentos"
              value={formatInteger(report.summary.cancelled)}
              helper={`Taxa combinada de perdas: ${formatPercent(report.summary.loss_rate)}`}
              icon={Clock3}
              iconClassName="bg-warning-soft text-warning-foreground"
            />
            <KpiCard
              label="Pessoas em perdas"
              value={formatInteger(report.summary.lost_people)}
              helper="Pessoas ligadas a no-shows ou cancelamentos; não estima receita nem assentos não revendidos."
              icon={UserMinus}
              iconClassName="bg-muted text-muted-foreground"
            />
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Evolução diária dos resultados</CardTitle>
              <CardDescription>O recorte considera a data agendada, no fuso da empresa.</CardDescription>
            </CardHeader>
            <CardContent>
              {seriesHasData ? (
                <div>
                  <p className="sr-only">
                    No período: {formatInteger(report.summary.attended)} comparecimentos,
                    {' '}{formatInteger(report.summary.no_show)} no-shows,
                    {' '}{formatInteger(report.summary.cancelled)} cancelamentos e
                    {' '}{formatInteger(report.summary.scheduled)} reservas em aberto.
                  </p>
                  <div className="h-[330px] w-full" role="img" aria-label="Gráfico diário de comparecimentos, no-shows, cancelamentos e reservas em aberto">
                    <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={seriesData} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                      <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={formatChartDate} stroke={CHART_COLORS.axis} tick={{ fontSize: 11 }} minTickGap={24} />
                      <YAxis allowDecimals={false} stroke={CHART_COLORS.axis} tick={{ fontSize: 11 }} />
                      <ChartTooltip
                        labelFormatter={(value) => formatDateOnly(String(value))}
                        formatter={(value, name) => [formatInteger(Number(value)), name]}
                        contentStyle={{ borderRadius: 10, borderColor: 'hsl(var(--border))' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="attended" name="Comparecimento" stackId="outcome" fill={CHART_COLORS.attended} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="no_show" name="No-show" stackId="outcome" fill={CHART_COLORS.noShow} />
                      <Bar dataKey="cancelled" name="Cancelamento" stackId="outcome" fill={CHART_COLORS.cancelled} />
                      <Bar dataKey="scheduled" name="Em aberto" stackId="outcome" fill={CHART_COLORS.scheduled} />
                    </BarChart>
                    </ResponsiveContainer>
                  </div>
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
                        <div key={row.key} className="rounded-lg border border-border p-3">
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
                <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
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

          <Card className="overflow-hidden border-border shadow-sm">
            <CardHeader className="gap-4 border-b border-border sm:flex-row sm:items-end sm:justify-between">
              <div>
                <CardTitle className="text-base">Reservas do recorte</CardTitle>
                <CardDescription>
                  {formatInteger(report.meta.filtered_reservations_total)} resultados. Use “Abrir” para ver o histórico da reserva.
                </CardDescription>
              </div>
              <div className="relative w-full sm:w-[300px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  name="attendance-reservation-search"
                  autoComplete="off"
                  placeholder="Nome, telefone ou e-mail…"
                  className="pl-9"
                  maxLength={200}
                  aria-label="Buscar reserva"
                />
                {(normalizeAttendanceLossesSearch(searchInput) !== debouncedSearch || reportQuery.isFetching) && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
                )}
              </div>
            </CardHeader>

            {report.reservations.length === 0 ? (
              <div className="px-4 py-16 text-center">
                <Search className="mx-auto h-7 w-7 text-muted-foreground/60" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-foreground">Nenhuma reserva encontrada</p>
                <p className="mt-1 text-xs text-muted-foreground">Limpe a busca ou altere os filtros.</p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-border md:hidden">
                  {report.reservations.map((reservation) => (
                    <ReservationMobileCard key={reservation.id} reservation={reservation} onOpen={openReservation} />
                  ))}
                </div>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cliente</TableHead>
                        <TableHead>Reserva</TableHead>
                        <TableHead>Pessoas</TableHead>
                        <TableHead>Resultado</TableHead>
                        <TableHead>Forma de entrada</TableHead>
                        <TableHead>Sinais</TableHead>
                        <TableHead className="w-14"><span className="sr-only">Abrir</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.reservations.map((reservation) => (
                        <TableRow key={reservation.id}>
                          <TableCell>
                            <p className="max-w-[220px] truncate font-medium text-foreground">{reservation.guest_name}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">Criada {formatDateTime(reservation.created_at)}</p>
                          </TableCell>
                          <TableCell className="whitespace-nowrap tabular-nums">
                            {formatDateOnly(reservation.date)}<br />
                            <span className="text-xs text-muted-foreground">{reservation.time.slice(0, 5)}</span>
                          </TableCell>
                          <TableCell className="tabular-nums">{formatInteger(reservation.party_size)}</TableCell>
                          <TableCell><OutcomeBadge outcome={reservation.outcome} /></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{ENTRY_METHOD_LABELS[reservation.entry_method]}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {reservation.has_whatsapp && <Badge variant="outline" className="text-[10px]">WhatsApp</Badge>}
                              {reservation.has_prepayment && <Badge variant="outline" className="text-[10px]">Pré-pago</Badge>}
                              {!reservation.has_whatsapp && !reservation.has_prepayment && <span className="text-xs text-muted-foreground">—</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`Abrir reserva de ${reservation.guest_name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                openReservation(reservation);
                              }}
                            >
                              <Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            <div className="flex flex-col gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                Página {page} de {totalPages} · {formatInteger(report.meta.filtered_reservations_total)} reservas
              </span>
              <nav className="flex items-center gap-2" aria-label="Paginação das reservas">
                <Button variant="outline" size="sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1 || reportQuery.isFetching}>
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Anterior
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages || reportQuery.isFetching}>
                  Próxima <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </nav>
            </div>
          </Card>
        </>
      )}

      <ReservationDetailsDialog
        open={!!selectedReservation}
        onOpenChange={(open) => { if (!open) setSelectedReservation(null); }}
        reservation={selectedReservationDetails}
        slug={slug}
        companyId={companyId}
        showEventHistory
        showLeadHistory
      />
    </ReportShell>
  );
}
