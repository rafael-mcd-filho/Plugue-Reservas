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
  ChartNoAxesCombined,
  ArrowDownToLine,
  SlidersHorizontal,
  Download,

  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,

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
import { checkReservationPayment, refundReservationPayment } from '@/lib/asaas-prepayment-api';
import {
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
import { toStoredWhatsAppNumber } from '@/lib/phone';
import { buildWhatsAppMessageUrl } from '@/lib/whatsapp-links';
import { fetchCompanyReservationPayments, fetchCompanyReservationPaymentUsage } from '@/lib/asaas-prepayment-queries';
import { paymentMessage } from '@/lib/payment-messages';
import CompanySettlements from '@/components/billing/CompanySettlements';
import PrepaymentBalanceDashboard from '@/components/billing/PrepaymentBalanceDashboard';

interface RuleFormState {
  name: string;
  pricing_mode: 'single' | 'by_section';
  sections: RuleSectionForm[];
  date_start: string;
  date_end: string;
  amount_type: ReservationPrepaymentAmountType;
  amount: string;
  pix_enabled: boolean;
  pix_amount: string;
  credit_card_enabled: boolean;
  credit_card_amount: string;
  payment_deadline_minutes: string;
  customer_notice: string;
  cancellation_policy: string;
}

interface RuleSectionForm {
  section_id: string;
  public_name: string;
  description: string;
  amount: string;
  pix_amount: string;
  credit_card_amount: string;
  enabled: boolean;
}

interface TableSectionOption {
  id: string;
  name: string;
}

type RuleTab = 'active' | 'inactive' | 'archived';
type PrepaymentTab = 'summary' | 'payments' | 'withdrawals' | 'rules';
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
  reservation_id: string | null;
  asaas_payment_id: string | null;
  asaas_payment_link_id: string | null;
  external_reference: string | null;
  payment_token: string | null;
  customer_name: string;
  customer_phone: string | null;
  reservation_status: string | null;
  reservation_date: string;
  reservation_time: string;
  party_size: number;
  rule_name: string;
  section_name: string | null;
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
  cancelled: number;
  paidCount: number;
  expiredCount: number;
  pendingCount: number;
  refundedCount: number;
  chargebackCount: number;
  refundPendingCount: number;
  cancelledCount: number;
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
    : row?.status === 'partial_refunded' ? 0 : amount;

  return {
    id: row?.id ?? '',
    reservation_id: row?.reservation_id ?? reservation?.id ?? null,
    asaas_payment_id: row?.asaas_payment_id ?? null,
    asaas_payment_link_id: row?.asaas_payment_link_id ?? null,
    external_reference: row?.payment_link_external_reference ?? null,
    payment_token: row?.payment_token ?? null,
    customer_name: reservation?.guest_name ?? 'Cliente',
    customer_phone: reservation?.guest_phone ?? null,
    reservation_status: reservation?.status ?? null,
    reservation_date: reservation?.date ?? '',
    reservation_time: typeof reservation?.time === 'string' ? reservation.time.slice(0, 5) : '',
    party_size: Number(reservation?.party_size ?? 0),
    rule_name: typeof snapshot?.name === 'string' && snapshot.name ? snapshot.name : 'Pagamento antecipado',
    section_name: snapshot?.selected_section_name ?? reservation?.selected_section_name ?? null,
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
      cancelled: 0,
      paidCount: 0,
      expiredCount: 0,
      pendingCount: 0,
      refundedCount: 0,
      chargebackCount: 0,
      refundPendingCount: 0,
      cancelledCount: 0,
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
    } else if (payment.status === 'cancelled') {
      bucket.cancelled += payment.amount;
      bucket.cancelledCount += 1;
    }
  }

  return Array.from(buckets.values());
}

const DEFAULT_CUSTOMER_NOTICE = 'O valor pago será abatido da conta no dia da visita.';
const DEFAULT_CANCELLATION_POLICY = 'Se o pagamento não for confirmado dentro do prazo, a pré-reserva expira e a mesa volta a ficar disponível.';
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
    pricing_mode: 'single',
    sections: [],
    date_start: date,
    date_end: date,
    amount_type: 'per_person',
    amount: '80,00',
    pix_enabled: true,
    pix_amount: '80,00',
    credit_card_enabled: true,
    credit_card_amount: '90,00',
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
  if (rule.pricing_mode === 'by_section') {
    const count = rule.sections?.filter((section) => section.enabled).length ?? 0;
    return `${count} ambiente${count === 1 ? '' : 's'} com valores próprios. A reserva fica vinculada ao ambiente escolhido.`;
  }
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
    cardAmount ? `Cartão ${formatPrepaymentAmount(cardAmount)} à vista` : null,
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

function isMissingSectionPricingSchema(error: { code?: string; message?: string; details?: string } | null) {
  return Boolean(error && ['PGRST200', 'PGRST205'].includes(error.code ?? '')
    && `${error.message ?? ''} ${error.details ?? ''}`.includes('reservation_payment_rule_sections'));
}

function isMissingPricingSectionsRpc(error: { code?: string; message?: string } | null) {
  return error?.code === 'PGRST202' && (error.message ?? '').includes('list_reservation_pricing_sections');
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
  return Boolean(payment.payment_token) && !payment.metadata?.asaas_installment_id
    && (payment.status === 'paid' || payment.status === 'late_paid');
}

function buildCompanyPublicReservationUrl(companySlug: string) {
  if (typeof window === 'undefined') return `/${companySlug}`;
  return new URL(`/${companySlug}`, window.location.origin).toString();
}

