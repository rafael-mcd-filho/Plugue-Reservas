export const RESERVATION_PREPAYMENT_FEATURE_KEY = 'reservation_prepayment' as const;

export type ReservationPrepaymentAmountType = 'fixed_per_reservation' | 'per_person';
export type ReservationPrepaymentBillingType = 'PIX' | 'CREDIT_CARD';
export type AsaasConfigStatus = 'not_configured' | 'configured' | 'error';

export type ReservationPaymentStatus =
  | 'awaiting_method'
  | 'pending'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'late_paid'
  | 'refunded';

export interface AsaasCompanyConfigPreview {
  status: AsaasConfigStatus;
  fromCompanyAccount: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
}

export interface ReservationPaymentRuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  date_start: string;
  date_end: string;
  amount_type: ReservationPrepaymentAmountType;
  amount: number;
  pix_enabled: boolean;
  pix_amount: number | null;
  credit_card_enabled: boolean;
  credit_card_amount: number | null;
  max_credit_card_installments: number | null;
  payment_deadline_minutes: number;
  billing_types: ReservationPrepaymentBillingType[];
  customer_notice: string;
  cancellation_policy: string;
  usage_count: number;
  created_by: string | null;
  activated_at: string | null;
  archived_at: string | null;
  archived_by: string | null;
  archived_reason: string | null;
}

export interface CreateReservationPaymentRequest {
  company_id: string;
  reservation: {
    id?: string;
    table_id: string | null;
    table_map_id: string | null;
    guest_name: string;
    guest_phone: string;
    guest_email: string | null;
    guest_birthdate: string | null;
    date: string;
    time: string;
    party_size: number;
    duration_minutes: number;
    occasion: string | null;
    notes: string | null;
    public_tracking_code: string;
    visitor_id: string | null;
    origin_tracking_session_id?: string | null;
    origin_tracking_journey_id?: string | null;
    origin_anonymous_id?: string | null;
    origin_affiliate_link_id?: string | null;
    origin_affiliate_code?: string | null;
    origin_affiliate_name?: string | null;
    origin_fbp?: string | null;
    origin_fbc?: string | null;
    attribution_snapshot?: Record<string, unknown>;
  };
}

export type CreateReservationPaymentResponse = {
  requires_payment: boolean;
  reason?: 'feature_disabled' | 'no_rule';
  reservation_id?: string;
  payment_token?: string;
  payment_url?: string;
  expires_at?: string;
  status?: ReservationPaymentStatus;
};

export interface SelectReservationPaymentMethodRequest {
  payment_token: string;
  billing_type: ReservationPrepaymentBillingType;
}

export interface PublicReservationPaymentSummary {
  payment_token: string;
  status: ReservationPaymentStatus;
  amount: number;
  base_amount: number;
  pix_amount: number | null;
  credit_card_amount: number | null;
  max_credit_card_installments: number | null;
  billing_type: ReservationPrepaymentBillingType | null;
  available_billing_types: ReservationPrepaymentBillingType[];
  expires_at: string;
  paid_at: string | null;
  payment_link_url: string | null;
  payment_link_external_reference: string | null;
  pix_qr_code_base64: string | null;
  pix_copy_paste: string | null;
  rule_name: string;
  customer_notice: string | null;
  cancellation_policy: string | null;
  reservation: {
    guest_name: string;
    date: string;
    time: string;
    party_size: number;
    status: string;
    public_tracking_code: string | null;
  };
  company: {
    name: string;
    logo_url: string | null;
    slug: string | null;
    phone: string | null;
    whatsapp: string | null;
  };
}

export const DEFAULT_ASAAS_CONFIG_PREVIEW: AsaasCompanyConfigPreview = {
  status: 'not_configured',
  fromCompanyAccount: true,
  lastValidatedAt: null,
  lastError: null,
};

export function formatPrepaymentAmount(amount: number) {
  return amount.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  });
}

export function calculateReservationPaymentAmount(rule: Pick<ReservationPaymentRuleDraft, 'amount' | 'amount_type'>, partySize: number) {
  return rule.amount_type === 'per_person'
    ? rule.amount * Math.max(partySize, 1)
    : rule.amount;
}

export function getAmountTypeLabel(amountType: ReservationPrepaymentAmountType) {
  return amountType === 'per_person' ? 'Por pessoa' : 'Por reserva';
}

export function getBillingTypeLabel(billingType: ReservationPrepaymentBillingType) {
  return billingType === 'CREDIT_CARD' ? 'Cartão' : 'Pix';
}

export function getPaymentStatusLabel(status: ReservationPaymentStatus) {
  const labels: Record<ReservationPaymentStatus, string> = {
    awaiting_method: 'Aguardando método',
    pending: 'Aguardando pagamento',
    paid: 'Pago',
    expired: 'Expirado',
    cancelled: 'Cancelado',
    failed: 'Falhou',
    late_paid: 'Pago após expirar',
    refunded: 'Estornado',
  };

  return labels[status];
}
