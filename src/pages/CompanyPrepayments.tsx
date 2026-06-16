import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth, subDays, subMonths } from 'date-fns';
import {
  AlertTriangle,
  Archive,
  Banknote,
  CheckCircle2,
  Copy,
  CreditCard,
  KeyRound,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { supabase } from '@/integrations/supabase/client';
import type { DateRange } from 'react-day-picker';
import { checkReservationPayment, getAsaasConfig, refundReservationPayment, saveAsaasConfig, testAsaasConfig } from '@/lib/asaas-prepayment-api';
import {
  DEFAULT_ASAAS_CONFIG_PREVIEW,
  calculateReservationPaymentAmount,
  formatPrepaymentAmount,
  getAmountTypeLabel,
  getBillingTypeLabel,
  getPaymentStatusLabel,
  type ReservationPrepaymentBillingType,
  type ReservationPaymentStatus,
  type ReservationPaymentRuleDraft,
  type ReservationPrepaymentAmountType,
} from '@/lib/asaas-prepayment-contracts';
import { toBrazilWhatsAppNumber } from '@/lib/validation';

interface RuleFormState {
  name: string;
  date_start: string;
  date_end: string;
  amount_type: ReservationPrepaymentAmountType;
  amount: string;
  pix_enabled: boolean;
  pix_amount: string;
  credit_card_enabled: boolean;
  credit_card_amount: string;
  max_credit_card_installments: string;
  payment_deadline_minutes: string;
  customer_notice: string;
  cancellation_policy: string;
}

type RuleTab = 'active' | 'inactive' | 'archived' | 'new';
type SummaryPeriodPreset = 'today' | 'last_7_days' | 'last_30_days' | 'this_month' | 'last_month' | 'custom';
type PaymentStatusFilter = 'all' | ReservationPaymentStatus;

interface PendingRuleAction {
  ruleId: string;
}

interface BulkCheckResult {
  paymentId: string;
  paymentToken: string;
  customerName: string;
  previousStatus: ReservationPaymentStatus;
  currentStatus: ReservationPaymentStatus | null;
  changed: boolean;
  message: string | null;
  error: string | null;
}

interface ReservationPaymentRow {
  id: string;
  payment_token: string | null;
  customer_name: string;
  customer_phone: string | null;
  reservation_status: string | null;
  reservation_date: string;
  reservation_time: string;
  party_size: number;
  rule_name: string;
  amount: number;
  refunded_amount: number;
  billing_type: ReservationPrepaymentBillingType | null;
  installments: number | null;
  status: ReservationPaymentStatus;
  expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

interface FinancialDailyPoint {
  date: string;
  day: string;
  paid: number;
  expired: number;
  pending: number;
  refunded: number;
  chargeback: number;
  refundPending: number;
  paidCount: number;
  expiredCount: number;
  pendingCount: number;
  refundedCount: number;
  chargebackCount: number;
  refundPendingCount: number;
}

const today = new Date();
const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
const PAYMENT_AUTO_REFRESH_INTERVAL_MS = 30_000;

const SUMMARY_PERIOD_OPTIONS: Array<{ value: SummaryPeriodPreset; label: string }> = [
  { value: 'today', label: 'Hoje' },
  { value: 'last_7_days', label: 'Últimos 7 dias' },
  { value: 'last_30_days', label: 'Últimos 30 dias' },
  { value: 'this_month', label: 'Mês atual' },
  { value: 'last_month', label: 'Mês anterior' },
  { value: 'custom', label: 'Personalizado' },
];

const PAYMENT_STATUS_OPTIONS: Array<{ value: PaymentStatusFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'paid', label: 'Pagos' },
  { value: 'expired', label: 'Expirados' },
  { value: 'cancelled', label: 'Cancelados' },
  { value: 'late_paid', label: 'Pagos após expirar' },
  { value: 'refunded', label: 'Estornados' },
  { value: 'partial_refunded', label: 'Estornos parciais' },
  { value: 'refund_pending', label: 'Estornos pendentes' },
  { value: 'refund_denied', label: 'Estornos negados' },
  { value: 'chargeback', label: 'Chargebacks' },
];

const PAYMENT_PAGE_SIZE = 8;

function mapPaymentRowFromDb(row: any): ReservationPaymentRow {
  const reservation = row?.reservation ?? {};
  const snapshot = (row?.rule_snapshot && typeof row.rule_snapshot === 'object') ? row.rule_snapshot : {};
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  const providerStatusCheck = metadata?.provider_status_check && typeof metadata.provider_status_check === 'object'
    ? metadata.provider_status_check
    : null;
  const amount = typeof row?.charged_amount === 'number' && row.charged_amount > 0
    ? row.charged_amount
    : Number(row?.base_amount ?? 0);
  const providerRefundedAmount = Number(providerStatusCheck?.refunded_value ?? 0);
  const refundedAmount = Number.isFinite(providerRefundedAmount) && providerRefundedAmount > 0
    ? providerRefundedAmount
    : amount;

  return {
    id: row?.id ?? '',
    payment_token: row?.payment_token ?? null,
    customer_name: reservation?.guest_name ?? 'Cliente',
    customer_phone: reservation?.guest_phone ?? null,
    reservation_status: reservation?.status ?? null,
    reservation_date: reservation?.date ?? '',
    reservation_time: typeof reservation?.time === 'string' ? reservation.time.slice(0, 5) : '',
    party_size: Number(reservation?.party_size ?? 0),
    rule_name: typeof snapshot?.name === 'string' && snapshot.name ? snapshot.name : 'Pagamento antecipado',
    amount,
    refunded_amount: refundedAmount,
    billing_type: (row?.billing_type ?? null) as ReservationPrepaymentBillingType | null,
    installments: typeof row?.max_installments === 'number' ? row.max_installments : null,
    status: row?.status as ReservationPaymentStatus,
    expires_at: row?.expires_at ?? null,
    paid_at: row?.paid_at ?? null,
    cancelled_at: row?.cancelled_at ?? null,
    metadata,
    created_at: row?.created_at ?? new Date().toISOString(),
  };
}

function buildDailyFinancialBuckets(payments: ReservationPaymentRow[], from: Date, to: Date): FinancialDailyPoint[] {
  const buckets = new Map<string, FinancialDailyPoint>();
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());

  while (cursor.getTime() <= end.getTime()) {
    const key = format(cursor, 'yyyy-MM-dd');
    const day = format(cursor, 'dd/MM');
    buckets.set(key, {
      date: key,
      day,
      paid: 0,
      expired: 0,
      pending: 0,
      refunded: 0,
      chargeback: 0,
      refundPending: 0,
      paidCount: 0,
      expiredCount: 0,
      pendingCount: 0,
      refundedCount: 0,
      chargebackCount: 0,
      refundPendingCount: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const payment of payments) {
    const financialEventDate = new Date(getFinancialEventDate(payment));
    if (Number.isNaN(financialEventDate.getTime())) continue;

    const key = toDateKey(financialEventDate);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (
      payment.status === 'paid'
      || payment.status === 'late_paid'
      || payment.status === 'refund_pending'
      || payment.status === 'refund_denied'
    ) {
      bucket.paid += payment.amount;
      bucket.paidCount += 1;

      if (payment.status === 'refund_pending') {
        bucket.refundPending += payment.refunded_amount;
        bucket.refundPendingCount += 1;
      }
    } else if (payment.status === 'expired') {
      bucket.expired += payment.amount;
      bucket.expiredCount += 1;
    } else if (payment.status === 'pending' || payment.status === 'awaiting_method') {
      bucket.pending += payment.amount;
      bucket.pendingCount += 1;
    } else if (payment.status === 'partial_refunded') {
      // Estorno parcial: a parte devolvida vira "estornado" e a parte retida
      // continua sendo receita (entra em paid), preservando o total recebido.
      const retained = Math.max(payment.amount - payment.refunded_amount, 0);
      bucket.paid += retained;
      bucket.refunded += payment.refunded_amount;
      bucket.refundedCount += 1;
    } else if (payment.status === 'refunded') {
      bucket.refunded += payment.amount;
      bucket.refundedCount += 1;
    } else if (payment.status === 'chargeback') {
      bucket.chargeback += payment.amount;
      bucket.chargebackCount += 1;
    }
  }

  return Array.from(buckets.values());
}

const DEFAULT_CUSTOMER_NOTICE = 'O valor pago será abatido da conta no dia da visita.';
const DEFAULT_CANCELLATION_POLICY = 'Se o pagamento não for confirmado dentro do prazo, a pré-reserva expira e a mesa volta a ficar disponível.';
const SUPABASE_FUNCTIONS_BASE_URL = (
  import.meta.env.VITE_SUPABASE_URL || 'https://hdpxqqiudiotanrybvcf.supabase.co'
).replace(/\/+$/, '');

const LEGACY_CUSTOMER_NOTICES = new Set([
  'Este valor sera abatido da conta no dia da visita.',
  'Este valor será abatido da conta no dia da visita.',
  'O valor pago sera abatido da conta no dia da visita.',
]);
const LEGACY_CANCELLATION_POLICIES = new Set([
  'Se o Pix nao for confirmado no prazo, a pre-reserva expira e a mesa volta a ficar disponivel.',
  'Se o Pix não for confirmado no prazo, a pré-reserva expira e a mesa volta a ficar disponível.',
  'Se o Pix não for confirmado dentro do prazo, a pré-reserva expira e a mesa volta a ficar disponível.',
]);

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function createRuleForm(): RuleFormState {
  const date = toDateInputValue(nextMonth);

  return {
    name: '',
    date_start: date,
    date_end: date,
    amount_type: 'per_person',
    amount: '80,00',
    pix_enabled: true,
    pix_amount: '80,00',
    credit_card_enabled: true,
    credit_card_amount: '90,00',
    max_credit_card_installments: '2',
    payment_deadline_minutes: '10',
    customer_notice: DEFAULT_CUSTOMER_NOTICE,
    cancellation_policy: DEFAULT_CANCELLATION_POLICY,
  };
}

function parseCurrencyInput(value: string) {
  const normalized = value.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDateRange(start: string, end: string) {
  if (start === end) return start.split('-').reverse().join('/');
  return `${start.split('-').reverse().join('/')} - ${end.split('-').reverse().join('/')}`;
}

function formatDateTime(value: string | null) {
  if (!value) return 'Não registrado';
  return format(new Date(value), "dd/MM/yyyy 'às' HH:mm");
}

function isDateOnlyValue(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDateOnly(value: string) {
  return value.split('-').reverse().join('/');
}

function isUtcMidnightTimestamp(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime())
    && date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;
}

function formatUtcDateOnly(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'NÃ£o registrado';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function formatPaymentPaidAt(payment: ReservationPaymentRow) {
  const confirmation = payment.metadata?.payment_confirmation;
  const providerPaidAt = confirmation && typeof confirmation === 'object'
    ? (confirmation as Record<string, any>).provider_paid_at
    : null;
  const providerPaidAtRecord = providerPaidAt && typeof providerPaidAt === 'object'
    ? providerPaidAt as Record<string, any>
    : null;

  if (
    providerPaidAtRecord
    && providerPaidAtRecord.precision === 'date'
    && isDateOnlyValue(providerPaidAtRecord.date)
  ) {
    return formatDateOnly(providerPaidAtRecord.date);
  }

  if (isUtcMidnightTimestamp(payment.paid_at)) {
    return formatUtcDateOnly(payment.paid_at!);
  }

  return formatDateTime(payment.paid_at);
}

function getFinancialEventDate(payment: ReservationPaymentRow) {
  if (payment.status === 'paid' || payment.status === 'late_paid') {
    return payment.paid_at ?? payment.created_at;
  }

  if (
    payment.status === 'refunded'
    || payment.status === 'partial_refunded'
    || payment.status === 'refund_pending'
    || payment.status === 'refund_denied'
    || payment.status === 'chargeback'
    || payment.status === 'cancelled'
  ) {
    return payment.cancelled_at ?? payment.paid_at ?? payment.created_at;
  }

  if (payment.status === 'expired') {
    return payment.cancelled_at ?? payment.expires_at ?? payment.created_at;
  }

  return payment.created_at;
}

function formatShortDate(value: string) {
  return value.split('-').reverse().join('/');
}

function toDateKey(date: Date) {
  return format(date, 'yyyy-MM-dd');
}

function formatDateRangePickerLabel(range: DateRange | undefined) {
  if (!range?.from) return 'Período não definido';
  const to = range.to ?? range.from;
  return formatDateRange(toDateKey(range.from), toDateKey(to));
}

function normalizeSearchValue(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatCurrencyAxisTick(value: number) {
  if (Math.abs(value) >= 1000) {
    return `R$ ${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  }

  return `R$ ${Math.round(value).toLocaleString('pt-BR')}`;
}

function formatTooltipCurrency(value: unknown) {
  const amount = Number(value);
  return formatPrepaymentAmount(Number.isFinite(amount) ? amount : 0);
}

function getSummaryPresetRange(preset: SummaryPeriodPreset): DateRange {
  const currentDate = new Date();

  switch (preset) {
    case 'today':
      return { from: currentDate, to: currentDate };
    case 'last_30_days':
      return { from: subDays(currentDate, 29), to: currentDate };
    case 'this_month':
      return { from: startOfMonth(currentDate), to: currentDate };
    case 'last_month': {
      const previousMonth = subMonths(currentDate, 1);
      return { from: startOfMonth(previousMonth), to: endOfMonth(previousMonth) };
    }
    case 'last_7_days':
    case 'custom':
    default:
      return { from: subDays(currentDate, 6), to: currentDate };
  }
}

function getRuleImpact(rule: ReservationPaymentRuleDraft) {
  const samplePartySize = 2;
  const amount = calculateReservationPaymentAmount(rule, samplePartySize);
  const pixAmount = rule.pix_enabled && rule.pix_amount
    ? calculateReservationPaymentAmount({ amount: rule.pix_amount, amount_type: rule.amount_type }, samplePartySize)
    : null;
  const cardAmount = rule.credit_card_enabled && rule.credit_card_amount
    ? calculateReservationPaymentAmount({ amount: rule.credit_card_amount, amount_type: rule.amount_type }, samplePartySize)
    : null;

  return [
    `${samplePartySize} pessoas: sinal ${formatPrepaymentAmount(amount)}`,
    pixAmount ? `Pix ${formatPrepaymentAmount(pixAmount)}` : null,
    cardAmount ? `Cartão ${formatPrepaymentAmount(cardAmount)}${rule.max_credit_card_installments ? ` em até ${rule.max_credit_card_installments}x` : ''}` : null,
  ].filter(Boolean).join(' · ');
}

function rangesOverlap(firstStart: string, firstEnd: string, secondStart: string, secondEnd: string) {
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function findActiveRuleConflict(rule: ReservationPaymentRuleDraft, rules: ReservationPaymentRuleDraft[]) {
  return rules.find((item) =>
    item.id !== rule.id
    && item.enabled
    && !item.archived_at
    && rangesOverlap(rule.date_start, rule.date_end, item.date_start, item.date_end));
}

function getPaymentStatusClass(status: ReservationPaymentStatus) {
  const classes: Record<ReservationPaymentStatus, string> = {
    awaiting_method: 'border-warning/30 bg-warning/10 text-warning',
    pending: 'border-warning/30 bg-warning/10 text-warning',
    paid: 'border-success/30 bg-success/10 text-success',
    expired: 'border-destructive/30 bg-destructive/10 text-destructive',
    cancelled: 'border-muted bg-muted text-muted-foreground',
    failed: 'border-destructive/30 bg-destructive/10 text-destructive',
    late_paid: 'border-warning/30 bg-warning/10 text-warning',
    refunded: 'border-muted bg-muted text-muted-foreground',
    partial_refunded: 'border-muted bg-muted text-muted-foreground',
    refund_pending: 'border-warning/30 bg-warning/10 text-warning',
    refund_denied: 'border-destructive/30 bg-destructive/10 text-destructive',
    chargeback: 'border-destructive/30 bg-destructive/10 text-destructive',
  };

  return classes[status];
}

function isReservationCancelledStatus(status: string | null | undefined) {
  const normalizedStatus = String(status ?? '').trim().toLowerCase();
  return normalizedStatus === 'cancelled' || normalizedStatus === 'payment_cancelled';
}

function isReceivedPaymentStatus(status: ReservationPaymentStatus) {
  return status === 'paid' || status === 'late_paid';
}

function isLatePaidPayment(payment: Pick<ReservationPaymentRow, 'status' | 'reservation_status'>) {
  return payment.status === 'late_paid' || payment.reservation_status === 'paid_after_expiration';
}

function canRefundPayment(payment: ReservationPaymentRow) {
  return Boolean(payment.payment_token) && (payment.status === 'paid' || payment.status === 'late_paid');
}

function buildCompanyPublicReservationUrl(companySlug: string) {
  if (typeof window === 'undefined') return `/${companySlug}`;
  return new URL(`/${companySlug}`, window.location.origin).toString();
}

function buildExpiredReservationWhatsappUrl(payment: ReservationPaymentRow, companySlug: string) {
  if (payment.status !== 'expired') return null;

  const whatsappNumber = toBrazilWhatsAppNumber(payment.customer_phone);
  if (whatsappNumber.length < 12) return null;

  const dateLabel = payment.reservation_date
    ? `o dia ${formatShortDate(payment.reservation_date)}`
    : 'a data escolhida';
  const timeLabel = payment.reservation_time ? ` às ${payment.reservation_time}` : '';
  const reservationUrl = buildCompanyPublicReservationUrl(companySlug);
  const message =
    `Olá, sua reserva para ${dateLabel}${timeLabel} expirou. ` +
    `Mas não perca tempo: os horários estão se esgotando. ` +
    `Faça uma nova reserva pelo link: ${reservationUrl}`;

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
}

function getAsaasStatusLabel(status: string) {
  if (status === 'configured') return 'Configurado';
  if (status === 'error') return 'Erro';
  return 'Não configurado';
}

function getRuleBillingTypes(rule: Pick<ReservationPaymentRuleDraft, 'pix_enabled' | 'credit_card_enabled'>) {
  return [
    rule.pix_enabled ? 'PIX' : null,
    rule.credit_card_enabled ? 'CREDIT_CARD' : null,
  ].filter(Boolean) as ReservationPrepaymentBillingType[];
}

function mapReservationPaymentRule(row: any, usageCount = 0): ReservationPaymentRuleDraft {
  const rule = {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    date_start: row.date_start,
    date_end: row.date_end,
    amount_type: row.amount_type,
    amount: Number(row.base_amount || 0),
    pix_enabled: Boolean(row.pix_enabled),
    pix_amount: row.pix_amount === null || row.pix_amount === undefined ? null : Number(row.pix_amount),
    credit_card_enabled: Boolean(row.credit_card_enabled),
    credit_card_amount: row.credit_card_amount === null || row.credit_card_amount === undefined ? null : Number(row.credit_card_amount),
    max_credit_card_installments: row.max_credit_card_installments === null || row.max_credit_card_installments === undefined
      ? null
      : Number(row.max_credit_card_installments),
    payment_deadline_minutes: Number(row.payment_deadline_minutes || 10),
    customer_notice: row.customer_notice ?? '',
    cancellation_policy: row.cancellation_policy ?? '',
    usage_count: usageCount,
    created_by: row.created_by ?? null,
    activated_at: row.activated_at ?? null,
    archived_at: row.archived_at ?? null,
    archived_by: row.archived_by ?? null,
    archived_reason: row.archived_reason ?? null,
  } satisfies Omit<ReservationPaymentRuleDraft, 'billing_types'>;

  return {
    ...rule,
    billing_types: getRuleBillingTypes(rule),
  };
}

export default function CompanyPrepayments() {
  const { companyId, slug } = useCompanySlug();
  const queryClient = useQueryClient();
  const { data: featureFlags, isLoading: featureFlagsLoading } = useCompanyFeatureFlags(companyId);
  const [asaasConfig, setAsaasConfig] = useState(DEFAULT_ASAAS_CONFIG_PREVIEW);
  const [tokenDraft, setTokenDraft] = useState('');
  const [savedWebhookUrl, setSavedWebhookUrl] = useState<string | null>(null);
  const [webhookAuthToken, setWebhookAuthToken] = useState<string | null>(null);
  const [isEditingAsaasConfig, setIsEditingAsaasConfig] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(() => createRuleForm());
  const [ruleTab, setRuleTab] = useState<RuleTab>('active');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatusFilter>('all');
  const [paymentPeriodPreset, setPaymentPeriodPreset] = useState<SummaryPeriodPreset>('last_7_days');
  const [paymentRange, setPaymentRange] = useState<DateRange>(() => getSummaryPresetRange('last_7_days'));
  const [paymentSearchTerm, setPaymentSearchTerm] = useState('');
  const [paymentPage, setPaymentPage] = useState(1);
  const [pendingRuleAction, setPendingRuleAction] = useState<PendingRuleAction | null>(null);
  const [pendingRefundPayment, setPendingRefundPayment] = useState<ReservationPaymentRow | null>(null);
  const [bulkCheckModalOpen, setBulkCheckModalOpen] = useState(false);
  const [bulkCheckProgress, setBulkCheckProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkCheckResults, setBulkCheckResults] = useState<BulkCheckResult[]>([]);
  const [summaryPeriodPreset, setSummaryPeriodPreset] = useState<SummaryPeriodPreset>('last_7_days');
  const [summaryRange, setSummaryRange] = useState<DateRange>(() => getSummaryPresetRange('last_7_days'));

  const prepaymentEnabled = featureFlags?.features.reservation_prepayment ?? false;
  const asaasConfigQuery = useQuery({
    queryKey: ['asaas-config', companyId],
    queryFn: () => {
      if (!companyId) throw new Error('Empresa não identificada.');
      return getAsaasConfig(companyId);
    },
    enabled: Boolean(companyId),
  });
  const asaasConfigMutation = useMutation({
    mutationFn: ({ apiToken, mode }: { apiToken?: string; mode: 'save' | 'test' }) => {
      if (!companyId) throw new Error('Empresa não identificada.');
      return mode === 'test'
        ? testAsaasConfig(companyId, apiToken)
        : saveAsaasConfig(companyId, apiToken ?? '');
    },
    onSuccess: (result) => {
      setAsaasConfig({
        status: result.status,
        fromCompanyAccount: true,
        lastValidatedAt: result.last_validated_at,
        lastError: result.last_error,
      });
      setSavedWebhookUrl(result.webhook_url);
      setWebhookAuthToken(result.webhook_auth_token);

      if (result.status === 'configured') {
        toast.success('Token Asaas salvo e validado.');
      } else {
        toast.warning(result.last_error || 'Token salvo, mas a validação retornou erro.');
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar a configuração Asaas.');
    },
  });

  const rulesQuery = useQuery({
    queryKey: ['reservation-payment-rules', companyId],
    queryFn: async () => {
      if (!companyId) throw new Error('Empresa não identificada.');

      const { data, error } = await supabase
        .from('reservation_payment_rules' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as any[];
      const ruleIds = rows.map((row) => row.id).filter(Boolean);
      const usageCounts = new Map<string, number>();

      if (ruleIds.length > 0) {
        const { data: payments, error: paymentsError } = await supabase
          .from('reservation_payments' as any)
          .select('rule_id')
          .in('rule_id', ruleIds);

        if (paymentsError) throw paymentsError;

        ((payments ?? []) as any[]).forEach((payment) => {
          if (!payment.rule_id) return;
          usageCounts.set(payment.rule_id, (usageCounts.get(payment.rule_id) ?? 0) + 1);
        });
      }

      return rows.map((row) => mapReservationPaymentRule(row, usageCounts.get(row.id) ?? 0));
    },
    enabled: Boolean(companyId),
  });
  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);

  const invalidateRules = () => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: ['reservation-payment-rules', companyId] });
  };

  const createRuleMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const { error } = await supabase
        .from('reservation_payment_rules' as any)
        .insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateRules();
      setRuleForm(createRuleForm());
      setRuleTab('inactive');
      toast.success('Regra adicionada em Desativadas.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível salvar a regra.');
    },
  });

  const toggleRuleMutation = useMutation({
    mutationFn: async ({ rule, enabled }: { rule: ReservationPaymentRuleDraft; enabled: boolean }) => {
      const { error } = await supabase
        .from('reservation_payment_rules' as any)
        .update({
          enabled,
          activated_at: enabled ? new Date().toISOString() : rule.activated_at,
        })
        .eq('id', rule.id);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidateRules();
      setRuleTab(variables.enabled ? 'active' : 'inactive');
      toast.success(variables.enabled ? 'Regra ativada.' : 'Regra desativada.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível atualizar a regra.');
    },
  });

  const removeRuleMutation = useMutation({
    mutationFn: async ({ rule, archive }: { rule: ReservationPaymentRuleDraft; archive: boolean }) => {
      if (archive) {
        const { error } = await supabase
          .from('reservation_payment_rules' as any)
          .update({
            enabled: false,
            archived_at: new Date().toISOString(),
            archived_reason: 'Arquivada pelo painel',
          })
          .eq('id', rule.id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from('reservation_payment_rules' as any)
        .delete()
        .eq('id', rule.id);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      invalidateRules();
      setPendingRuleAction(null);
      if (variables.archive) {
        setRuleTab('archived');
        toast.success('Regra arquivada.');
      } else {
        toast.success('Regra excluida.');
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível remover a regra.');
    },
  });

  useEffect(() => {
    if (!asaasConfigQuery.data) return;

    const result = asaasConfigQuery.data;
    setAsaasConfig({
      status: result.status,
      fromCompanyAccount: true,
      lastValidatedAt: result.last_validated_at,
      lastError: result.last_error,
    });
    setSavedWebhookUrl(result.webhook_url);
    setWebhookAuthToken(result.webhook_auth_token);
  }, [asaasConfigQuery.data]);

  useEffect(() => {
    setRuleForm((current) => {
      const customer_notice = LEGACY_CUSTOMER_NOTICES.has(current.customer_notice)
        ? DEFAULT_CUSTOMER_NOTICE
        : current.customer_notice;
      const cancellation_policy = LEGACY_CANCELLATION_POLICIES.has(current.cancellation_policy)
        ? DEFAULT_CANCELLATION_POLICY
        : current.cancellation_policy;

      if (customer_notice === current.customer_notice && cancellation_policy === current.cancellation_policy) {
        return current;
      }

      return {
        ...current,
        customer_notice,
        cancellation_policy,
      };
    });
  }, []);

  const activeRules = useMemo(() => rules.filter((rule) => rule.enabled && !rule.archived_at), [rules]);
  const inactiveRules = useMemo(() => rules.filter((rule) => !rule.enabled && !rule.archived_at), [rules]);
  const archivedRules = useMemo(() => rules.filter((rule) => Boolean(rule.archived_at)), [rules]);
  const summaryQueryKey = useMemo(
    () => [
      'reservation-payments-summary',
      companyId,
      summaryRange?.from ? toDateKey(summaryRange.from) : null,
      summaryRange?.to ? toDateKey(summaryRange.to) : (summaryRange?.from ? toDateKey(summaryRange.from) : null),
    ] as const,
    [companyId, summaryRange],
  );

  const summaryPaymentsQuery = useQuery({
    queryKey: summaryQueryKey,
    enabled: Boolean(companyId && summaryRange?.from),
    refetchInterval: PAYMENT_AUTO_REFRESH_INTERVAL_MS,
    queryFn: async () => {
      const from = summaryRange!.from!;
      const to = summaryRange?.to ?? from;
      const startIso = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0).toISOString();
      const endIso = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).toISOString();
      const rangeFilter = [
        `and(created_at.gte.${startIso},created_at.lte.${endIso})`,
        `and(paid_at.gte.${startIso},paid_at.lte.${endIso})`,
        `and(cancelled_at.gte.${startIso},cancelled_at.lte.${endIso})`,
        `and(expires_at.gte.${startIso},expires_at.lte.${endIso})`,
      ].join(',');

      const { data, error } = await (supabase as any)
        .from('reservation_payments')
        .select(
          'id, status, billing_type, max_installments, base_amount, charged_amount, rule_snapshot, payment_token, expires_at, paid_at, cancelled_at, metadata, created_at, reservation:reservations!reservation_payments_reservation_id_fkey(id, guest_name, guest_phone, status, date, time, party_size)'
        )
        .eq('company_id', companyId)
        .or(rangeFilter)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return ((data ?? []) as any[]).map(mapPaymentRowFromDb);
    },
  });
  const summaryPayments = useMemo(() => summaryPaymentsQuery.data ?? [], [summaryPaymentsQuery.data]);

  const filteredFinancialDaily = useMemo<FinancialDailyPoint[]>(() => {
    const from = summaryRange?.from;
    const to = summaryRange?.to ?? from;
    if (!from || !to) return [];
    return buildDailyFinancialBuckets(summaryPayments, from, to);
  }, [summaryPayments, summaryRange]);
  const chartTotals = useMemo(
    () => filteredFinancialDaily.reduce(
      (acc, item) => ({
        paid: acc.paid + item.paid,
        expired: acc.expired + item.expired,
        pending: acc.pending + item.pending,
        refunded: acc.refunded + item.refunded,
        chargeback: acc.chargeback + item.chargeback,
        refundPending: acc.refundPending + item.refundPending,
        paidCount: acc.paidCount + item.paidCount,
        expiredCount: acc.expiredCount + item.expiredCount,
        pendingCount: acc.pendingCount + item.pendingCount,
        refundedCount: acc.refundedCount + item.refundedCount,
        chargebackCount: acc.chargebackCount + item.chargebackCount,
        refundPendingCount: acc.refundPendingCount + item.refundPendingCount,
      }),
      {
        paid: 0,
        expired: 0,
        pending: 0,
        refunded: 0,
        chargeback: 0,
        refundPending: 0,
        paidCount: 0,
        expiredCount: 0,
        pendingCount: 0,
        refundedCount: 0,
        chargebackCount: 0,
        refundPendingCount: 0,
      },
    ),
    [filteredFinancialDaily],
  );
  // "Pagos" no resumo é o BRUTO recebido: todo pagamento que chegou a ser capturado,
  // inclusive os que depois foram estornados ou sofreram chargeback. Esses ficam em
  // buckets próprios (para o gráfico empilhado não dobrar valores), então o bruto é a
  // soma dos três. Estornos parciais já entram com a parte retida em `paid` e a parte
  // devolvida em `refunded`, somando o valor cheio aqui.
  const grossPaid = chartTotals.paid + chartTotals.refunded + chartTotals.chargeback;
  const grossPaidCount = chartTotals.paidCount + chartTotals.refundedCount + chartTotals.chargebackCount;
  // Líquido = bruto menos estornos e chargebacks, descontados uma única vez.
  const netRevenue = grossPaid - chartTotals.refunded - chartTotals.chargeback;

  const paymentsListQueryKey = useMemo(
    () => [
      'reservation-payments-list',
      companyId,
      paymentRange?.from ? toDateKey(paymentRange.from) : null,
      paymentRange?.to ? toDateKey(paymentRange.to) : (paymentRange?.from ? toDateKey(paymentRange.from) : null),
      paymentStatusFilter,
    ] as const,
    [companyId, paymentRange, paymentStatusFilter],
  );

  const paymentsListQuery = useQuery({
    queryKey: paymentsListQueryKey,
    enabled: Boolean(companyId && paymentRange?.from),
    refetchInterval: PAYMENT_AUTO_REFRESH_INTERVAL_MS,
    queryFn: async () => {
      const from = paymentRange!.from!;
      const to = paymentRange?.to ?? from;
      const startIso = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0).toISOString();
      const endIso = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).toISOString();
      const rangeFilter = [
        `and(created_at.gte.${startIso},created_at.lte.${endIso})`,
        `and(paid_at.gte.${startIso},paid_at.lte.${endIso})`,
        `and(cancelled_at.gte.${startIso},cancelled_at.lte.${endIso})`,
        `and(expires_at.gte.${startIso},expires_at.lte.${endIso})`,
      ].join(',');

      let query = (supabase as any)
        .from('reservation_payments')
        .select(
          'id, status, billing_type, max_installments, base_amount, charged_amount, rule_snapshot, payment_token, expires_at, paid_at, cancelled_at, metadata, created_at, reservation:reservations!reservation_payments_reservation_id_fkey(id, guest_name, guest_phone, status, date, time, party_size)'
        )
        .eq('company_id', companyId)
        .or(rangeFilter)
        .order('created_at', { ascending: false });

      if (paymentStatusFilter === 'pending') {
        query = query.in('status', ['pending', 'awaiting_method']);
      } else if (paymentStatusFilter !== 'all') {
        query = query.eq('status', paymentStatusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return ((data ?? []) as any[])
        .map(mapPaymentRowFromDb)
        .sort((a, b) => new Date(getFinancialEventDate(b)).getTime() - new Date(getFinancialEventDate(a)).getTime());
    },
  });
  const payments = useMemo(() => paymentsListQuery.data ?? [], [paymentsListQuery.data]);
  const normalizedPaymentSearch = useMemo(() => normalizeSearchValue(paymentSearchTerm), [paymentSearchTerm]);
  const filteredPayments = useMemo(
    () => {
      if (!normalizedPaymentSearch) return payments;
      return payments.filter((payment) =>
        normalizeSearchValue(payment.customer_name).includes(normalizedPaymentSearch),
      );
    },
    [normalizedPaymentSearch, payments],
  );
  const cancelledReceivedPayments = useMemo(
    () => filteredPayments.filter((payment) =>
      isReceivedPaymentStatus(payment.status) && isReservationCancelledStatus(payment.reservation_status),
    ),
    [filteredPayments],
  );
  const latePaidPayments = useMemo(
    () => filteredPayments.filter(isLatePaidPayment),
    [filteredPayments],
  );
  const filteredCheckablePayments = useMemo(
    () => filteredPayments.filter((payment) => Boolean(payment.payment_token)),
    [filteredPayments],
  );
  const paymentPageCount = Math.max(1, Math.ceil(filteredPayments.length / PAYMENT_PAGE_SIZE));
  const currentPaymentPage = Math.min(paymentPage, paymentPageCount);
  const paginatedPayments = useMemo(
    () => filteredPayments.slice(
      (currentPaymentPage - 1) * PAYMENT_PAGE_SIZE,
      currentPaymentPage * PAYMENT_PAGE_SIZE,
    ),
    [currentPaymentPage, filteredPayments],
  );

  const refreshPaymentsData = () => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: ['reservation-payments-list', companyId] });
    queryClient.invalidateQueries({ queryKey: ['reservation-payments-summary', companyId] });
  };

  const checkPaymentMutation = useMutation({
    mutationFn: async (paymentToken: string) => checkReservationPayment(paymentToken),
    onSuccess: (data) => {
      refreshPaymentsData();
      if (data.status === 'paid') {
        toast.success('Pagamento confirmado.');
        return;
      }
      if (data.status === 'expired') {
        toast.info('Esse pagamento já está expirado.');
        return;
      }
      if (data.status === 'refunded') {
        toast.warning('Pagamento estornado no Asaas.');
        return;
      }
      if (data.status === 'partial_refunded') {
        toast.warning('Pagamento parcialmente estornado no Asaas.');
        return;
      }
      if (data.status === 'refund_pending') {
        toast.warning('Estorno em processamento no Asaas.');
        return;
      }
      if (data.status === 'refund_denied') {
        toast.error('Estorno negado no Asaas.');
        return;
      }
      if (data.status === 'chargeback') {
        toast.warning('Pagamento com chargeback no Asaas.');
        return;
      }
      if (data.status === 'cancelled') {
        toast.warning('Pagamento cancelado no Asaas.');
        return;
      }
      if (data.message) {
        toast.info(data.message);
        return;
      }
      toast.info('Status atualizado.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível consultar o pagamento.');
    },
  });
  const bulkCheckPaymentsMutation = useMutation({
    mutationFn: async (selectedPayments: ReservationPaymentRow[]) => {
      const uniquePayments = Array.from(
        selectedPayments
          .filter((payment): payment is ReservationPaymentRow & { payment_token: string } => Boolean(payment.payment_token))
          .reduce((map, payment) => map.set(payment.payment_token, payment), new Map<string, ReservationPaymentRow & { payment_token: string }>())
          .values(),
      );

      if (uniquePayments.length === 0) {
        throw new Error('Nenhum pagamento com token para consultar.');
      }

      let failed = 0;
      let changed = 0;
      setBulkCheckResults([]);
      setBulkCheckProgress({ done: 0, total: uniquePayments.length });

      for (const [index, payment] of uniquePayments.entries()) {
        try {
          const data = await checkReservationPayment(payment.payment_token);
          const currentStatus = data.status;
          const statusChanged = payment.status !== currentStatus;
          if (statusChanged) changed += 1;

          setBulkCheckResults((current) => [
            ...current,
            {
              paymentId: payment.id,
              paymentToken: payment.payment_token,
              customerName: payment.customer_name,
              previousStatus: payment.status,
              currentStatus,
              changed: statusChanged,
              message: data.message ?? null,
              error: null,
            },
          ]);
        } catch (error) {
          failed += 1;
          console.warn('Bulk reservation payment check failed', payment.payment_token, error);
          setBulkCheckResults((current) => [
            ...current,
            {
              paymentId: payment.id,
              paymentToken: payment.payment_token,
              customerName: payment.customer_name,
              previousStatus: payment.status,
              currentStatus: null,
              changed: false,
              message: null,
              error: error instanceof Error ? error.message : 'Falha ao consultar pagamento.',
            },
          ]);
        } finally {
          setBulkCheckProgress({ done: index + 1, total: uniquePayments.length });
        }
      }

      return { checked: uniquePayments.length, failed, changed };
    },
    onSuccess: ({ checked, failed, changed }) => {
      refreshPaymentsData();
      if (failed > 0) {
        toast.warning(`${checked - failed} pagamentos atualizados. ${failed} falharam.`);
        return;
      }
      toast.success(changed > 0
        ? `${checked} pagamentos consultados. ${changed} mudaram de status.`
        : `${checked} pagamentos consultados sem mudança de status.`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível consultar os pagamentos.');
    },
  });
  const refundPaymentMutation = useMutation({
    mutationFn: async (payment: ReservationPaymentRow) => {
      if (!companyId) throw new Error('Empresa não identificada.');
      if (!payment.payment_token) throw new Error('Pagamento sem token.');
      return refundReservationPayment(companyId, payment.payment_token, {
        description: `Estorno solicitado no painel para ${payment.customer_name}`,
      });
    },
    onSuccess: (data) => {
      setPendingRefundPayment(null);
      refreshPaymentsData();
      if (data.status === 'refunded') {
        toast.success('Pagamento estornado no Asaas.');
        return;
      }
      toast.success('Estorno solicitado no Asaas.');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Não foi possível solicitar o estorno.');
    },
  });
  const bulkCheckDone = bulkCheckProgress?.done ?? bulkCheckResults.length;
  const bulkCheckTotal = bulkCheckProgress?.total ?? bulkCheckResults.length;
  const bulkCheckProgressValue = bulkCheckTotal > 0 ? Math.round((bulkCheckDone / bulkCheckTotal) * 100) : 0;
  const bulkCheckChangedResults = bulkCheckResults.filter((result) => result.changed);
  const bulkCheckFailedResults = bulkCheckResults.filter((result) => Boolean(result.error));
  const bulkCheckUnchangedCount = bulkCheckResults.length - bulkCheckChangedResults.length - bulkCheckFailedResults.length;
  const summaryPeriodLabel = formatDateRangePickerLabel(summaryRange);
  const paymentPeriodLabel = formatDateRangePickerLabel(paymentRange);
  const pendingRule = pendingRuleAction ? rules.find((rule) => rule.id === pendingRuleAction.ruleId) : null;
  const ruleActionIsArchive = Boolean(pendingRule && pendingRule.usage_count > 0);
  const fallbackWebhookUrl = companyId
    ? `${SUPABASE_FUNCTIONS_BASE_URL}/functions/v1/asaas-webhook?company_id=${encodeURIComponent(companyId)}`
    : `${SUPABASE_FUNCTIONS_BASE_URL}/functions/v1/asaas-webhook?company_id=<empresa>`;
  const webhookUrl = savedWebhookUrl ?? fallbackWebhookUrl;
  const hasSavedAsaasToken = asaasConfig.status !== 'not_configured' && Boolean(webhookAuthToken || asaasConfig.lastValidatedAt);
  const asaasStatusLabel = asaasConfigQuery.isLoading ? 'Carregando...' : getAsaasStatusLabel(asaasConfig.status);

  const handleSummaryPresetChange = (preset: SummaryPeriodPreset) => {
    setSummaryPeriodPreset(preset);
    if (preset !== 'custom') {
      setSummaryRange(getSummaryPresetRange(preset));
    }
  };

  useEffect(() => {
    setPaymentPage((current) => Math.min(current, paymentPageCount));
  }, [paymentPageCount]);

  const handlePaymentPresetChange = (preset: SummaryPeriodPreset) => {
    setPaymentPeriodPreset(preset);
    setPaymentPage(1);
    if (preset !== 'custom') {
      setPaymentRange(getSummaryPresetRange(preset));
    }
  };

  const handlePaymentRangeChange = (range: DateRange | undefined) => {
    setPaymentRange(range ?? getSummaryPresetRange('last_7_days'));
    setPaymentPage(1);
  };

  const handlePaymentStatusFilterChange = (filter: PaymentStatusFilter) => {
    setPaymentStatusFilter(filter);
    setPaymentPage(1);
  };

  const handlePaymentSearchChange = (value: string) => {
    setPaymentSearchTerm(value);
    setPaymentPage(1);
  };

  const handleCopyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success('URL do webhook copiada.');
    } catch {
      toast.error('Não foi possível copiar a URL.');
    }
  };

  const handleCopyWebhookToken = async () => {
    if (!webhookAuthToken) {
      toast.error('Salve o token Asaas para gerar o token do webhook.');
      return;
    }

    try {
      await navigator.clipboard.writeText(webhookAuthToken);
      toast.success('Token do webhook copiado.');
    } catch {
      toast.error('Não foi possível copiar o token do webhook.');
    }
  };

  const submitAsaasConfig = (mode: 'save' | 'test', clearTokenAfterSave: boolean) => {
    const apiToken = tokenDraft.trim();
    if (mode === 'save' && !apiToken) {
      toast.error('Informe um token Asaas.');
      return;
    }
    if (mode === 'test' && !apiToken && !hasSavedAsaasToken) {
      toast.error('Salve um token Asaas antes de testar a conexão.');
      return;
    }

    asaasConfigMutation.mutate({ apiToken: apiToken || undefined, mode }, {
      onSuccess: (data) => {
        if (clearTokenAfterSave) setTokenDraft('');
        if (mode === 'save' && data.status === 'configured') {
          setIsEditingAsaasConfig(false);
        }
      },
    });
  };

  const handleConfigTest = () => {
    submitAsaasConfig('test', false);
  };

  const handleConfigSave = () => {
    submitAsaasConfig('save', true);
  };

  const handleRuleSave = () => {
    const name = ruleForm.name.trim();
    const amount = parseCurrencyInput(ruleForm.amount);
    const pixAmount = parseCurrencyInput(ruleForm.pix_amount);
    const creditCardAmount = parseCurrencyInput(ruleForm.credit_card_amount);
    const maxCreditCardInstallments = Number.parseInt(ruleForm.max_credit_card_installments, 10);
    const deadline = Number.parseInt(ruleForm.payment_deadline_minutes, 10);

    if (!companyId) {
      toast.error('Empresa não identificada.');
      return;
    }
    if (!name) {
      toast.error('Informe o nome da regra.');
      return;
    }
    if (!ruleForm.date_start || !ruleForm.date_end || ruleForm.date_start > ruleForm.date_end) {
      toast.error('Informe um período válido.');
      return;
    }
    if (amount <= 0) {
      toast.error('Informe um valor de sinal maior que zero.');
      return;
    }
    if (!ruleForm.pix_enabled && !ruleForm.credit_card_enabled) {
      toast.error('Selecione pelo menos uma forma de pagamento.');
      return;
    }
    if (ruleForm.pix_enabled && pixAmount <= 0) {
      toast.error('Informe um valor de Pix maior que zero.');
      return;
    }
    if (ruleForm.credit_card_enabled && creditCardAmount <= 0) {
      toast.error('Informe um valor de cartão maior que zero.');
      return;
    }
    if (ruleForm.credit_card_enabled && (!Number.isFinite(maxCreditCardInstallments) || maxCreditCardInstallments < 1)) {
      toast.error('Informe o máximo de parcelas do cartão.');
      return;
    }
    if (!Number.isFinite(deadline) || deadline < 1) {
      toast.error('Informe um prazo de pagamento válido.');
      return;
    }

    createRuleMutation.mutate({
      company_id: companyId,
      name,
      enabled: false,
      date_start: ruleForm.date_start,
      date_end: ruleForm.date_end,
      amount_type: ruleForm.amount_type,
      base_amount: amount,
      pix_enabled: ruleForm.pix_enabled,
      pix_amount: ruleForm.pix_enabled ? pixAmount : null,
      credit_card_enabled: ruleForm.credit_card_enabled,
      credit_card_amount: ruleForm.credit_card_enabled ? creditCardAmount : null,
      max_credit_card_installments: ruleForm.credit_card_enabled ? maxCreditCardInstallments : null,
      payment_deadline_minutes: deadline,
      customer_notice: ruleForm.customer_notice.trim(),
      cancellation_policy: ruleForm.cancellation_policy.trim(),
    });
  };

  const toggleRule = (ruleId: string, enabled: boolean) => {
    const selectedRule = rules.find((rule) => rule.id === ruleId);
    if (!selectedRule) return;
    if (selectedRule.archived_at) {
      toast.error('Regra arquivada não pode ser ativada.');
      return;
    }

    if (enabled) {
      const conflict = findActiveRuleConflict(selectedRule, rules);
      if (conflict) {
        toast.error(`A regra "${conflict.name}" já está ativa nesse período.`);
        return;
      }
    }

    toggleRuleMutation.mutate({ rule: selectedRule, enabled });
  };

  const removeOrArchiveRule = (ruleId: string) => {
    const selectedRule = rules.find((rule) => rule.id === ruleId);
    if (!selectedRule) return;

    setPendingRuleAction({ ruleId });
  };

  const confirmRuleRemoval = () => {
    if (!pendingRule) return;

    removeRuleMutation.mutate({
      rule: pendingRule,
      archive: pendingRule.usage_count > 0,
    });
  };

  const cloneRule = (ruleId: string) => {
    const selectedRule = rules.find((rule) => rule.id === ruleId);
    if (!selectedRule) return;

    setRuleForm({
      name: `${selectedRule.name} cópia`,
      date_start: selectedRule.date_start,
      date_end: selectedRule.date_end,
      amount_type: selectedRule.amount_type,
      amount: selectedRule.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
      pix_enabled: selectedRule.pix_enabled,
      pix_amount: selectedRule.pix_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
      credit_card_enabled: selectedRule.credit_card_enabled,
      credit_card_amount: selectedRule.credit_card_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
      max_credit_card_installments: selectedRule.max_credit_card_installments ? String(selectedRule.max_credit_card_installments) : '',
      payment_deadline_minutes: String(selectedRule.payment_deadline_minutes),
      customer_notice: selectedRule.customer_notice,
      cancellation_policy: selectedRule.cancellation_policy,
    });
    setRuleTab('new');
    toast.success('Regra copiada para nova regra.');
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Pagamentos Antecipados</h1>
          <Badge variant={prepaymentEnabled ? 'default' : 'secondary'}>
            {prepaymentEnabled ? 'Funcionalidade ativa' : 'Funcionalidade desativada'}
          </Badge>
          <Badge variant="outline">Pix + cartão</Badge>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Configure sinais para datas especiais com Pix e cartão. O valor do sinal continua sendo abatido da conta no dia da visita.
        </p>
      </div>

      {!prepaymentEnabled && !featureFlagsLoading && (
        <Alert className="border-warning/30 bg-warning-soft/50">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>Módulo ainda não ativo para esta empresa</AlertTitle>
          <AlertDescription>
            Novas reservas continuam no fluxo atual até a funcionalidade ser habilitada e o backend real entrar em operação.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="config" className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:w-[760px]">
          <TabsTrigger value="config" className="min-h-9 px-2 text-xs sm:text-sm">Configurações</TabsTrigger>
          <TabsTrigger value="rules" className="min-h-9 px-2 text-xs sm:text-sm">Regras</TabsTrigger>
          <TabsTrigger value="payments" className="min-h-9 px-2 text-xs sm:text-sm">Pagamentos</TabsTrigger>
          <TabsTrigger value="summary" className="min-h-9 px-2 text-xs sm:text-sm">Resumo financeiro</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-4">
          <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <Card className="border-border shadow-card">
              <CardHeader>
                <CardTitle>Conta Asaas da empresa</CardTitle>
                <CardDescription>
                  Cada empresa usa o próprio token para gerar links de pagamento Pix e cartão na conta real da empresa.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasSavedAsaasToken && asaasConfig.status === 'configured' && !isEditingAsaasConfig ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-lg border border-success/20 bg-success/5 p-4">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">Conta Asaas configurada</p>
                        <p className="text-xs text-muted-foreground">
                          Integração ativa. Última validação: {formatDateTime(asaasConfig.lastValidatedAt)}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => setIsEditingAsaasConfig(true)}
                    >
                      <KeyRound className="mr-2 h-4 w-4" />
                      Editar configuração
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="asaas-token">Token Asaas</Label>
                        {hasSavedAsaasToken && (
                          <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                            Token salvo
                          </Badge>
                        )}
                      </div>
                      <Input
                        id="asaas-token"
                        type="password"
                        value={tokenDraft}
                        onChange={(event) => setTokenDraft(event.target.value)}
                        placeholder={hasSavedAsaasToken ? 'Token configurado. Cole um novo token para substituir.' : '$aact_YTU5...'}
                      />
                      <p className="text-xs text-muted-foreground">
                        {hasSavedAsaasToken
                          ? 'Por segurança, o token salvo não é exibido. Use este campo apenas para substituir.'
                          : 'Depois de salvo, o token não deve ser exibido novamente.'}
                      </p>
                    </div>

                    <div className="rounded-lg border border-border bg-background p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs text-muted-foreground">Status da integração</p>
                          <p className="mt-1 text-sm font-medium text-foreground">{asaasStatusLabel}</p>
                        </div>
                        <Badge variant={asaasConfig.status === 'configured' ? 'default' : 'secondary'}>
                          Conta real
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Última validação: {formatDateTime(asaasConfig.lastValidatedAt)}
                      </p>
                      {asaasConfig.lastError && (
                        <p className="mt-1 text-xs text-destructive">{asaasConfig.lastError}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label>URL do webhook</Label>
                      <div className="flex gap-2">
                        <Input value={webhookUrl} readOnly className="font-mono text-xs" />
                        <Button type="button" variant="outline" size="icon" onClick={handleCopyWebhookUrl} aria-label="Copiar URL do webhook">
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Cadastre esta URL no painel Asaas em Integrações → Webhooks.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Token do webhook</Label>
                      <div className="flex gap-2">
                        <Input value={webhookAuthToken ?? 'Salve o token Asaas para gerar'} readOnly className="font-mono text-xs" />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={handleCopyWebhookToken}
                          disabled={!webhookAuthToken}
                          aria-label="Copiar token do webhook"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Configure este token no header <code>asaas-access-token</code> do webhook no painel Asaas.
                      </p>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button onClick={handleConfigSave} disabled={asaasConfigMutation.isPending}>
                        {asaasConfigMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                        {hasSavedAsaasToken ? 'Atualizar token' : 'Salvar token'}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleConfigTest}
                        disabled={asaasConfigMutation.isPending || (!tokenDraft.trim() && !hasSavedAsaasToken)}
                      >
                        {asaasConfigMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                        Testar conexão
                      </Button>
                    </div>

                    {hasSavedAsaasToken && asaasConfig.status === 'configured' && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full"
                        onClick={() => {
                          setIsEditingAsaasConfig(false);
                          setTokenDraft('');
                        }}
                      >
                        Voltar para visão simplificada
                      </Button>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-card">
              <CardHeader>
                <CardTitle>Como configurar no Asaas</CardTitle>
                <CardDescription>
                  Siga este passo a passo na conta Asaas da empresa para liberar os pagamentos.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <TutorialStep
                  number={1}
                  title="Crie ou acesse a conta Asaas da empresa"
                  description="Use a conta Asaas (sandbox para testes ou produção) que receberá os pagamentos. Cada empresa precisa ter o próprio token."
                />
                <TutorialStep
                  number={2}
                  title="Gere o token de integração"
                  description="No painel Asaas, abra Minha Conta → Integrações → API e gere um token. Copie o token gerado."
                />
                <TutorialStep
                  number={3}
                  title="Salve o token aqui"
                  description="Cole o token no campo Token Asaas ao lado e clique em Salvar token. Vamos validar a conexão e gerar a URL e o token do webhook."
                />
                <TutorialStep
                  number={4}
                  title="Cadastre o site no Asaas (cartão)"
                  description="Em Minha Conta → Informações, cadastre o domínio público da reserva (https://plugguest.com.br). É exigência da Asaas para liberar cobrança por cartão."
                />
                <TutorialStep
                  number={5}
                  title="Configure o webhook no painel Asaas"
                  description="Em Integrações → Webhooks, adicione a URL e o token mostrados ao lado. Marque pelo menos os eventos PAYMENT_RECEIVED, PAYMENT_CONFIRMED e PAYMENT_RECEIVED_IN_CASH."
                />
                <TutorialStep
                  number={6}
                  title="Crie sua primeira regra"
                  description="Vá para a aba Regras e crie uma regra de pagamento antecipado para a data ou evento desejado. A regra entra desativada para revisão antes de afetar o fluxo público."
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <Alert className="border-warning/30 bg-warning-soft/40">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle>Regras não são retroativas</AlertTitle>
            <AlertDescription>
              Ao ativar uma regra para um período que já possui reservas, apenas novas reservas criadas depois da ativação passam a exigir pagamento.
            </AlertDescription>
          </Alert>

          <Tabs value={ruleTab} onValueChange={(value) => setRuleTab(value as RuleTab)} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:w-[680px]">
              <TabsTrigger value="active" className="min-h-9 px-2 text-xs sm:text-sm">Ativas</TabsTrigger>
              <TabsTrigger value="inactive" className="min-h-9 px-2 text-xs sm:text-sm">Desativadas</TabsTrigger>
              <TabsTrigger value="archived" className="min-h-9 px-2 text-xs sm:text-sm">Arquivadas</TabsTrigger>
              <TabsTrigger value="new" className="min-h-9 px-2 text-xs sm:text-sm">Nova regra</TabsTrigger>
            </TabsList>

            <TabsContent value="active">
              <RulesCard
                title="Regras ativas"
                description="Somente uma regra ativa pode ocupar cada dia."
                emptyTitle="Nenhuma regra ativa"
                emptyDescription="Ative uma regra desativada ou crie uma nova regra para datas especiais."
                rules={activeRules}
                onToggleRule={toggleRule}
                onRemoveOrArchiveRule={removeOrArchiveRule}
                onCloneRule={cloneRule}
              />
            </TabsContent>

            <TabsContent value="inactive">
              <RulesCard
                title="Regras desativadas"
                description="Regras novas entram aqui para revisão antes de afetar o fluxo público."
                emptyTitle="Nenhuma regra desativada"
                emptyDescription="Quando uma regra for adicionada ou pausada, ela aparece nesta lista."
                rules={inactiveRules}
                onToggleRule={toggleRule}
                onRemoveOrArchiveRule={removeOrArchiveRule}
                onCloneRule={cloneRule}
              />
            </TabsContent>

            <TabsContent value="archived">
              <RulesCard
                title="Regras arquivadas"
                description="Regras usadas ficam preservadas para histórico e não afetam novas reservas."
                emptyTitle="Nenhuma regra arquivada"
                emptyDescription="Quando uma regra usada for retirada, ela aparece aqui."
                rules={archivedRules}
                onToggleRule={toggleRule}
                onRemoveOrArchiveRule={removeOrArchiveRule}
                onCloneRule={cloneRule}
              />
            </TabsContent>

            <TabsContent value="new">
              <Card className="border-border shadow-card">
                <CardHeader>
                  <CardTitle>Nova regra</CardTitle>
                  <CardDescription>
                    A regra será adicionada desativada para revisão antes de entrar no fluxo público.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="rule-name">Nome da regra</Label>
                  <Input
                    id="rule-name"
                    value={ruleForm.name}
                    onChange={(event) => setRuleForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Dia dos Namorados"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="date-start">Início</Label>
                    <Input
                      id="date-start"
                      type="date"
                      value={ruleForm.date_start}
                      onChange={(event) => setRuleForm((current) => ({ ...current, date_start: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="date-end">Fim</Label>
                    <Input
                      id="date-end"
                      type="date"
                      value={ruleForm.date_end}
                      onChange={(event) => setRuleForm((current) => ({ ...current, date_end: event.target.value }))}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                  <div className="space-y-2">
                    <Label>Tipo de valor</Label>
                    <Select
                      value={ruleForm.amount_type}
                      onValueChange={(value) => setRuleForm((current) => ({ ...current, amount_type: value as ReservationPrepaymentAmountType }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="per_person">Por pessoa</SelectItem>
                        <SelectItem value="fixed_per_reservation">Por reserva</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="amount">Valor do sinal</Label>
                    <Input
                      id="amount"
                      inputMode="decimal"
                      value={ruleForm.amount}
                      onChange={(event) => setRuleForm((current) => ({ ...current, amount: event.target.value }))}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <Label>Pix</Label>
                          <p className="text-xs text-muted-foreground">Cria um link Pix no checkout do Asaas.</p>
                        </div>
                        <Switch
                          checked={ruleForm.pix_enabled}
                          onCheckedChange={(checked) => setRuleForm((current) => ({ ...current, pix_enabled: checked }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pix-amount">Valor no Pix</Label>
                        <Input
                          id="pix-amount"
                          inputMode="decimal"
                          value={ruleForm.pix_amount}
                          disabled={!ruleForm.pix_enabled}
                          onChange={(event) => setRuleForm((current) => ({ ...current, pix_amount: event.target.value }))}
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <Label>Cartão</Label>
                          <p className="text-xs text-muted-foreground">Redireciona o cliente para pagamento no Asaas.</p>
                        </div>
                        <Switch
                          checked={ruleForm.credit_card_enabled}
                          onCheckedChange={(checked) => setRuleForm((current) => ({ ...current, credit_card_enabled: checked }))}
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                        <div className="space-y-2">
                          <Label htmlFor="card-amount">Valor no cartão</Label>
                          <Input
                            id="card-amount"
                            inputMode="decimal"
                            value={ruleForm.credit_card_amount}
                            disabled={!ruleForm.credit_card_enabled}
                            onChange={(event) => setRuleForm((current) => ({ ...current, credit_card_amount: event.target.value }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="card-installments">Parcelas</Label>
                          <Input
                            id="card-installments"
                            inputMode="numeric"
                            value={ruleForm.max_credit_card_installments}
                            disabled={!ruleForm.credit_card_enabled}
                            onChange={(event) => setRuleForm((current) => ({ ...current, max_credit_card_installments: event.target.value }))}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="max-w-xs space-y-2">
                  <Label htmlFor="deadline">Prazo para pagamento (minutos)</Label>
                  <Input
                    id="deadline"
                    inputMode="numeric"
                    value={ruleForm.payment_deadline_minutes}
                    onChange={(event) => setRuleForm((current) => ({ ...current, payment_deadline_minutes: event.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Tempo em minutos que a mesa fica bloqueada aguardando o pagamento.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="customer-notice">Texto exibido ao cliente</Label>
                  <Textarea
                    id="customer-notice"
                    value={ruleForm.customer_notice}
                    onChange={(event) => setRuleForm((current) => ({ ...current, customer_notice: event.target.value }))}
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="cancel-policy">Política de expiração</Label>
                  <Textarea
                    id="cancel-policy"
                    value={ruleForm.cancellation_policy}
                    onChange={(event) => setRuleForm((current) => ({ ...current, cancellation_policy: event.target.value }))}
                    rows={3}
                  />
                </div>

                <Button className="w-full" onClick={handleRuleSave} disabled={createRuleMutation.isPending}>
                  {createRuleMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  {createRuleMutation.isPending ? 'Salvando regra...' : 'Adicionar regra'}
                </Button>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="payments" className="space-y-4">
          <Card className="border-border shadow-card">
            <CardHeader className="gap-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>Pagamentos de reservas</CardTitle>
                  <CardDescription>
                    Atualiza automaticamente a cada 30 segundos. O período considera criação, pagamento, estorno ou expiração.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  className="shrink-0 border border-primary/20 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90"
                  disabled={bulkCheckPaymentsMutation.isPending || filteredCheckablePayments.length === 0}
                  onClick={() => {
                    setBulkCheckResults([]);
                    setBulkCheckProgress({ done: 0, total: filteredCheckablePayments.length });
                    setBulkCheckModalOpen(true);
                    bulkCheckPaymentsMutation.mutate(filteredCheckablePayments);
                  }}
                >
                  {bulkCheckPaymentsMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {bulkCheckPaymentsMutation.isPending && bulkCheckProgress
                    ? `Consultando ${bulkCheckProgress.done}/${bulkCheckProgress.total}`
                    : 'Consultar período'}
                </Button>
              </div>
              <div className="grid w-full gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_180px_220px_minmax(220px,1fr)]">
                <div className="space-y-2">
                  <Label htmlFor="payment-search">Nome</Label>
                  <Input
                    id="payment-search"
                    value={paymentSearchTerm}
                    onChange={(event) => handlePaymentSearchChange(event.target.value)}
                    placeholder="Pesquisar por nome"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={paymentStatusFilter} onValueChange={(value) => handlePaymentStatusFilterChange(value as PaymentStatusFilter)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Período</Label>
                  <Select value={paymentPeriodPreset} onValueChange={(value) => handlePaymentPresetChange(value as SummaryPeriodPreset)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUMMARY_PERIOD_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 sm:col-span-2 xl:col-span-1">
                  <Label>{paymentPeriodPreset === 'custom' ? 'Intervalo personalizado' : 'Intervalo aplicado'}</Label>
                  {paymentPeriodPreset === 'custom' ? (
                    <DateRangePicker
                      value={paymentRange}
                      onChange={handlePaymentRangeChange}
                      placeholder="Selecionar período"
                      className="w-full"
                    />
                  ) : (
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
                      {paymentPeriodLabel}
                    </div>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {latePaidPayments.length > 0 && (
                <Alert className="border-warning/40 bg-warning-soft/50">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle>Pagamentos recebidos após expiração</AlertTitle>
                  <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      {latePaidPayments.length} pagamento{latePaidPayments.length === 1 ? '' : 's'} neste filtro {latePaidPayments.length === 1 ? 'foi recebido' : 'foram recebidos'} após o prazo. {latePaidPayments.length === 1 ? 'A reserva não foi confirmada automaticamente e precisa' : 'As reservas não foram confirmadas automaticamente e precisam'} de ação manual.
                    </span>
                    {paymentStatusFilter !== 'late_paid' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0 border-warning/40 bg-background text-warning hover:bg-warning-soft"
                        onClick={() => handlePaymentStatusFilterChange('late_paid')}
                      >
                        Ver casos
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {cancelledReceivedPayments.length > 0 && (
                <Alert className="border-warning/30 bg-warning-soft/40">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <AlertTitle>Pagamento recebido em reserva cancelada</AlertTitle>
                  <AlertDescription>
                    {cancelledReceivedPayments.length} pagamento{cancelledReceivedPayments.length === 1 ? '' : 's'} pago{cancelledReceivedPayments.length === 1 ? '' : 's'} neste filtro pertence{cancelledReceivedPayments.length === 1 ? '' : 'm'} a reserva cancelada. Cancelar a reserva não estorna automaticamente no Asaas.
                  </AlertDescription>
                </Alert>
              )}

              {filteredPayments.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-background p-8 text-center">
                  <p className="text-sm font-medium text-foreground">Nenhum pagamento encontrado</p>
                  <p className="mt-1 text-sm text-muted-foreground">Altere o nome, status ou período para visualizar outros pagamentos.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {paginatedPayments.map((payment) => (
                      <PaymentListItem
                        key={payment.id}
                        payment={payment}
                        companySlug={slug}
                        onCheck={(token) => checkPaymentMutation.mutate(token)}
                        onRefund={setPendingRefundPayment}
                        isChecking={
                          checkPaymentMutation.isPending && checkPaymentMutation.variables === payment.payment_token
                        }
                        isRefunding={
                          refundPaymentMutation.isPending && refundPaymentMutation.variables?.id === payment.id
                        }
                      />
                    ))}
                  </div>
                  <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      {filteredPayments.length} pagamento{filteredPayments.length === 1 ? '' : 's'} encontrado{filteredPayments.length === 1 ? '' : 's'}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={currentPaymentPage <= 1}
                        onClick={() => setPaymentPage((current) => Math.max(1, current - 1))}
                      >
                        Anterior
                      </Button>
                      <span className="min-w-24 text-center">
                        Página {currentPaymentPage} de {paymentPageCount}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={currentPaymentPage >= paymentPageCount}
                        onClick={() => setPaymentPage((current) => Math.min(paymentPageCount, current + 1))}
                      >
                        Próxima
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="summary" className="space-y-4">
          <Card className="border-border shadow-card">
            <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Período do resumo</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Filtra pela data do evento financeiro: pagamento, estorno, chargeback ou expiração.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[220px_minmax(240px,1fr)] lg:w-[560px]">
                <div className="space-y-2">
                  <Label>Período</Label>
                  <Select value={summaryPeriodPreset} onValueChange={(value) => handleSummaryPresetChange(value as SummaryPeriodPreset)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUMMARY_PERIOD_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{summaryPeriodPreset === 'custom' ? 'Intervalo personalizado' : 'Intervalo aplicado'}</Label>
                  {summaryPeriodPreset === 'custom' ? (
                    <DateRangePicker
                      value={summaryRange}
                      onChange={setSummaryRange}
                      placeholder="Selecionar período"
                      className="w-full"
                    />
                  ) : (
                    <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
                      {summaryPeriodLabel}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={CheckCircle2}
              label="Pagamentos pagos"
              value={String(grossPaidCount)}
              detail="Reservas com pagamento confirmado (inclui estornados)"
            />
            <MetricCard
              icon={Banknote}
              label="Receita liquida"
              value={formatPrepaymentAmount(netRevenue)}
              detail="Pagos menos estornos e chargebacks"
            />
            <MetricCard
              icon={RefreshCw}
              label="Estornos"
              value={formatPrepaymentAmount(chartTotals.refunded)}
              detail={`${chartTotals.refundedCount} pagamento${chartTotals.refundedCount === 1 ? '' : 's'} estornado${chartTotals.refundedCount === 1 ? '' : 's'}`}
            />
            <MetricCard
              icon={AlertTriangle}
              label="Chargebacks"
              value={formatPrepaymentAmount(chartTotals.chargeback)}
              detail={`${chartTotals.chargebackCount} ocorrencia${chartTotals.chargebackCount === 1 ? '' : 's'}`}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="border-border shadow-card">
              <CardHeader>
                <CardTitle>Valores por dia</CardTitle>
                <CardDescription>
                  Valores por evento financeiro entre {summaryPeriodLabel}, separados por status financeiro.
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[320px]">
                {filteredFinancialDaily.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-background text-center">
                    <div>
                      <p className="text-sm font-medium text-foreground">Sem dados no período</p>
                      <p className="mt-1 text-sm text-muted-foreground">Ajuste o intervalo para visualizar o resumo.</p>
                    </div>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={filteredFinancialDaily} margin={{ top: 10, right: 10, left: 18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 12 }}
                        tickFormatter={formatCurrencyAxisTick}
                        stroke="hsl(var(--muted-foreground))"
                      />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted))' }}
                        formatter={(value) => formatTooltipCurrency(value)}
                        contentStyle={{
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 8,
                          background: 'hsl(var(--card))',
                        }}
                      />
                      <Legend />
                      <Bar dataKey="paid" name="Pagas" stackId="payments" fill="hsl(var(--success))" radius={[0, 0, 4, 4]} />
                      <Bar dataKey="refunded" name="Estornadas" stackId="payments" fill="hsl(var(--muted-foreground))" />
                      <Bar dataKey="chargeback" name="Chargeback" stackId="payments" fill="hsl(var(--destructive))" />
                      <Bar dataKey="refundPending" name="Estorno pendente" stackId="payments" fill="hsl(var(--warning))" />
                      <Bar dataKey="expired" name="Expiradas" stackId="payments" fill="hsl(var(--destructive))" />
                      <Bar dataKey="pending" name="Pendentes" stackId="payments" fill="hsl(var(--warning))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="border-border shadow-card">
              <CardHeader>
                <CardTitle>Totais do período</CardTitle>
                <CardDescription>Eventos financeiros entre {summaryPeriodLabel}.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <SummaryLine label="Pagamentos pagos" value={String(grossPaidCount)} tone="success" />
                <SummaryLine label="Valor pago (bruto)" value={formatPrepaymentAmount(grossPaid)} tone="success" />
                <SummaryLine label="Receita liquida" value={formatPrepaymentAmount(netRevenue)} tone="success" />
                <SummaryLine label="Valor estornado" value={formatPrepaymentAmount(chartTotals.refunded)} tone="default" />
                <SummaryLine label="Chargeback" value={formatPrepaymentAmount(chartTotals.chargeback)} tone="destructive" />
                <SummaryLine label="Estorno pendente" value={formatPrepaymentAmount(chartTotals.refundPending)} tone="warning" />
                <SummaryLine label="Valor expirado" value={formatPrepaymentAmount(chartTotals.expired)} tone="destructive" />
                <SummaryLine label="Valor pendente" value={formatPrepaymentAmount(chartTotals.pending)} tone="warning" />
                <Button
                  variant="outline"
                  className="mt-2 w-full"
                  onClick={refreshPaymentsData}
                  disabled={summaryPaymentsQuery.isFetching}
                >
                  {summaryPaymentsQuery.isFetching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Atualizar dados
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog
        open={bulkCheckModalOpen}
        onOpenChange={(open) => {
          if (!open && bulkCheckPaymentsMutation.isPending) return;
          setBulkCheckModalOpen(open);
          if (!open) {
            setBulkCheckProgress(null);
            setBulkCheckResults([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl" hideCloseButton={bulkCheckPaymentsMutation.isPending}>
          <DialogHeader>
            <DialogTitle>
              {bulkCheckPaymentsMutation.isPending ? 'Consultando pagamentos no Asaas' : 'Consulta de pagamentos concluída'}
            </DialogTitle>
            <DialogDescription>
              {bulkCheckTotal > 0
                ? `Período atual: ${paymentPeriodLabel}. ${bulkCheckDone} de ${bulkCheckTotal} pagamentos consultados.`
                : `Período atual: ${paymentPeriodLabel}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {bulkCheckPaymentsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  )}
                  <span>{bulkCheckPaymentsMutation.isPending ? 'Processando consultas' : 'Processamento finalizado'}</span>
                </div>
                <span className="text-muted-foreground">{bulkCheckProgressValue}%</span>
              </div>
              <Progress value={bulkCheckProgressValue} className="h-2" />
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-background px-3 py-2">
                <p className="text-xs text-muted-foreground">Consultados</p>
                <p className="text-lg font-semibold text-foreground">{bulkCheckResults.length}</p>
              </div>
              <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2">
                <p className="text-xs text-muted-foreground">Mudanças</p>
                <p className="text-lg font-semibold text-success">{bulkCheckChangedResults.length}</p>
              </div>
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
                <p className="text-xs text-muted-foreground">Falhas</p>
                <p className="text-lg font-semibold text-destructive">{bulkCheckFailedResults.length}</p>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-background">
              {bulkCheckResults.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Aguardando a primeira resposta do Asaas.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {bulkCheckResults.map((result) => (
                    <div key={`${result.paymentId}-${result.paymentToken}`} className="space-y-2 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm font-medium text-foreground">{result.customerName}</p>
                        {result.error ? (
                          <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                            Falhou
                          </Badge>
                        ) : result.changed && result.currentStatus ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={getPaymentStatusClass(result.previousStatus)}>
                              {getPaymentStatusLabel(result.previousStatus)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">-&gt;</span>
                            <Badge variant="outline" className={getPaymentStatusClass(result.currentStatus)}>
                              {getPaymentStatusLabel(result.currentStatus)}
                            </Badge>
                          </div>
                        ) : (
                          <Badge variant="outline" className="border-border bg-muted/40 text-muted-foreground">
                            Sem mudança
                          </Badge>
                        )}
                      </div>
                      {result.error && (
                        <p className="text-xs text-destructive">{result.error}</p>
                      )}
                      {!result.error && result.message && (
                        <p className="text-xs text-muted-foreground">{result.message}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!bulkCheckPaymentsMutation.isPending && bulkCheckResults.length > 0 && bulkCheckChangedResults.length === 0 && bulkCheckFailedResults.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nenhuma cobrança mudou de status. {bulkCheckUnchangedCount} pagamento{bulkCheckUnchangedCount === 1 ? '' : 's'} permaneceram iguais.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              disabled={bulkCheckPaymentsMutation.isPending}
              onClick={() => {
                setBulkCheckModalOpen(false);
                setBulkCheckProgress(null);
                setBulkCheckResults([]);
              }}
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingRefundPayment)} onOpenChange={(open) => !open && setPendingRefundPayment(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Estornar pagamento?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRefundPayment
                ? `O estorno de ${formatPrepaymentAmount(pendingRefundPayment.amount)} para ${pendingRefundPayment.customer_name} será solicitado no Asaas. A confirmação final depende do retorno do provedor.`
                : 'O estorno será solicitado no Asaas.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={refundPaymentMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={refundPaymentMutation.isPending || !pendingRefundPayment}
              onClick={(event) => {
                event.preventDefault();
                if (pendingRefundPayment) {
                  refundPaymentMutation.mutate(pendingRefundPayment);
                }
              }}
            >
              {refundPaymentMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Solicitar estorno
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(pendingRule)} onOpenChange={(open) => !open && setPendingRuleAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ruleActionIsArchive ? 'Arquivar regra?' : 'Excluir regra?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {ruleActionIsArchive
                ? `A regra "${pendingRule?.name}" já foi usada e será preservada no histórico. Ela não afetará novas reservas.`
                : `A regra "${pendingRule?.name}" ainda não foi usada e pode ser excluída definitivamente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={ruleActionIsArchive ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
              onClick={confirmRuleRemoval}
            >
              {ruleActionIsArchive ? 'Arquivar' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className="border-border shadow-card">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="rounded-lg bg-primary/10 p-3 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-lg font-semibold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function TutorialStep({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {number}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function RulesCard({
  title,
  description,
  emptyTitle,
  emptyDescription,
  rules,
  onToggleRule,
  onRemoveOrArchiveRule,
  onCloneRule,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  rules: ReservationPaymentRuleDraft[];
  onToggleRule: (ruleId: string, enabled: boolean) => void;
  onRemoveOrArchiveRule: (ruleId: string) => void;
  onCloneRule: (ruleId: string) => void;
}) {
  return (
    <Card className="border-border shadow-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-background p-8 text-center">
            <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
          </div>
        ) : (
          rules.map((rule) => (
            <RuleListItem
              key={rule.id}
              rule={rule}
              onToggleRule={onToggleRule}
              onRemoveOrArchiveRule={onRemoveOrArchiveRule}
              onCloneRule={onCloneRule}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RuleListItem({
  rule,
  onToggleRule,
  onRemoveOrArchiveRule,
  onCloneRule,
}: {
  rule: ReservationPaymentRuleDraft;
  onToggleRule: (ruleId: string, enabled: boolean) => void;
  onRemoveOrArchiveRule: (ruleId: string) => void;
  onCloneRule: (ruleId: string) => void;
}) {
  const isArchived = Boolean(rule.archived_at);
  const hasUsage = rule.usage_count > 0;
  const actionLabel = hasUsage ? 'Arquivar' : 'Excluir';
  const ActionIcon = hasUsage ? Archive : Trash2;

  return (
    <div className={isArchived ? 'rounded-lg border border-border bg-muted/40 p-4' : 'rounded-lg border border-border bg-background p-4'}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{rule.name}</p>
            <Badge variant={rule.enabled && !isArchived ? 'default' : 'secondary'}>
              {isArchived ? 'Arquivada' : rule.enabled ? 'Ativa' : 'Desativada'}
            </Badge>
            <Badge variant="outline">{getAmountTypeLabel(rule.amount_type)}</Badge>
            {rule.billing_types.map((billingType) => (
              <Badge key={billingType} variant="outline">{getBillingTypeLabel(billingType)}</Badge>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDateRange(rule.date_start, rule.date_end)} - sinal {formatPrepaymentAmount(rule.amount)} - {rule.payment_deadline_minutes} min para pagar
          </p>
          <p className="text-xs text-muted-foreground">{getRuleImpact(rule)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => onCloneRule(rule.id)}>
            <Copy className="mr-2 h-4 w-4" />
            Clonar
          </Button>
          {!isArchived && (
            <>
              <Label className="text-xs text-muted-foreground">Ativa</Label>
              <Switch checked={rule.enabled} onCheckedChange={(checked) => onToggleRule(rule.id, checked)} />
              <Button
                variant="outline"
                size="sm"
                className={hasUsage ? 'text-muted-foreground' : 'text-destructive hover:text-destructive'}
                onClick={() => onRemoveOrArchiveRule(rule.id)}
              >
                <ActionIcon className="mr-2 h-4 w-4" />
                {actionLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PaymentListItem({
  payment,
  companySlug,
  onCheck,
  onRefund,
  isChecking,
  isRefunding,
}: {
  payment: ReservationPaymentRow;
  companySlug: string;
  onCheck: (paymentToken: string) => void;
  onRefund: (payment: ReservationPaymentRow) => void;
  isChecking: boolean;
  isRefunding: boolean;
}) {
  const paymentMoment = payment.status === 'paid' || payment.status === 'late_paid'
    ? `Pago em ${formatPaymentPaidAt(payment)}`
    : payment.expires_at
      ? `Expira em ${formatDateTime(payment.expires_at)}`
      : '';
  const reservationWasCancelled = isReservationCancelledStatus(payment.reservation_status);
  const receivedAndCancelled = reservationWasCancelled && isReceivedPaymentStatus(payment.status);
  const requiresManualAction = isLatePaidPayment(payment);
  const expiredWhatsappUrl = buildExpiredReservationWhatsappUrl(payment, companySlug);
  const containerClassName = requiresManualAction
    ? 'rounded-md border border-warning/60 bg-warning-soft/30 px-3 py-2.5 shadow-sm'
    : receivedAndCancelled
      ? 'rounded-md border border-warning/40 bg-warning-soft/20 px-3 py-2.5'
      : 'rounded-md border border-border bg-background px-3 py-2.5';

  return (
    <div className={containerClassName}>
      <div className="grid gap-2 lg:grid-cols-[minmax(180px,1.2fr)_120px_120px_180px_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{payment.customer_name}</p>
            <Badge variant="outline" className={getPaymentStatusClass(payment.status)}>
              {getPaymentStatusLabel(payment.status)}
            </Badge>
            {requiresManualAction && (
              <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning">
                Ação manual
              </Badge>
            )}
            {reservationWasCancelled && (
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
                Reserva cancelada
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {payment.rule_name}
            {payment.reservation_date ? ` · ${formatShortDate(payment.reservation_date)}` : ''}
            {payment.reservation_time ? ` às ${payment.reservation_time}` : ''}
          </p>
        </div>

        <div className="text-sm text-muted-foreground">
          {payment.party_size} pessoas
        </div>

        <div>
          <p className="text-sm font-medium text-foreground">{formatPrepaymentAmount(payment.amount)}</p>
          <p className="text-xs text-muted-foreground">
            {payment.billing_type ? getBillingTypeLabel(payment.billing_type) : 'Método não escolhido'}
            {payment.installments && payment.installments > 1 ? ` ${payment.installments}x` : ''}
          </p>
        </div>

        <div className="text-xs text-muted-foreground">
          <p>Criado em {formatDateTime(payment.created_at)}</p>
          {paymentMoment && <p>{paymentMoment}</p>}
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          {canRefundPayment(payment) && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={isRefunding}
              onClick={() => onRefund(payment)}
            >
              {isRefunding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Estornar
            </Button>
          )}
          {expiredWhatsappUrl && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
            >
              <a href={expiredWhatsappUrl} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="h-4 w-4" />
                WhatsApp
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!payment.payment_token || isChecking}
            onClick={() => payment.payment_token && onCheck(payment.payment_token)}
          >
            {isChecking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Consultar
          </Button>
        </div>
      </div>
      {requiresManualAction && (
        <div className="mt-2 rounded-md border border-warning/40 bg-background/80 px-3 py-2 text-xs font-medium text-warning">
          Pagamento recebido após expiração. A reserva não foi confirmada porque houve conflito de disponibilidade. Avalie reagendamento ou estorno.
        </div>
      )}
      {receivedAndCancelled && (
        <div className="mt-2 rounded-md border border-warning/30 bg-background/70 px-3 py-2 text-xs font-medium text-warning">
          Pagamento recebido em reserva cancelada. O cancelamento da reserva não gera reembolso automático.
        </div>
      )}
    </div>
  );
}

function SummaryLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'destructive' | 'warning' | 'default';
}) {
  const toneClass = {
    success: 'text-success',
    destructive: 'text-destructive',
    warning: 'text-warning',
    default: 'text-foreground',
  }[tone];

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}
