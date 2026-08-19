import { useEffect, useMemo, useState } from 'react';
import {
  differenceInCalendarDays,
  endOfMonth,
  format,
  isValid,
  parseISO,
  startOfMonth,
  subMonths,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CalendarSearch,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Minus,
  RefreshCcw,
  Repeat2,
  Search,
  UserCheck,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from '@/components/ui/pagination';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import LeadProfileDialog from '@/components/leads/LeadProfileDialog';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import {
  CUSTOMER_RECURRENCE_MIN_VISITS_MAX,
  CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH,
  type CustomerFrequencyBandKey,
  type CustomerRecurrenceRow,
  normalizeCustomerRecurrenceSearch,
  normalizeMinimumTotalVisits,
  resolveCustomerRecurrenceDisplayedPage,
  useCustomerRecurrenceLeadProfile,
  useCustomerRecurrenceReport,
} from '@/hooks/useCustomerRecurrenceReport';
import { mapCrmLeadRowToProfile } from '@/lib/crm-lead-profile';
import { cn } from '@/lib/utils';

type PeriodMode = 'current_month' | 'last_month' | 'custom';
type KpiTone = 'primary' | 'success' | 'info' | 'warning' | 'neutral';

const PAGE_SIZE = 12;
const numberFormatter = new Intl.NumberFormat('pt-BR');
const decimalFormatter = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const CHART_COLORS = {
  newCustomers: 'hsl(var(--primary))',
  returningCustomers: 'hsl(var(--success))',
  grid: 'hsl(var(--border))',
  axis: 'hsl(var(--muted-foreground))',
};

const FREQUENCY_META: Record<CustomerFrequencyBandKey, {
  label: string;
  shortLabel: string;
  description: string;
  color: string;
  badgeClassName: string;
}> = {
  one: {
    label: '1 visita',
    shortLabel: '1 visita',
    description: 'Primeira experiência',
    color: 'hsl(var(--muted-foreground))',
    badgeClassName: 'border-border bg-muted/60 text-muted-foreground',
  },
  two: {
    label: '2 visitas',
    shortLabel: '2 visitas',
    description: 'Já retornou',
    color: 'hsl(var(--info))',
    badgeClassName: 'border-info/20 bg-info-soft text-info',
  },
  three_four: {
    label: '3–4 visitas',
    shortLabel: '3–4 visitas',
    description: 'Cliente frequente',
    color: 'hsl(var(--primary))',
    badgeClassName: 'border-primary/20 bg-primary-soft text-accent-foreground',
  },
  five_plus: {
    label: '5+ visitas',
    shortLabel: '5+ visitas',
    description: 'Fiel / VIP',
    color: 'hsl(var(--success))',
    badgeClassName: 'border-success/20 bg-success-soft text-success',
  },
};

const KPI_TONE_CLASSES: Record<KpiTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning-foreground',
  neutral: 'bg-muted text-muted-foreground',
};

function createCurrentMonthRange(): DateRange {
  const today = new Date();
  return { from: startOfMonth(today), to: today };
}

function getPeriodRange(mode: PeriodMode, customRange: DateRange | undefined): DateRange {
  const today = new Date();

  if (mode === 'last_month') {
    const lastMonth = subMonths(today, 1);
    return { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) };
  }

  if (mode === 'custom' && customRange?.from) {
    return { from: customRange.from, to: customRange.to ?? customRange.from };
  }

  return { from: startOfMonth(today), to: today };
}