function buildExpiredReservationWhatsappUrl(payment: ReservationPaymentRow, companySlug: string) {
  if (payment.status !== 'expired') return null;

  const whatsappNumber = toStoredWhatsAppNumber(payment.customer_phone);
  if (!whatsappNumber) return null;

  const dateLabel = payment.reservation_date
    ? `o dia ${formatShortDate(payment.reservation_date)}`
    : 'a data escolhida';
  const timeLabel = payment.reservation_time ? ` às ${payment.reservation_time}` : '';
  const reservationUrl = buildCompanyPublicReservationUrl(companySlug);
  const message =
    `Olá, sua reserva para ${dateLabel}${timeLabel} expirou. ` +
    `Mas não perca tempo: os horários estão se esgotando. ` +
    `Faça uma nova reserva pelo link: ${reservationUrl}`;

  return buildWhatsAppMessageUrl(whatsappNumber, message);
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
    pricing_mode: row.pricing_mode === 'by_section' ? 'by_section' : 'single',
    sections: (row.sections ?? []).map((section: any) => ({
      ...section,
      base_amount: Number(section.base_amount),
      pix_amount: section.pix_amount == null ? null : Number(section.pix_amount),
      credit_card_amount: section.credit_card_amount == null ? null : Number(section.credit_card_amount),
      section_name: section.section?.name ?? section.section_name,
    })).sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order),
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
  const [ruleForm, setRuleForm] = useState<RuleFormState>(() => createRuleForm());
  const [ruleTab, setRuleTab] = useState<RuleTab>('active');
  const [activeTab, setActiveTab] = useState<PrepaymentTab>('summary');
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatusFilter>('all');
  const [paymentPeriodPreset, setPaymentPeriodPreset] = useState<SummaryPeriodPreset>('last_7_days');
  const [paymentRange, setPaymentRange] = useState<DateRange>(() => getSummaryPresetRange('last_7_days'));
  const [paymentSearchTerm, setPaymentSearchTerm] = useState('');
  const [isExportingPayments, setIsExportingPayments] = useState(false);
  const [paymentPage, setPaymentPage] = useState(1);
  const [pendingRuleAction, setPendingRuleAction] = useState<PendingRuleAction | null>(null);
  const [pendingRefundPayment, setPendingRefundPayment] = useState<ReservationPaymentRow | null>(null);
  const [bulkCheckModalOpen, setBulkCheckModalOpen] = useState(false);
  const [bulkCheckProgress, setBulkCheckProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkCheckResults, setBulkCheckResults] = useState<BulkCheckResult[]>([]);
  const [summaryPeriodPreset, setSummaryPeriodPreset] = useState<SummaryPeriodPreset>('last_7_days');
  const [summaryRange, setSummaryRange] = useState<DateRange>(() => getSummaryPresetRange('last_7_days'));

  const prepaymentEnabled = featureFlags?.features.reservation_prepayment ?? false;
  const rulesQuery = useQuery({
    queryKey: ['reservation-payment-rules', companyId],
    queryFn: async () => {
      if (!companyId) throw new Error('Empresa não identificada.');

      let result = await supabase
        .from('reservation_payment_rules' as any)
        .select('*, sections:reservation_payment_rule_sections(*, section:table_sections(name))')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });

      const sectionPricingAvailable = !isMissingSectionPricingSchema(result.error);
      if (!sectionPricingAvailable) {
        result = await supabase
          .from('reservation_payment_rules' as any)
          .select('*')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false });
      }
      if (result.error) throw result.error;

      const rows = (result.data ?? []) as any[];
      const ruleIds = rows.map((row) => row.id).filter(Boolean);
      const usageCounts = new Map<string, number>();

      if (ruleIds.length > 0) {
        const payments = await fetchCompanyReservationPaymentUsage(companyId, ruleIds);
        payments.forEach((payment) => {
          if (!payment.rule_id) return;
          usageCounts.set(payment.rule_id, (usageCounts.get(payment.rule_id) ?? 0) + 1);
        });
      }

      return { rules: rows.map((row) => mapReservationPaymentRule(row, usageCounts.get(row.id) ?? 0)), sectionPricingAvailable };
    },
    enabled: Boolean(companyId),
  });
  const rules = useMemo(() => rulesQuery.data?.rules ?? [], [rulesQuery.data]);
  const legacyPaymentSchema = rulesQuery.data?.sectionPricingAvailable === false;

  const tableSectionsQuery = useQuery({
    queryKey: ['reservation-pricing-sections', companyId, ruleForm.date_start, ruleForm.date_end],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('list_reservation_pricing_sections', {
        _company_id: companyId,
        _date_start: ruleForm.date_start,
        _date_end: ruleForm.date_end,
      });
      if (error) throw error;
      return (data ?? []) as unknown as TableSectionOption[];
    },
    enabled: Boolean(companyId) && ruleDialogOpen && ruleForm.pricing_mode === 'by_section'
      && !legacyPaymentSchema && Boolean(ruleForm.date_start) && Boolean(ruleForm.date_end)
      && ruleForm.date_start <= ruleForm.date_end,
  });
  const unavailableConfiguredSections = tableSectionsQuery.isSuccess
    ? ruleForm.sections.filter((section) => section.enabled && !tableSectionsQuery.data.some((item) => item.id === section.section_id))
    : [];

  const updateRuleSection = (section: TableSectionOption, patch: Partial<RuleSectionForm>) => {
    setRuleForm((current) => {
      const existing = current.sections.find((item) => item.section_id === section.id);
      const updated = {
        section_id: section.id,
        public_name: section.name,
        description: '',
        amount: current.amount,
        pix_amount: current.pix_amount,
        credit_card_amount: current.credit_card_amount,
        enabled: false,
        ...existing,
        ...patch,
      };
      return { ...current, sections: existing
        ? current.sections.map((item) => item.section_id === section.id ? updated : item)
        : [...current.sections, updated] };
    });
  };

  const invalidateRules = () => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: ['reservation-payment-rules', companyId] });
  };

  const createRuleMutation = useMutation({
    mutationFn: async ({ rule: payload, sections }: { rule: Record<string, unknown>; sections: Record<string, unknown>[] }) => {
      if (payload.pricing_mode === 'by_section') {
        const { error } = await (supabase.rpc as any)('create_reservation_payment_rule', { _rule: payload, _sections: sections });
        if (error) throw error;
        return;
      }
      const legacyPayload = { ...payload };
      delete legacyPayload.pricing_mode;
      const { error } = await supabase
        .from('reservation_payment_rules' as any)
        .insert(legacyPayload);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateRules();
      setRuleForm(createRuleForm());
      setRuleTab('inactive');
      setRuleDialogOpen(false);
      toast.success('Regra adicionada em Desativadas.');
    },
    onError: (error) => {
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível salvar a regra.'));
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
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível atualizar a regra.'));
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
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível remover a regra.'));
    },
  });

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
      const data = await fetchCompanyReservationPayments({ companyId: companyId!, from, to });
      return data.map(mapPaymentRowFromDb);
    },
  });
  const summaryPayments = useMemo(() => summaryPaymentsQuery.data ?? [], [summaryPaymentsQuery.data]);
  const summaryHasUnknownRefundAmount = summaryPayments.some((payment) =>
    payment.status === 'partial_refunded'
    && !(Number(payment.metadata?.provider_status_check?.refunded_value) > 0));

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
        cancelled: acc.cancelled + item.cancelled,
        paidCount: acc.paidCount + item.paidCount,
        expiredCount: acc.expiredCount + item.expiredCount,
        pendingCount: acc.pendingCount + item.pendingCount,
        refundedCount: acc.refundedCount + item.refundedCount,
        chargebackCount: acc.chargebackCount + item.chargebackCount,
        refundPendingCount: acc.refundPendingCount + item.refundPendingCount,
        cancelledCount: acc.cancelledCount + item.cancelledCount,
      }),
      {
        paid: 0,
        expired: 0,
        pending: 0,
        refunded: 0,
        chargeback: 0,
        refundPending: 0,
        cancelled: 0,
        paidCount: 0,
        expiredCount: 0,
        pendingCount: 0,
        refundedCount: 0,
        chargebackCount: 0,
        refundPendingCount: 0,
        cancelledCount: 0,
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
      const data = await fetchCompanyReservationPayments({ companyId: companyId!, from, to, status: paymentStatusFilter });
      return data
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
        toast.warning('Pagamento estornado.');
        return;
      }
      if (data.status === 'partial_refunded') {
        toast.warning('Pagamento parcialmente estornado.');
        return;
      }
      if (data.status === 'refund_pending') {
        toast.warning('Estorno em processamento.');
        return;
      }
      if (data.status === 'refund_denied') {
        toast.error('Estorno negado.');
        return;
      }
      if (data.status === 'chargeback') {
        toast.warning('Pagamento com chargeback.');
        return;
      }
      if (data.status === 'cancelled') {
        toast.warning('Pagamento cancelado.');
        return;
      }
      if (data.message) {
        toast.info(paymentMessage(data.message));
        return;
      }
      toast.info('Status atualizado.');
    },
    onError: (error) => {
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível consultar o pagamento.'));
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
              message: data.message ? paymentMessage(data.message) : null,
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
              error: paymentMessage(error instanceof Error ? error.message : error, 'Falha ao consultar pagamento.'),
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
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível consultar os pagamentos.'));
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
        toast.success('Pagamento estornado.');
        return;
      }
      toast.success('Estorno solicitado.');
    },
    onError: (error) => {
      setPendingRefundPayment(null);
      refreshPaymentsData();
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível solicitar o estorno.'));
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

  const handleExportPayments = async () => {
    if (paymentsListQuery.isError || paymentsListQuery.isLoading || filteredPayments.length === 0) return;
    setIsExportingPayments(true);
    try {
      const { downloadSpreadsheet } = await import('@/lib/export-utils');
      await downloadSpreadsheet({
        filename: `pagamentos-antecipados-${slug || companyId}-${format(new Date(), 'yyyy-MM-dd')}.xlsx`,
        sheetName: 'Pagamentos antecipados',
        columns: [
          { header: 'Empresa (ID)', width: 38 },
          { header: 'Pagamento (ID)', width: 38 },
          { header: 'Reserva (ID)', width: 38 },
          { header: 'Identificador da cobrança', width: 28 },
          { header: 'Identificador do link de pagamento', width: 32 },
          { header: 'Referência externa', width: 55 },
          { header: 'Cliente', width: 28 },
          { header: 'Regra', width: 26 },
          { header: 'Data da reserva', width: 18 },
          { header: 'Hora da reserva', width: 18 },
          { header: 'Status do pagamento', width: 24 },
          { header: 'Status da reserva', width: 22 },
          { header: 'Forma de pagamento', width: 22 },
          { header: 'Valor da cobrança (R$)', width: 25, format: '#,##0.00' },
          { header: 'Criado em', width: 28 },
          { header: 'Pago em', width: 28 },
          { header: 'Cancelado/estornado em', width: 28 },
        ],
        rows: filteredPayments.map((payment) => [
          companyId, payment.id, payment.reservation_id, payment.asaas_payment_id,
          payment.asaas_payment_link_id, payment.external_reference, payment.customer_name,
          payment.rule_name, payment.reservation_date, payment.reservation_time,
          getPaymentStatusLabel(payment.status), payment.reservation_status,
          payment.billing_type ? getBillingTypeLabel(payment.billing_type) : '', payment.amount,
          payment.created_at, payment.paid_at, payment.cancelled_at,
        ]),
      });
    } catch (error) {
      toast.error(paymentMessage(error instanceof Error ? error.message : error, 'Não foi possível exportar os pagamentos.'));
    } finally {
      setIsExportingPayments(false);
    }
  };

  const handleRuleSave = () => {
    const name = ruleForm.name.trim();
    const selectedSections = ruleForm.sections.filter((section) => section.enabled);
    const sectionPrices = selectedSections.map((section, index) => ({
      section_id: section.section_id,
      public_name: section.public_name.trim(),
      description: section.description.trim(),
      base_amount: parseCurrencyInput(section.amount),
      pix_amount: ruleForm.pix_enabled ? parseCurrencyInput(section.pix_amount) : null,
      credit_card_amount: ruleForm.credit_card_enabled ? parseCurrencyInput(section.credit_card_amount) : null,
      enabled: true,
      sort_order: index,
    }));
    const bySection = ruleForm.pricing_mode === 'by_section';
    const amount = bySection ? sectionPrices[0]?.base_amount ?? 0 : parseCurrencyInput(ruleForm.amount);
    const pixAmount = bySection ? sectionPrices[0]?.pix_amount ?? 0 : parseCurrencyInput(ruleForm.pix_amount);
    const creditCardAmount = bySection ? sectionPrices[0]?.credit_card_amount ?? 0 : parseCurrencyInput(ruleForm.credit_card_amount);
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
    if (bySection && legacyPaymentSchema) {
      toast.error('Os valores por ambiente precisam da atualização local do banco antes de serem configurados.');
      return;
    }
    if (bySection && (tableSectionsQuery.isError || tableSectionsQuery.isPending)) {
      toast.error('Aguarde o carregamento dos ambientes antes de salvar.');
      return;
    }
    if (bySection && unavailableConfiguredSections.length > 0) {
      toast.error('Remova os ambientes que não estão habilitados na disponibilidade deste período.');
      return;
    }
    if (bySection && sectionPrices.length === 0) {
      toast.error('Selecione pelo menos um ambiente para oferecer ao cliente.');
      return;
    }
    if (bySection && sectionPrices.some((section) => !section.public_name)) {
      toast.error('Informe o nome exibido ao cliente em cada ambiente.');
      return;
    }
    if (bySection && sectionPrices.some((section) => section.base_amount <= 0
      || (ruleForm.pix_enabled && (section.pix_amount ?? 0) <= 0)
      || (ruleForm.credit_card_enabled && (section.credit_card_amount ?? 0) <= 0))) {
      toast.error('Informe valores maiores que zero em todos os ambientes e formas de pagamento habilitadas.');
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
    if (!Number.isFinite(deadline) || deadline < 1) {
      toast.error('Informe um prazo de pagamento válido.');
      return;
    }

    createRuleMutation.mutate({ rule: {
      company_id: companyId,
      name,
      enabled: false,
      pricing_mode: ruleForm.pricing_mode,
      date_start: ruleForm.date_start,
      date_end: ruleForm.date_end,
      amount_type: ruleForm.amount_type,
      base_amount: amount,
      pix_enabled: ruleForm.pix_enabled,
      pix_amount: ruleForm.pix_enabled ? pixAmount : null,
      credit_card_enabled: ruleForm.credit_card_enabled,
      credit_card_amount: ruleForm.credit_card_enabled ? creditCardAmount : null,
      max_credit_card_installments: ruleForm.credit_card_enabled ? 1 : null,
      payment_deadline_minutes: deadline,
      customer_notice: ruleForm.customer_notice.trim(),
      cancellation_policy: ruleForm.cancellation_policy.trim(),
    }, sections: bySection ? sectionPrices : [] });
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
      pricing_mode: selectedRule.pricing_mode ?? 'single',
      sections: (selectedRule.sections ?? []).map((section) => ({
        section_id: section.section_id,
        public_name: section.public_name,
        description: section.description ?? '',
        amount: section.base_amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
        pix_amount: section.pix_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
        credit_card_amount: section.credit_card_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
        enabled: section.enabled,
      })),
      date_start: selectedRule.date_start,
      date_end: selectedRule.date_end,
      amount_type: selectedRule.amount_type,
      amount: selectedRule.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
      pix_enabled: selectedRule.pix_enabled,
      pix_amount: selectedRule.pix_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
      credit_card_enabled: selectedRule.credit_card_enabled,
      credit_card_amount: selectedRule.credit_card_amount?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '',
      payment_deadline_minutes: String(selectedRule.payment_deadline_minutes),
      customer_notice: selectedRule.customer_notice,
      cancellation_policy: selectedRule.cancellation_policy,
    });
    setRuleDialogOpen(true);
    toast.success('Regra copiada para nova regra.');
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 pb-6 sm:space-y-8">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Pagamentos das reservas</h1>
        </div>
        <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">
          Acompanhe seus recebimentos, consulte cobranças e organize os repasses.
        </p>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${prepaymentEnabled ? 'bg-success' : 'bg-muted-foreground'}`} />
        <span>{prepaymentEnabled ? 'Antecipações ativas' : 'Antecipações desativadas'}</span>
        <span className="mx-1 text-border">/</span><span>Pix e cartão</span>
      </div>
      </div>

      {!prepaymentEnabled && !featureFlagsLoading && (
        <Alert className="border-warning/30 bg-warning-soft/50">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle>Módulo ainda não ativo para esta empresa</AlertTitle>
          <AlertDescription>
            Novas reservas continuam sem antecipação até a funcionalidade ser habilitada pela plataforma. Seu histórico financeiro permanece disponível.
          </AlertDescription>
        </Alert>
      )}

      <PrepaymentBalanceDashboard companyId={companyId} onOpenWithdrawals={() => setActiveTab('withdrawals')} />

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PrepaymentTab)} className="space-y-6">
        <TabsList aria-label="Áreas dos pagamentos" className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl border border-border/80 bg-muted/35 p-1.5 sm:grid-cols-4">
          <TabsTrigger value="summary" className="min-h-11 gap-2 rounded-lg px-2 text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm sm:text-sm"><ChartNoAxesCombined className="hidden h-4 w-4 sm:block" />Resumo financeiro</TabsTrigger>
          <TabsTrigger value="payments" className="min-h-11 gap-2 rounded-lg px-2 text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm sm:text-sm"><CreditCard className="hidden h-4 w-4 sm:block" />Pagamentos</TabsTrigger>
          <TabsTrigger value="withdrawals" className="min-h-11 gap-2 rounded-lg px-2 text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm sm:text-sm"><ArrowDownToLine className="hidden h-4 w-4 sm:block" />Saques</TabsTrigger>
          <TabsTrigger value="rules" className="min-h-11 gap-2 rounded-lg px-2 text-xs data-[state=active]:bg-card data-[state=active]:shadow-sm sm:text-sm"><SlidersHorizontal className="hidden h-4 w-4 sm:block" />Regras</TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="space-y-4">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div><h2 className="text-lg font-semibold tracking-tight">Regras de antecipação</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Defina quando pedir um sinal e quanto cobrar por reserva ou por pessoa.</p></div>
            <Button className="shrink-0 gap-2 self-start" onClick={() => { setRuleForm(createRuleForm()); setRuleDialogOpen(true); }}><Plus className="h-4 w-4" />Nova regra</Button>
          </div>

          {rulesQuery.isError ? (
            <QueryErrorNotice message="Não foi possível carregar as regras de antecipação. Tente novamente." onRetry={() => rulesQuery.refetch()} />
          ) : rulesQuery.isLoading ? (
            <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando regras…</p>
          ) : (
          <Tabs value={ruleTab} onValueChange={(value) => setRuleTab(value as RuleTab)} className="space-y-4">
            <TabsList aria-label="Situação das regras" className="h-auto max-w-full justify-start gap-1 rounded-lg bg-muted/50 p-1">
              <TabsTrigger value="active" className="min-h-9 gap-2 px-3 text-xs sm:text-sm">Ativas <span className="text-[11px] tabular-nums text-muted-foreground">{activeRules.length}</span></TabsTrigger>
              <TabsTrigger value="inactive" className="min-h-9 gap-2 px-3 text-xs sm:text-sm">Desativadas <span className="text-[11px] tabular-nums text-muted-foreground">{inactiveRules.length}</span></TabsTrigger>
              <TabsTrigger value="archived" className="min-h-9 gap-2 px-3 text-xs sm:text-sm">Arquivadas <span className="text-[11px] tabular-nums text-muted-foreground">{archivedRules.length}</span></TabsTrigger>
            </TabsList>

            <TabsContent value="active">
              <RulesCard
                title="Regras ativas"
                description="Somente uma regra ativa pode ocupar cada dia."
                emptyTitle="Nenhuma regra ativa"
                emptyDescription="Ative uma regra desativada ou crie uma nova regra para datas especiais."
                onCreateRule={() => { setRuleForm(createRuleForm()); setRuleDialogOpen(true); }}
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

          </Tabs>
          )}
          <p className="flex items-start gap-2 rounded-lg bg-muted/35 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>As regras valem apenas para novas reservas criadas após a ativação. Reservas anteriores permanecem como estão.</span></p>
        </TabsContent>

      <Dialog open={ruleDialogOpen} onOpenChange={(open) => { if (!createRuleMutation.isPending) setRuleDialogOpen(open); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Nova regra de antecipação</DialogTitle><DialogDescription>Escolha o período, os valores e as formas de pagamento. A regra entra desativada para você revisar antes de ativar.</DialogDescription></DialogHeader>
          <div className="space-y-4 pt-2">
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

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Como definir os valores?</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {([
                      ['single', 'Valor único', 'Mesmo valor para todas as reservas; o cliente não escolhe o ambiente.'],
                      ['by_section', 'Por ambiente', 'O cliente escolhe onde ficar e vê o valor de cada ambiente.'],
                    ] as const).map(([value, title, description]) => (
                      <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${ruleForm.pricing_mode === value ? 'border-primary bg-primary/5' : 'border-border bg-background'}`}>
                        <input
                          type="radio"
                          name="pricing-mode"
                          value={value}
                          checked={ruleForm.pricing_mode === value}
                          onChange={() => setRuleForm((current) => ({ ...current, pricing_mode: value }))}
                          aria-label={title}
                          className="mt-1 accent-primary"
                        />
                        <span><span className="block text-sm font-semibold">{title}</span><span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{description}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className={ruleForm.pricing_mode === 'single' ? 'grid gap-3 sm:grid-cols-[1fr_120px]' : 'space-y-2'}>
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
                  {ruleForm.pricing_mode === 'single' && <div className="space-y-2">
                    <Label htmlFor="amount">Valor do sinal</Label>
                    <Input
                      id="amount"
                      inputMode="decimal"
                      value={ruleForm.amount}
                      onChange={(event) => setRuleForm((current) => ({ ...current, amount: event.target.value }))}
                    />
                  </div>}
                </div>

                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-1 items-start justify-between gap-3">
                        <div>
                          <Label>Pix</Label>
                          <p className="text-xs text-muted-foreground">Gera o QR Code Pix e o código copia e cola da reserva.</p>
                        </div>
                        <Switch
                          aria-label="Aceitar Pix"
                          className="mt-0.5 shrink-0"
                          checked={ruleForm.pix_enabled}
                          onCheckedChange={(checked) => setRuleForm((current) => ({ ...current, pix_enabled: checked }))}
                        />
                      </div>
                      {ruleForm.pricing_mode === 'single' && <div className="space-y-2">
                        <Label htmlFor="pix-amount">Valor no Pix</Label>
                        <Input
                          id="pix-amount"
                          inputMode="decimal"
                          value={ruleForm.pix_amount}
                          disabled={!ruleForm.pix_enabled}
                          onChange={(event) => setRuleForm((current) => ({ ...current, pix_amount: event.target.value }))}
                        />
                      </div>}
                    </div>

                    <div className="flex flex-col gap-3">
                      <div className="flex flex-1 items-start justify-between gap-3">
                        <div>
                          <Label>Cartão de crédito à vista</Label>
                          <p className="text-xs text-muted-foreground">Pagamento em parcela única.</p>
                        </div>
                        <Switch
                          aria-label="Aceitar cartão de crédito"
                          className="mt-0.5 shrink-0"
                          checked={ruleForm.credit_card_enabled}
                          onCheckedChange={(checked) => setRuleForm((current) => ({ ...current, credit_card_enabled: checked }))}
                        />
                      </div>
                      {ruleForm.pricing_mode === 'single' && <div className="space-y-2">
                        <Label htmlFor="card-amount">Valor no cartão</Label>
                        <Input
                          id="card-amount"
                          inputMode="decimal"
                          value={ruleForm.credit_card_amount}
                          disabled={!ruleForm.credit_card_enabled}
                          onChange={(event) => setRuleForm((current) => ({ ...current, credit_card_amount: event.target.value }))}
                        />
                      </div>}
                    </div>
                  </div>
                </div>

                {ruleForm.pricing_mode === 'by_section' && (
                  <section aria-label="Ambientes oferecidos" className="space-y-3">
                    <div>
                      <h3 className="text-base font-semibold">Ambientes oferecidos</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Os ambientes vêm da configuração de disponibilidade deste período. Os valores abaixo são {ruleForm.amount_type === 'per_person' ? 'por pessoa' : 'por reserva'}; a reserva fica vinculada ao ambiente escolhido.</p>
                    </div>
                    {legacyPaymentSchema || isMissingPricingSectionsRpc(tableSectionsQuery.error) ? (
                      <Alert className="border-warning/30 bg-warning-soft/50"><AlertTriangle className="h-4 w-4" /><AlertTitle>Valores por ambiente ainda não disponíveis</AlertTitle><AlertDescription>A atualização local do banco precisa ser aplicada para configurar valores por ambiente. As regras de valor único continuam disponíveis.</AlertDescription></Alert>
                    ) : tableSectionsQuery.isError ? (
                      <QueryErrorNotice message="Não foi possível carregar os ambientes deste período." onRetry={() => tableSectionsQuery.refetch()} />
                    ) : tableSectionsQuery.isPending ? (
                      <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando ambientes…</p>
                    ) : tableSectionsQuery.data?.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Nenhum ambiente está habilitado para escolha neste período. Ative a escolha de ambiente nos horários da disponibilidade antes de definir os valores.</p>
                    ) : tableSectionsQuery.data?.map((section) => {
                      const sectionForm = ruleForm.sections.find((item) => item.section_id === section.id);
                      const isEnabled = sectionForm?.enabled === true;
                      return (
                        <div key={section.id} className={`rounded-xl border p-4 ${isEnabled ? 'border-primary/35 bg-primary/[0.025]' : 'border-border bg-background'}`}>
                          <div className="flex items-center justify-between gap-3">
                            <Label htmlFor={`offer-section-${section.id}`} className="text-sm font-semibold">{section.name}</Label>
                            <Switch id={`offer-section-${section.id}`} aria-label={`Oferecer ${section.name}`} checked={isEnabled} onCheckedChange={(enabled) => updateRuleSection(section, { enabled })} />
                          </div>
                          {isEnabled && sectionForm && (
                            <div className="mt-4 space-y-3">
                              <div className="space-y-2">
                                <Label htmlFor={`section-${section.id}-name`}>Nome exibido para {section.name}</Label>
                                <Input id={`section-${section.id}-name`} value={sectionForm.public_name} maxLength={120} onChange={(event) => updateRuleSection(section, { public_name: event.target.value })} />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor={`section-${section.id}-description`}>Descrição de {section.name} (opcional)</Label>
                                <Textarea id={`section-${section.id}-description`} value={sectionForm.description} rows={2} maxLength={500} onChange={(event) => updateRuleSection(section, { description: event.target.value })} />
                              </div>
                              <div className="grid items-end gap-3 sm:grid-cols-3">
                                <div className="space-y-2">
                                  <Label htmlFor={`section-${section.id}-amount`}>Sinal em {section.name}</Label>
                                  <Input id={`section-${section.id}-amount`} inputMode="decimal" value={sectionForm.amount} onChange={(event) => updateRuleSection(section, { amount: event.target.value })} />
                                </div>
                                {ruleForm.pix_enabled && <div className="space-y-2">
                                  <Label htmlFor={`section-${section.id}-pix`}>Pix em {section.name}</Label>
                                  <Input id={`section-${section.id}-pix`} inputMode="decimal" value={sectionForm.pix_amount} onChange={(event) => updateRuleSection(section, { pix_amount: event.target.value })} />
                                </div>}
                                {ruleForm.credit_card_enabled && <div className="space-y-2">
                                  <Label htmlFor={`section-${section.id}-card`}>Cartão em {section.name}</Label>
                                  <Input id={`section-${section.id}-card`} inputMode="decimal" value={sectionForm.credit_card_amount} onChange={(event) => updateRuleSection(section, { credit_card_amount: event.target.value })} />
                                </div>}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {unavailableConfiguredSections.length > 0 && (
                      <div role="alert" className="space-y-2 rounded-lg border border-warning/30 bg-warning-soft/50 p-3 text-sm">
                        <p>Alguns ambientes da regra copiada não estão habilitados na disponibilidade deste período.</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => setRuleForm((current) => ({ ...current, sections: current.sections.filter((section) => !unavailableConfiguredSections.some((item) => item.section_id === section.section_id)) }))}>Remover ambientes indisponíveis</Button>
                      </div>
                    )}
                  </section>
                )}

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
          </div>
        </DialogContent>
      </Dialog>

        <TabsContent value="payments" className="space-y-4">
          <Card className="border-border shadow-card">
            <CardHeader className="gap-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="text-lg">Pagamentos de reservas</CardTitle>
                  <CardDescription>
                    Atualiza automaticamente a cada 30 segundos. O período considera criação, pagamento, estorno ou expiração.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isExportingPayments || paymentsListQuery.isError || paymentsListQuery.isLoading || filteredPayments.length === 0}
                  onClick={handleExportPayments}
                >
                  {isExportingPayments ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  Exportar Excel
                </Button>
                <Button
                  type="button"
                  className="shrink-0 border border-primary/20 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90"
                  disabled={paymentsListQuery.isError || paymentsListQuery.isLoading || bulkCheckPaymentsMutation.isPending || filteredCheckablePayments.length === 0}
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
                    {cancelledReceivedPayments.length} pagamento{cancelledReceivedPayments.length === 1 ? '' : 's'} pago{cancelledReceivedPayments.length === 1 ? '' : 's'} neste filtro pertence{cancelledReceivedPayments.length === 1 ? '' : 'm'} a reserva cancelada. Cancelar a reserva não estorna automaticamente o pagamento.
                  </AlertDescription>
                </Alert>
              )}

              {paymentsListQuery.isError ? (
                <QueryErrorNotice message="Não foi possível carregar os pagamentos. A lista pode estar incompleta; tente novamente." onRetry={() => paymentsListQuery.refetch()} />
              ) : paymentsListQuery.isLoading ? (
                <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando pagamentos…</p>
              ) : filteredPayments.length === 0 ? (
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
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-foreground">Movimentação por período</h2>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Consulte a posição das cobranças por sua última movimentação. Este filtro não altera o saldo acumulado acima.
                </p>
              </div>
              <div className="grid shrink-0 gap-3 sm:grid-cols-[180px_minmax(220px,1fr)] xl:w-[480px]">
                <div className="space-y-2">
                  <Label htmlFor="summary-period">Período</Label>
                  <Select value={summaryPeriodPreset} onValueChange={(value) => handleSummaryPresetChange(value as SummaryPeriodPreset)}>
                    <SelectTrigger id="summary-period">
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
          </div>

          {summaryPaymentsQuery.isError ? (
            <QueryErrorNotice message="Não foi possível carregar o resumo financeiro. Os totais não estão disponíveis; tente novamente." onRetry={() => summaryPaymentsQuery.refetch()} />
          ) : summaryPaymentsQuery.isLoading ? (
            <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando resumo financeiro…</p>
          ) : summaryHasUnknownRefundAmount ? (
            <Alert className="border-warning/40 bg-warning-soft/30">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle>Valor de estorno parcial não informado</AlertTitle>
              <AlertDescription>Consulte as cobranças com estorno parcial na aba Pagamentos para atualizar os valores devolvidos. Os totais ficam indisponíveis até a conciliação desses registros.</AlertDescription>
            </Alert>
          ) : (
          <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Composição do valor confirmado">
            <MetricCard
              icon={CheckCircle2}
              label="Confirmados (bruto)"
              value={formatPrepaymentAmount(grossPaid)}
              detail={`${grossPaidCount} pagamento${grossPaidCount === 1 ? '' : 's'} confirmado${grossPaidCount === 1 ? '' : 's'}, antes das devoluções`}
            />
            <MetricCard
              icon={RefreshCw}
              label="Estornos realizados"
              value={`− ${formatPrepaymentAmount(chartTotals.refunded)}`}
              detail={`${chartTotals.refundedCount} pagamento${chartTotals.refundedCount === 1 ? '' : 's'} estornado${chartTotals.refundedCount === 1 ? '' : 's'}`}
            />
            <MetricCard
              icon={AlertTriangle}
              label="Chargebacks"
              value={`− ${formatPrepaymentAmount(chartTotals.chargeback)}`}
              detail={`${chartTotals.chargebackCount} ocorrência${chartTotals.chargebackCount === 1 ? '' : 's'}`}
            />
            <MetricCard
              icon={Banknote}
              label="Após devoluções"
              value={`= ${formatPrepaymentAmount(netRevenue)}`}
              detail="Confirmados menos estornos e chargebacks"
              result
            />
          </div>

          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="border-border shadow-card">
              <CardHeader>
                <CardTitle>Valores por dia</CardTitle>
                <CardDescription>
                  Cobranças por estado atual e última movimentação entre {summaryPeriodLabel}.
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
                <CardDescription>Posição atual das cobranças com movimentação entre {summaryPeriodLabel}.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <SummaryLine label="Valor bruto confirmado" value={formatPrepaymentAmount(grossPaid)} tone="success" />
                <SummaryLine label="Menos estornos" value={`− ${formatPrepaymentAmount(chartTotals.refunded)}`} tone="default" />
                <SummaryLine label="Menos chargebacks" value={`− ${formatPrepaymentAmount(chartTotals.chargeback)}`} tone="destructive" />
                <div className="border-t border-border pt-3">
                  <SummaryLine label="Após devoluções" value={`= ${formatPrepaymentAmount(netRevenue)}`} tone="success" />
                </div>
                <div className="border-t border-border pt-3">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">Em acompanhamento</p>
                <SummaryLine label="Estorno pendente" value={formatPrepaymentAmount(chartTotals.refundPending)} tone="warning" />
                </div>
                <SummaryLine label="Valor expirado" value={formatPrepaymentAmount(chartTotals.expired)} tone="destructive" />
                <SummaryLine label="Valor pendente" value={formatPrepaymentAmount(chartTotals.pending)} tone="warning" />
                <SummaryLine label="Valor cancelado" value={formatPrepaymentAmount(chartTotals.cancelled)} tone="default" />
                <p className="text-xs text-muted-foreground">Valores antes da liberação e das taxas. Este resumo não representa o saldo disponível para saque. Estornos pendentes só são descontados quando concluídos.</p>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer font-medium">Como o resumo é calculado</summary>
                  <p className="mt-2">O resumo considera a situação atual das cobranças. Mudanças de status podem alterar os valores de períodos anteriores. Cobranças antigas parceladas exigem conferência de todas as parcelas pela plataforma.</p>
                </details>
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
          </>
          )}
        </TabsContent>
        <TabsContent value="withdrawals" className="space-y-4">
          <CompanySettlements companyId={companyId} showOverview={false} />
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
              {bulkCheckPaymentsMutation.isPending ? 'Consultando pagamentos' : 'Consulta de pagamentos concluída'}
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
                  Aguardando a primeira resposta da consulta.
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
                        <p className="text-xs text-destructive">{paymentMessage(result.error)}</p>
                      )}
                      {!result.error && result.message && (
                        <p className="text-xs text-muted-foreground">{paymentMessage(result.message)}</p>
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
                ? `Será solicitado o estorno de ${formatPrepaymentAmount(pendingRefundPayment.amount)} para ${pendingRefundPayment.customer_name}. A conclusão será exibida após a confirmação do processamento.`
                : 'O estorno será solicitado. Acompanhe a confirmação do processamento nesta tela.'}
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
  result = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  result?: boolean;
}) {
  return (
    <Card className={result ? 'border-success/20 bg-success/5 shadow-none' : 'border-border shadow-none'}>
      <CardContent className="flex items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className={`my-2 truncate text-xl font-semibold tracking-tight tabular-nums ${result ? 'text-success' : 'text-foreground'}`}>{value}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
        </div>
        <Icon className={`h-4 w-4 shrink-0 ${result ? 'text-success' : 'text-muted-foreground/60'}`} />
      </CardContent>
    </Card>
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
  onCreateRule,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  rules: ReservationPaymentRuleDraft[];
  onToggleRule: (ruleId: string, enabled: boolean) => void;
  onRemoveOrArchiveRule: (ruleId: string) => void;
  onCloneRule: (ruleId: string) => void;
  onCreateRule?: () => void;
}) {
  return (
    <Card className="border-border shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rules.length === 0 ? (
          <div className="flex min-h-[230px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/15 px-5 py-10 text-center">
            <div className="mb-4 rounded-full border border-border bg-card p-3"><SlidersHorizontal className="h-5 w-5 text-muted-foreground" /></div>
            <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">{emptyDescription}</p>
            {onCreateRule && <Button variant="outline" className="mt-5 gap-2" onClick={onCreateRule}><Plus className="h-4 w-4" />Criar primeira regra</Button>}
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
            {rule.pricing_mode === 'by_section' && <Badge variant="outline" className="border-primary/25 bg-primary/5 text-primary">Por ambiente</Badge>}
            {rule.billing_types.map((billingType) => (
              <Badge key={billingType} variant="outline">{getBillingTypeLabel(billingType)}</Badge>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDateRange(rule.date_start, rule.date_end)} - {rule.pricing_mode === 'by_section' ? 'valores por ambiente' : `sinal ${formatPrepaymentAmount(rule.amount)}`} - {rule.payment_deadline_minutes} min para pagar
          </p>
          <p className="text-xs text-muted-foreground">{getRuleImpact(rule)}</p>
          {rule.pricing_mode === 'by_section' && (
            <ul className="grid gap-2 pt-1 sm:grid-cols-2" aria-label={`Ambientes de ${rule.name}`}>
              {rule.sections?.filter((section) => section.enabled).map((section) => (
                <li key={section.id} className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm">
                  <p className="font-medium">{section.public_name}</p>
                  {section.section_name && section.section_name !== section.public_name && <p className="mt-0.5 text-xs text-muted-foreground">{section.section_name}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{[
                    rule.pix_enabled && section.pix_amount != null ? `Pix ${formatPrepaymentAmount(section.pix_amount)}` : null,
                    rule.credit_card_enabled && section.credit_card_amount != null ? `Cartão ${formatPrepaymentAmount(section.credit_card_amount)}` : null,
                  ].filter(Boolean).join(' · ')} {rule.amount_type === 'per_person' ? 'por pessoa' : 'por reserva'}</p>
                </li>
              ))}
            </ul>
          )}
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
  const requiresLateReview = isLatePaidPayment(payment);
  const installmentReview = payment.metadata?.needs_manual_installment_reconciliation === true;
  const requiresManualAction = requiresLateReview || installmentReview;
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
          {payment.section_name && <p className="mt-1 text-sm font-medium text-foreground">{payment.section_name}</p>}
        </div>

        <div className="text-sm text-muted-foreground">
          {payment.party_size} pessoas
        </div>

        <div>
          <p className="text-sm font-medium text-foreground">{formatPrepaymentAmount(payment.amount)}</p>
          <p className="text-xs text-muted-foreground">
            {payment.billing_type ? getBillingTypeLabel(payment.billing_type) : 'Método não escolhido'}
            {payment.installments && payment.installments > 1 ? ` em até ${payment.installments}x` : ''}
            {payment.billing_type === 'CREDIT_CARD' && payment.installments === 1 ? ' à vista' : ''}
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
      {(payment.asaas_payment_id || payment.asaas_payment_link_id || payment.external_reference) && (
        <div className="mt-2 space-y-1 break-all text-xs text-muted-foreground">
          {payment.asaas_payment_id && <p>Identificador da cobrança: <span className="font-mono">{payment.asaas_payment_id}</span></p>}
          {!payment.asaas_payment_id && payment.asaas_payment_link_id && <p>Identificador do link de pagamento: <span className="font-mono">{payment.asaas_payment_link_id}</span></p>}
          {payment.external_reference && <p>Referência: <span className="font-mono">{payment.external_reference}</span></p>}
        </div>
      )}
      {requiresLateReview && (
        <div className="mt-2 rounded-md border border-warning/40 bg-background/80 px-3 py-2 text-xs font-medium text-warning">
          Pagamento recebido sem confirmação automática da reserva. Confira o cancelamento e a disponibilidade antes de reagendar ou estornar.
        </div>
      )}
      {installmentReview && (
        <div className="mt-2 rounded-md border border-warning/40 bg-background/80 px-3 py-2 text-xs font-medium text-warning">
          Parcelamento identificado. A plataforma precisa conferir todas as parcelas e os estornos; o valor confirmado da reserva não representa o saldo já liquidado. Para solicitar o estorno do parcelamento completo, entre em contato com o suporte.
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

function QueryErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Falha ao carregar dados</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Tentar novamente</Button>
      </AlertDescription>
    </Alert>
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