function formatInteger(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  return `${decimalFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'dd/MM/yyyy', { locale: ptBR }) : '—';
}

function formatMonth(value: string): string {
  const parsed = parseISO(value);
  if (!isValid(parsed)) return value;
  const label = format(parsed, 'MMM/yy', { locale: ptBR }).replace('.', '');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatRangeLabel(from: string, to: string): string {
  const start = formatDate(from);
  const end = formatDate(to);
  if (start === '—' || end === '—') return 'período anterior';
  return start === end ? start : `${start} a ${end}`;
}

function maskPhone(phone: string | null, normalizedPhone: string): string {
  const digits = (phone || normalizedPhone).replace(/\D/g, '');
  const localDigits = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;

  if (localDigits.length >= 10) {
    return `(${localDigits.slice(0, 2)}) *****-${localDigits.slice(-4)}`;
  }

  if (localDigits.length >= 4) {
    return `•••• ${localDigits.slice(-4)}`;
  }

  return '—';
}

function getVisiblePages(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 5) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 3) return [1, 2, 3, 4, 'ellipsis', totalPages];
  if (currentPage >= totalPages - 2) {
    return [1, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages];
}

function TrendIndicator({
  current,
  previous,
  percentagePoints = false,
  comparisonLabel,
}: {
  current: number;
  previous: number;
  percentagePoints?: boolean;
  comparisonLabel: string;
}) {
  const difference = current - previous;
  const isEqual = Math.abs(difference) < 0.05;

  if (isEqual) {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground" title={`Comparação com ${comparisonLabel}`}>
        <Minus className="h-3.5 w-3.5" aria-hidden="true" />
        <span>estável vs. anterior</span>
      </div>
    );
  }

  if (!percentagePoints && previous === 0) {
    return (
      <div className="text-xs text-muted-foreground" title={`Comparação com ${comparisonLabel}`}>
        sem base anterior
      </div>
    );
  }

  const isPositive = difference > 0;
  const displayValue = percentagePoints
    ? `${decimalFormatter.format(Math.abs(difference))} p.p.`
    : `${decimalFormatter.format(Math.abs((difference / previous) * 100))}%`;

  return (
    <div
      className={cn('flex items-center gap-1 text-xs font-medium', isPositive ? 'text-success' : 'text-destructive')}
      title={`Comparação com ${comparisonLabel}`}
    >
      {isPositive
        ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />}
      <span>{isPositive ? 'aumento' : 'queda'} de {displayValue} vs. anterior</span>
    </div>
  );
}

function KpiCard({
  className,
  label,
  value,
  helper,
  explanation,
  icon: Icon,
  tone,
  current,
  previous,
  comparisonLabel,
  percentagePoints,
}: {
  className?: string;
  label: string;
  value: string;
  helper: string;
  explanation: string;
  icon: LucideIcon;
  tone: KpiTone;
  current: number;
  previous: number;
  comparisonLabel: string;
  percentagePoints?: boolean;
}) {
  return (
    <Card className={cn(
      'group min-w-0 border-border shadow-sm transition-[border-color,box-shadow] hover:border-primary/25 hover:shadow-md',
      className,
    )}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <span>{label}</span>
              <InfoTooltip
                content={`${explanation} A variação abaixo compara com ${comparisonLabel}.`}
                ariaLabel={`Como é calculado: ${label}`}
                className="shrink-0 normal-case tracking-normal"
                interaction="popover"
              />
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
          </div>
          <div className={cn('rounded-lg p-2.5', KPI_TONE_CLASSES[tone])}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-3">
          <TrendIndicator
            current={current}
            previous={previous}
            percentagePoints={percentagePoints}
            comparisonLabel={comparisonLabel}
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
      </CardContent>
    </Card>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-6" aria-label="Carregando relatório" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Card
            key={index}
            className={index < 3 ? 'lg:col-span-2 xl:col-span-1' : 'lg:col-span-3 xl:col-span-1'}
          >
            <CardContent className="space-y-3 p-4">
              <div className="flex justify-between gap-4">
                <div className="space-y-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-16" />
                </div>
                <Skeleton className="h-9 w-9" />
              </div>
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-5">
        <Skeleton className="h-[390px] xl:col-span-3" />
        <Skeleton className="h-[390px] xl:col-span-2" />
      </div>
      <Skeleton className="h-[420px]" />
    </div>
  );
}

function CustomerTypeBadge({ type }: { type: CustomerRecurrenceRow['customer_type'] }) {
  return type === 'returning' ? (
    <Badge className="h-5 rounded px-1.5 py-0 text-[10px] border-success/20 bg-success-soft text-success hover:bg-success-soft" variant="outline">
      Recorrente
    </Badge>
  ) : (
    <Badge className="h-5 rounded px-1.5 py-0 text-[10px] border-primary/20 bg-primary-soft text-accent-foreground hover:bg-primary-soft" variant="outline">
      Novo
    </Badge>
  );
}

function FrequencyBadge({ band }: { band: CustomerFrequencyBandKey }) {
  const meta = FREQUENCY_META[band];
  return (
    <Badge
      className={cn('h-5 whitespace-nowrap rounded px-1.5 py-0 text-[10px] hover:bg-inherit', meta.badgeClassName)}
      variant="outline"
    >
      {meta.shortLabel}
    </Badge>
  );
}

function CustomerMobileCard({
  customer,
  isSelected,
  onSelect,
}: {
  customer: CustomerRecurrenceRow;
  isSelected: boolean;
  onSelect: (customer: CustomerRecurrenceRow) => void;
}) {
  const name = customer.guest_name?.trim() || 'Cliente sem nome';
  return (
    <button
      type="button"
      className="group w-full border-b border-border px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-primary-soft/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=selected]:bg-primary-soft/35"
      data-state={isSelected ? 'selected' : undefined}
      onClick={() => onSelect(customer)}
      aria-label={`Abrir perfil de ${name}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-xs font-bold text-primary ring-1 ring-primary/15">
          {(name.charAt(0) || '?').toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold text-foreground">{name}</h3>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
            {maskPhone(customer.guest_phone, customer.phone_normalized)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-semibold tabular-nums text-foreground">
            {formatInteger(customer.total_visits)} {customer.total_visits === 1 ? 'visita' : 'visitas'}
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-black/[0.06] transition-colors group-hover:bg-primary-soft group-hover:text-primary">
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-10">
        <CustomerTypeBadge type={customer.customer_type} />
        <FrequencyBadge band={customer.frequency_band} />
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {formatInteger(customer.prior_visits)} antes ·{' '}
          <strong className="font-semibold text-primary">{formatInteger(customer.period_visits)} no período</strong>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-10 text-[11px] text-muted-foreground">
        <span>Última visita: <strong className="font-medium tabular-nums text-foreground">{formatDate(customer.last_visit_date)}</strong></span>
        {customer.next_reservation_date && (
          <span>
            Próxima: <strong className="font-medium tabular-nums text-success">{formatDate(customer.next_reservation_date)}</strong>
          </span>
        )}
      </div>
    </button>
  );
}

export default function CustomerRecurrenceReport() {
  const { companyId, slug } = useCompanySlug();
  const [periodMode, setPeriodMode] = useState<PeriodMode>('current_month');
  const [customRange, setCustomRange] = useState<DateRange | undefined>(createCurrentMonthRange);
  const [includeCompanions, setIncludeCompanions] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [minimumTotalVisits, setMinimumTotalVisits] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecurrenceRow | null>(null);

  useEffect(() => {
    const normalizedSearch = normalizeCustomerRecurrenceSearch(searchInput);
    if (normalizedSearch === debouncedSearch) return undefined;

    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(normalizedSearch);
      setPage(1);
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [debouncedSearch, searchInput]);

  const effectiveRange = useMemo(
    () => getPeriodRange(periodMode, customRange),
    [customRange, periodMode],
  );
  const periodStart = format(effectiveRange.from!, 'yyyy-MM-dd');
  const periodEnd = format(effectiveRange.to!, 'yyyy-MM-dd');
  const periodLengthDays = differenceInCalendarDays(effectiveRange.to!, effectiveRange.from!) + 1;
  const customPeriodError = periodMode === 'custom' && periodLengthDays > 366
    ? `O intervalo selecionado tem ${formatInteger(periodLengthDays)} dias. Escolha um período de no máximo 366 dias.`
    : null;

  const reportQuery = useCustomerRecurrenceReport({
    companyId,
    periodStart,
    periodEnd,
    comparisonMode: periodMode === 'custom' ? 'previous_period' : 'month_to_date',
    includeCompanions,
    page,
    pageSize: PAGE_SIZE,
    search: debouncedSearch,
    minTotalVisits: minimumTotalVisits,
    enabled: !customPeriodError,
  });
  const selectedLeadProfileQuery = useCustomerRecurrenceLeadProfile({
    companyId,
    profileRef: selectedCustomer?.profile_ref,
    expectedPhoneLast4: selectedCustomer?.phone_normalized,
    enabled: !!selectedCustomer,
  });

  const report = reportQuery.data;
  const selectedLeadProfile = selectedLeadProfileQuery.data
    ? mapCrmLeadRowToProfile(selectedLeadProfileQuery.data)
    : null;
  const totalPages = Math.max(
    1,
    Math.ceil((report?.meta.filtered_customers_total ?? 0) / (report?.meta.page_size ?? PAGE_SIZE)),
  );
  const displayedPage = resolveCustomerRecurrenceDisplayedPage(page, report?.meta.page);
  const isChangingPage = !!report
    && reportQuery.isPlaceholderData
    && reportQuery.isFetching
    && page !== report.meta.page;
  const isSearchPending = normalizeCustomerRecurrenceSearch(searchInput) !== debouncedSearch;
  const isUpdatingCustomerBase = isChangingPage || isSearchPending;

  useEffect(() => {
    if (report && page > totalPages) setPage(totalPages);
  }, [page, report, totalPages]);

  const comparisonLabel = report
    ? formatRangeLabel(report.comparison.period_start, report.comparison.period_end)
    : 'período anterior';
  const visiblePages = getVisiblePages(displayedPage, totalPages);

  const compositionData = useMemo(
    () => (report?.monthly_composition ?? []).map((row) => ({
      ...row,
      label: formatMonth(row.month),
    })),
    [report?.monthly_composition],
  );
  const hasCompositionData = compositionData.some((row) => row.identified_customers > 0);

  const frequencyData = useMemo(
    () => (report?.frequency_bands ?? []).map((band) => ({
      ...band,
      label: FREQUENCY_META[band.key].label,
      color: FREQUENCY_META[band.key].color,
      description: FREQUENCY_META[band.key].description,
    })),
    [report?.frequency_bands],
  );
  const hasFrequencyData = frequencyData.some((band) => band.customers > 0);
  const hasCustomerFilters = !!debouncedSearch || !!minimumTotalVisits;
  const reportErrorMessage = reportQuery.error instanceof Error
    && reportQuery.error.message.startsWith('O relatório de recorrência')
    ? reportQuery.error.message
    : 'Confira sua conexão e tente novamente. Se o problema continuar, contate o suporte.';

  const handlePeriodModeChange = (value: PeriodMode) => {
    setPeriodMode(value);
    setPage(1);
  };

  const handleCustomRangeChange = (range: DateRange | undefined) => {
    if (!range?.from) return;
    setCustomRange({ from: range.from, to: range.to ?? range.from });
    setPage(1);
  };

  const handleIncludeCompanionsChange = (checked: boolean) => {
    setIncludeCompanions(checked);
    setPage(1);
  };

  const clearCustomerFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setMinimumTotalVisits(undefined);
    setPage(1);
  };

  const goToPage = (nextPage: number) => {
    setPage(Math.min(Math.max(nextPage, 1), totalPages));
  };

  const filterBar = (
    <Card className="border-border bg-card/95 shadow-sm">
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 xl:max-w-[620px]">
            <div className="space-y-1.5">
              <div className="flex h-6 items-center gap-1">
                <Label htmlFor="recurrence-period">Período da análise</Label>
                <InfoTooltip
                  content="Nos períodos mensais, a comparação usa o mesmo recorte do mês anterior. No período personalizado, usa um intervalo anterior com a mesma duração."
                  ariaLabel="Entender a comparação entre períodos"
                  interaction="popover"
                />
              </div>
              <Select value={periodMode} onValueChange={(value) => handlePeriodModeChange(value as PeriodMode)}>
                <SelectTrigger id="recurrence-period" className="h-11" aria-label="Período da análise">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_month">Mês atual</SelectItem>
                  <SelectItem value="last_month">Mês anterior</SelectItem>
                  <SelectItem value="custom">Período personalizado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {periodMode === 'custom' ? (
              <div
                className="space-y-1.5"
                role="group"
                aria-labelledby="recurrence-custom-range-label"
              >
                <div className="flex h-6 items-center">
                  <p id="recurrence-custom-range-label" className="text-sm font-medium leading-none">
                    Intervalo personalizado
                  </p>
                </div>
                <DateRangePicker
                  value={customRange}
                  onChange={handleCustomRangeChange}
                  className="h-11 w-full"
                  align="start"
                />
                {customPeriodError && (
                  <p className="text-xs leading-relaxed text-destructive" role="alert">
                    {customPeriodError}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex h-6 items-center">
                  <Label>Intervalo considerado</Label>
                </div>
                <div className="flex h-11 items-center rounded-md border border-border bg-muted/25 px-3 text-sm tabular-nums text-muted-foreground">
                  {format(effectiveRange.from!, 'dd/MM/yyyy')} – {format(effectiveRange.to!, 'dd/MM/yyyy')}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between xl:justify-end">
            <div className="w-full space-y-1.5 sm:w-auto sm:min-w-[284px]">
              <div className="flex h-6 items-center gap-1">
                <Label htmlFor="include-companions" className="cursor-pointer text-sm">
                  Incluir acompanhantes
                </Label>
                <InfoTooltip
                  content="Quando ativado, acompanhantes com telefone informado também entram nos cálculos. Telefones repetidos no mesmo atendimento contam uma vez."
                  ariaLabel="Entender a inclusão de acompanhantes"
                  interaction="popover"
                />
              </div>
              <div className="flex h-11 items-center gap-3 rounded-md border border-border bg-muted/20 px-3">
                <Switch
                  id="include-companions"
                  checked={includeCompanions}
                  onCheckedChange={handleIncludeCompanionsChange}
                  aria-describedby="include-companions-help"
                />
                <p id="include-companions-help" className="text-[11px] text-muted-foreground">
                  Apenas os identificados por telefone
                </p>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0 self-end"
              onClick={() => reportQuery.refetch()}
              disabled={reportQuery.isFetching || isSearchPending || !!customPeriodError}
              aria-label="Atualizar relatório"
              title="Atualizar relatório"
            >
              <RefreshCcw
                className={cn('h-4 w-4', reportQuery.isFetching && 'animate-spin motion-reduce:animate-none')}
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div
      className="min-w-0 space-y-6 overflow-x-hidden"
      aria-busy={reportQuery.isFetching || isSearchPending}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Recorrência de clientes</h1>
            <Badge variant="outline" className="border-primary/20 bg-primary-soft text-accent-foreground">
              CRM de retenção
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Entenda quem voltou, quem está começando um relacionamento e quais clientes já criaram hábito.
          </p>
        </div>
        {(isSearchPending || (reportQuery.isFetching && !reportQuery.isLoading)) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {isSearchPending ? 'Aplicando busca…' : 'Atualizando dados…'}
          </div>
        )}
      </header>

      {filterBar}

      {reportQuery.isError && !report && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Não foi possível carregar o relatório</AlertTitle>
          <AlertDescription className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{reportErrorMessage}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => reportQuery.refetch()}>
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {reportQuery.isLoading ? (
        <ReportSkeleton />
      ) : report ? (
        <>
          {reportQuery.isError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>Os dados não puderam ser atualizados</AlertTitle>
              <AlertDescription>
                Os últimos dados carregados continuam visíveis abaixo. {reportErrorMessage}
              </AlertDescription>
            </Alert>
          )}

          {report.summary.identified_customers === 0 ? (
            <Card className="border-dashed border-border bg-card/70">
              <CardContent className="flex min-h-[360px] flex-col items-center justify-center px-6 py-16 text-center">
                <div className="rounded-full bg-primary-soft p-4 text-primary">
                  <CalendarSearch className="h-8 w-8" aria-hidden="true" />
                </div>
                <h2 className="mt-5 text-lg font-semibold">Nenhuma visita identificada neste período</h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                  O relatório considera clientes com telefone e presença confirmada. Escolha outro intervalo ou inclua acompanhantes identificados.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <section aria-labelledby="recurrence-summary-title">
                <div className="sr-only">
                  <h2 id="recurrence-summary-title">Resumo da recorrência</h2>
                  <p>Comparação com {comparisonLabel}.</p>
                </div>
                <div className="mb-3 rounded-lg border border-info/15 bg-info-soft/45 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground">Como ler: </span>
                  <span><strong>recorrente</strong> já visitava antes do período; <strong>repetiu no período</strong> fez duas ou mais visitas dentro dele.</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 xl:grid-cols-5">
                  <KpiCard
                    className="lg:col-span-2 xl:col-span-1"
                    label="Recorrentes"
                    value={formatInteger(report.summary.returning_customers)}
                    helper="Já tinham uma visita antes do período"
                    explanation="Clientes do período que já tinham pelo menos uma visita anterior registrada. É consultado todo o histórico disponível, sem limite de 30, 60 ou 90 dias."
                    icon={UserCheck}
                    tone="success"
                    current={report.summary.returning_customers}
                    previous={report.comparison.returning_customers}
                    comparisonLabel={comparisonLabel}
                  />
                  <KpiCard
                    className="lg:col-span-2 xl:col-span-1"
                    label="Taxa de recorrência"
                    value={formatPercent(report.summary.recurrence_rate)}
                    helper="Recorrentes entre todos os identificados"
                    explanation="Recorrentes ÷ clientes identificados × 100. Exemplo: 7 recorrentes entre 368 identificados resultam em 1,9%."
                    icon={Repeat2}
                    tone="success"
                    current={report.summary.recurrence_rate}
                    previous={report.comparison.recurrence_rate}
                    comparisonLabel={comparisonLabel}
                    percentagePoints
                  />
                  <KpiCard
                    className="lg:col-span-2 xl:col-span-1"
                    label="Novos clientes"
                    value={formatInteger(report.summary.new_customers)}
                    helper="Primeira visita registrada no sistema"
                    explanation="Clientes cuja primeira visita registrada aconteceu dentro do período. Quem veio duas vezes pela primeira vez ainda é considerado novo aqui."
                    icon={UserPlus}
                    tone="primary"
                    current={report.summary.new_customers}
                    previous={report.comparison.new_customers}
                    comparisonLabel={comparisonLabel}
                  />
                  <KpiCard
                    className="lg:col-span-3 xl:col-span-1"
                    label="Repetiram no período"
                    value={formatInteger(report.summary.repeated_in_period)}
                    helper={`${formatPercent(report.summary.repeat_rate)} fizeram 2 ou mais visitas`}
                    explanation="Clientes com duas ou mais visitas dentro do intervalo selecionado, independentemente de já terem uma visita anterior."
                    icon={CalendarClock}
                    tone="info"
                    current={report.summary.repeated_in_period}
                    previous={report.comparison.repeated_in_period}
                    comparisonLabel={comparisonLabel}
                  />
                  <KpiCard
                    className="lg:col-span-3 xl:col-span-1"
                    label="Visitas adicionais"
                    value={formatInteger(report.summary.additional_visits)}
                    helper="Visitas além da primeira no intervalo"
                    explanation="Soma das visitas além da primeira de cada cliente dentro do intervalo. Exemplo: três visitas do mesmo cliente geram duas visitas adicionais."
                    icon={Repeat2}
                    tone="warning"
                    current={report.summary.additional_visits}
                    previous={report.comparison.additional_visits}
                    comparisonLabel={comparisonLabel}
                  />
                </div>
              </section>

              <section className="grid min-w-0 gap-6 xl:grid-cols-5" aria-label="Gráficos de recorrência">
                <Card className="min-w-0 border-border shadow-sm xl:col-span-3">
                  <CardHeader className="pb-2">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <CardTitle id="monthly-composition-title">Novos × recorrentes</CardTitle>
                          <InfoTooltip
                            content="Em cada mês, é recorrente quem já tinha uma visita antes do primeiro dia daquele mês. A janela termina no mês do fim do período selecionado, que pode ser diferente do mês atual."
                            ariaLabel="Entender o gráfico de novos e recorrentes"
                            interaction="popover"
                          />
                        </div>
                        <CardDescription className="mt-1">
                          Janela de 6 meses encerrada em {formatMonth(report.meta.period_end)}
                        </CardDescription>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground sm:text-right">
                        <p className="font-medium tabular-nums text-foreground">
                          {formatInteger(report.summary.period_visits)} visitas no período
                        </p>
                        <p>{decimalFormatter.format(report.summary.avg_visits_per_customer)} por cliente</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-3">
                    {hasCompositionData ? (
                      <div className="h-[290px] w-full min-w-0" aria-labelledby="monthly-composition-title">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={compositionData} margin={{ top: 10, right: 4, left: -20, bottom: 0 }} accessibilityLayer>
                            <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                            <XAxis
                              dataKey="label"
                              axisLine={false}
                              tickLine={false}
                              tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                              dy={8}
                            />
                            <YAxis
                              allowDecimals={false}
                              axisLine={false}
                              tickLine={false}
                              tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                            />
                            <RechartsTooltip
                              cursor={{ fill: 'hsl(var(--muted))', opacity: 0.45 }}
                              contentStyle={{
                                borderRadius: '10px',
                                border: '1px solid hsl(var(--border))',
                                background: 'hsl(var(--card))',
                                boxShadow: '0 8px 24px rgba(0,0,0,.08)',
                                fontSize: '12px',
                              }}
                              formatter={(value, name) => [
                                `${formatInteger(Number(value))} clientes`,
                                name === 'new_customers' ? 'Novos' : 'Recorrentes',
                              ]}
                            />
                            <Legend
                              iconType="circle"
                              iconSize={8}
                              formatter={(value) => (
                                <span className="text-xs text-muted-foreground">
                                  {value === 'new_customers' ? 'Novos' : 'Recorrentes'}
                                </span>
                              )}
                            />
                            <Bar dataKey="new_customers" name="new_customers" stackId="customers" fill={CHART_COLORS.newCustomers} />
                            <Bar
                              dataKey="returning_customers"
                              name="returning_customers"
                              stackId="customers"
                              fill={CHART_COLORS.returningCustomers}
                              radius={[5, 5, 0, 0]}
                            />
                          </BarChart>
                        </ResponsiveContainer>
                        <ul className="sr-only">
                          {compositionData.map((month) => (
                            <li key={month.month}>
                              {month.label}: {formatInteger(month.new_customers)} novos e{' '}
                              {formatInteger(month.returning_customers)} recorrentes.
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="flex h-[290px] items-center justify-center text-center text-sm text-muted-foreground">
                        Ainda não há histórico mensal suficiente para este gráfico.
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="min-w-0 border-border shadow-sm xl:col-span-2">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-1.5">
                      <CardTitle id="frequency-bands-title">Faixas de frequência</CardTitle>
                      <InfoTooltip
                        content="Entre os clientes que visitaram no período, agrupa pela quantidade total de visitas acumuladas até o fim do intervalo, somando o histórico anterior."
                        ariaLabel="Entender o gráfico de faixas de frequência"
                        interaction="popover"
                      />
                    </div>
                    <CardDescription className="mt-1">
                      Considera todo o histórico acumulado até o fim do período
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-3">
                    {hasFrequencyData ? (
                      <>
                        <div className="h-[210px] w-full min-w-0" aria-labelledby="frequency-bands-title">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                              data={frequencyData}
                              layout="vertical"
                              margin={{ top: 4, right: 20, left: 0, bottom: 0 }}
                              accessibilityLayer
                            >
                              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
                              <XAxis
                                type="number"
                                allowDecimals={false}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                              />
                              <YAxis
                                type="category"
                                dataKey="label"
                                width={74}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: CHART_COLORS.axis, fontSize: 11 }}
                              />
                              <RechartsTooltip
                                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.45 }}
                                contentStyle={{
                                  borderRadius: '10px',
                                  border: '1px solid hsl(var(--border))',
                                  background: 'hsl(var(--card))',
                                  boxShadow: '0 8px 24px rgba(0,0,0,.08)',
                                  fontSize: '12px',
                                }}
                                formatter={(value) => [`${formatInteger(Number(value))} clientes`, 'Clientes']}
                              />
                              <Bar dataKey="customers" radius={[0, 5, 5, 0]} maxBarSize={24}>
                                {frequencyData.map((band) => <Cell key={band.key} fill={band.color} />)}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                          <ul className="sr-only">
                            {frequencyData.map((band) => (
                              <li key={band.key}>
                                {band.description}: {formatInteger(band.customers)} clientes,{' '}
                                {formatPercent(band.percentage)}.
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          {frequencyData.map((band) => (
                            <div key={band.key} className="rounded-lg border border-border bg-muted/20 p-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: band.color }} />
                                  <span className="truncate">{band.description}</span>
                                </span>
                                <span className="text-xs font-semibold tabular-nums">{formatInteger(band.customers)}</span>
                              </div>
                              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">{formatPercent(band.percentage)}</p>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="flex h-[290px] items-center justify-center text-center text-sm text-muted-foreground">
                        Nenhum cliente para distribuir nas faixas.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </section>

              <section aria-labelledby="customer-base-title">
                <Card className="min-w-0 overflow-hidden border-0 bg-card/95 shadow-sm ring-1 ring-black/[0.05]">
                  <CardHeader className="gap-3 px-4 pb-3 pt-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <CardTitle id="customer-base-title" className="text-base">Clientes do período</CardTitle>
                        <InfoTooltip
                          content="Uma linha por telefone identificado. “Antes” mostra as visitas anteriores ao intervalo; “No período”, as visitas dentro dele; e “Total”, o histórico somente até o fim do intervalo. Na página de Leads, “Visitas” considera todo o histórico disponível do contato, inclusive depois desse corte. A opção “Incluir acompanhantes” também pode mudar a base; por isso os totais das duas telas podem diferir."
                          ariaLabel="Entender a base de clientes"
                          interaction="popover"
                        />
                      </div>
                      <CardDescription className="mt-0.5 text-xs">
                        Selecione um cliente para consultar seu perfil e histórico
                      </CardDescription>
                    </div>
                    <div className="grid w-full gap-3 sm:grid-cols-[minmax(220px,1fr)_160px] lg:w-auto lg:grid-cols-[280px_160px]">
                      <div className="space-y-1.5">
                        <Label htmlFor="customer-search" className="text-xs text-muted-foreground">
                          Cliente
                        </Label>
                        <div className="relative">
                          <Search
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <Input
                            id="customer-search"
                            type="search"
                            name="customer-search"
                            autoComplete="off"
                            maxLength={CUSTOMER_RECURRENCE_SEARCH_MAX_LENGTH}
                            value={searchInput}
                            onChange={(event) => {
                              setSearchInput(event.target.value);
                            }}
                            placeholder="Nome ou telefone…"
                            className="h-9 pl-9 pr-9 text-xs"
                            aria-label="Buscar cliente por nome ou telefone"
                          />
                          {(isSearchPending || (reportQuery.isFetching && !!debouncedSearch)) && (
                            <Loader2
                              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1">
                          <Label htmlFor="minimum-total-visits" className="text-xs text-muted-foreground">
                            Mínimo de visitas
                          </Label>
                          <InfoTooltip
                            content="Filtra somente a base abaixo pelo histórico total acumulado até o fim do período; os cards e gráficos não mudam. Digite 2 para ver quem visitou duas vezes ou mais."
                            ariaLabel="Entender o filtro de mínimo de visitas"
                            interaction="popover"
                          />
                        </div>
                        <Input
                          id="minimum-total-visits"
                          type="number"
                          min={1}
                          max={CUSTOMER_RECURRENCE_MIN_VISITS_MAX}
                          step={1}
                          inputMode="numeric"
                          value={minimumTotalVisits ?? ''}
                          onChange={(event) => {
                            const rawValue = event.target.value;
                            const parsedValue = Number(rawValue);
                            const normalizedValue = normalizeMinimumTotalVisits(parsedValue);
                            setMinimumTotalVisits(rawValue === '' ? undefined : normalizedValue ?? undefined);
                            setPage(1);
                          }}
                          placeholder="Ex.: 2"
                          className="h-9 tabular-nums text-xs"
                          aria-label="Quantidade mínima de visitas totais"
                        />
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="relative p-0">
                    {isUpdatingCustomerBase && (
                      <div
                        className="absolute inset-0 z-20 flex min-h-[250px] items-center justify-center bg-card/80 backdrop-blur-[1px]"
                        role="status"
                        aria-live="polite"
                      >
                        <div className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground shadow-sm">
                          <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
                          {isSearchPending ? 'Aplicando busca…' : `Carregando página ${page}…`}
                        </div>
                      </div>
                    )}
                    {report.customers.length === 0 ? (
                      <div className="flex min-h-[250px] flex-col items-center justify-center px-6 py-12 text-center">
                        <Search className="h-7 w-7 text-muted-foreground/60" aria-hidden="true" />
                        <h3 className="mt-4 text-sm font-semibold">
                          {hasCustomerFilters ? 'Nenhum cliente corresponde aos filtros' : 'Nenhum cliente encontrado'}
                        </h3>
                        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                          {hasCustomerFilters
                            ? 'Tente outro nome, telefone ou reduza o mínimo de visitas.'
                            : 'Não há clientes para exibir neste período.'}
                        </p>
                        {hasCustomerFilters && (
                          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={clearCustomerFilters}>
                            Limpar filtros
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="hidden xl:block">
                          <Table className="min-w-[840px] text-xs">
                            <TableHeader className="bg-muted/25">
                              <TableRow className="hover:bg-transparent">
                                <TableHead className="h-8 min-w-[190px] px-3 text-[11px]">Cliente</TableHead>
                                <TableHead className="h-8 px-2 text-[11px]">Perfil</TableHead>
                                <TableHead className="h-8 px-2 text-center text-[11px]">Antes</TableHead>
                                <TableHead className="h-8 px-2 text-center text-[11px]">No período</TableHead>
                                <TableHead className="h-8 px-2 text-center text-[11px]">Total</TableHead>
                                <TableHead className="h-8 whitespace-nowrap px-2 text-[11px]">Primeira → última</TableHead>
                                <TableHead className="h-8 whitespace-nowrap px-2 text-[11px]">Próxima reserva</TableHead>
                                <TableHead className="h-8 w-9 px-2" />
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {report.customers.map((customer) => {
                                const customerName = customer.guest_name?.trim() || 'Cliente sem nome';
                                const isSelected = selectedCustomer?.customer_key === customer.customer_key;

                                return (
                                  <TableRow
                                    key={customer.customer_key}
                                    data-state={isSelected ? 'selected' : undefined}
                                    className="group cursor-pointer hover:bg-primary-soft/25"
                                    onClick={() => setSelectedCustomer(customer)}
                                  >
                                    <TableCell className="px-3 py-1.5">
                                      <div className="flex min-w-0 items-center gap-2">
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary-soft text-[11px] font-bold text-primary ring-1 ring-primary/15">
                                          {(customerName.charAt(0) || '?').toUpperCase()}
                                        </div>
                                        <div className="min-w-0">
                                          <p className="max-w-[190px] truncate font-medium text-foreground">{customerName}</p>
                                          <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                                            {maskPhone(customer.guest_phone, customer.phone_normalized)}
                                          </p>
                                        </div>
                                      </div>
                                    </TableCell>
                                    <TableCell className="px-2 py-1.5">
                                      <div className="flex flex-wrap items-center gap-1">
                                        <CustomerTypeBadge type={customer.customer_type} />
                                        <FrequencyBadge band={customer.frequency_band} />
                                      </div>
                                    </TableCell>
                                    <TableCell className="px-2 py-1.5 text-center tabular-nums text-muted-foreground">
                                      {formatInteger(customer.prior_visits)}
                                    </TableCell>
                                    <TableCell className="px-2 py-1.5 text-center font-semibold tabular-nums text-primary">
                                      {formatInteger(customer.period_visits)}
                                    </TableCell>
                                    <TableCell className="px-2 py-1.5 text-center font-semibold tabular-nums">
                                      {formatInteger(customer.total_visits)}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap px-2 py-1.5 text-[11px] tabular-nums text-muted-foreground">
                                      {formatDate(customer.first_visit_date)} → {formatDate(customer.last_visit_date)}
                                    </TableCell>
                                    <TableCell className={cn(
                                      'whitespace-nowrap px-2 py-1.5 text-[11px] tabular-nums',
                                      customer.next_reservation_date ? 'font-medium text-success' : 'text-muted-foreground',
                                    )}>
                                      {formatDate(customer.next_reservation_date)}
                                    </TableCell>
                                    <TableCell className="px-2 py-1.5">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="ml-auto h-8 w-8 text-muted-foreground group-hover:bg-primary-soft group-hover:text-primary"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSelectedCustomer(customer);
                                        }}
                                        aria-label={`Abrir perfil de ${customerName}`}
                                      >
                                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                                      </Button>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>

                        <div className="xl:hidden">
                          {report.customers.map((customer) => (
                            <CustomerMobileCard
                              key={customer.customer_key}
                              customer={customer}
                              isSelected={selectedCustomer?.customer_key === customer.customer_key}
                              onSelect={setSelectedCustomer}
                            />
                          ))}
                        </div>
                      </>
                    )}

                    {report.meta.filtered_customers_total > 0 && (
                      <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-muted-foreground" aria-live="polite">
                          {formatInteger((report.meta.page - 1) * report.meta.page_size + 1)}–{formatInteger(Math.min(report.meta.page * report.meta.page_size, report.meta.filtered_customers_total))}
                          {' '}de {formatInteger(report.meta.filtered_customers_total)} clientes
                          {(debouncedSearch || minimumTotalVisits) && report.meta.filtered_customers_total !== report.meta.customers_total
                            ? ` · ${formatInteger(report.meta.customers_total)} no período`
                            : ''}
                        </p>

                        {totalPages > 1 && (
                          <Pagination
                            className="mx-0 w-auto justify-start sm:justify-end"
                            aria-label="Paginação da base de clientes"
                          >
                            <PaginationContent>
                              <PaginationItem>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={displayedPage === 1 || reportQuery.isFetching || isSearchPending}
                                  onClick={() => goToPage(displayedPage - 1)}
                                  aria-label="Ir para página anterior"
                                >
                                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </PaginationItem>
                              {visiblePages.map((visiblePage, index) => (
                                <PaginationItem key={`${visiblePage}-${index}`} className="hidden sm:list-item">
                                  {visiblePage === 'ellipsis' ? (
                                    <PaginationEllipsis />
                                  ) : (
                                    <Button
                                      type="button"
                                      variant={visiblePage === displayedPage ? 'outline' : 'ghost'}
                                      size="icon"
                                      className="h-9 w-9"
                                      aria-label={`Ir para página ${visiblePage}`}
                                      aria-current={visiblePage === displayedPage ? 'page' : undefined}
                                      disabled={reportQuery.isFetching || isSearchPending}
                                      onClick={() => goToPage(visiblePage)}
                                    >
                                      {visiblePage}
                                    </Button>
                                  )}
                                </PaginationItem>
                              ))}
                              <PaginationItem className="sm:hidden">
                                <span className="px-2 text-xs text-muted-foreground">
                                  {displayedPage} / {totalPages}
                                </span>
                              </PaginationItem>
                              <PaginationItem>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-9 w-9"
                                  disabled={displayedPage === totalPages || reportQuery.isFetching || isSearchPending}
                                  onClick={() => goToPage(displayedPage + 1)}
                                  aria-label="Ir para próxima página"
                                >
                                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </PaginationItem>
                            </PaginationContent>
                          </Pagination>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </section>
            </>
          )}
        </>
      ) : null}

      <LeadProfileDialog
        open={!!selectedCustomer}
        onOpenChange={(open) => {
          if (!open) setSelectedCustomer(null);
        }}
        lead={selectedLeadProfile}
        companyId={companyId}
        slug={slug}
        profileLoading={selectedLeadProfileQuery.isLoading || selectedLeadProfileQuery.isFetching}
        profileError={selectedLeadProfileQuery.isError
          ? 'Não foi possível carregar o perfil deste cliente. Atualize a base e tente novamente.'
          : null}
        onRetryProfile={() => selectedLeadProfileQuery.refetch()}
        onRefreshLead={async (lead) => {
          const refreshed = await selectedLeadProfileQuery.refetch();
          return !!refreshed.data
            && refreshed.data.canonical_visit_count !== lead.total_reservations;
        }}
      />
    </div>
  );
}
