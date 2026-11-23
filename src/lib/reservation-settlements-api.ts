import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';

export type WithdrawalStatus =
  | 'requested'
  | 'under_review'
  | 'processing'
  | 'paid'
  | 'rejected'
  | 'cancelled';
export interface SettlementTerms {
  id: string;
  company_id: string;
  fee_bps: number;
  pix_fee_bps?: number | null;
  credit_card_fee_bps?: number | null;
  release_policy: 'after_reservation' | 'on_settlement';
  hold_days: number;
  effective_at: string;
  enabled: boolean;
  created_at: string;
}
export interface PayoutDestination {
  id?: string;
  company_id?: string;
  kind: 'pix' | 'bank';
  holder_name: string;
  holder_document: string;
  pix_key_type?: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';
  pix_key?: string;
  bank_code?: string;
  bank_name?: string;
  agency?: string;
  branch?: string;
  account_number?: string;
  account_type?: 'checking' | 'savings';
}
export interface Withdrawal {
  id: string;
  company_id: string;
  company_name?: string;
  amount_cents: number;
  status: WithdrawalStatus;
  destination_snapshot: PayoutDestination;
  receipt_path: string | null;
  bank_reference: string | null;
  paid_at: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface SettlementEntry {
  id: string;
  entry_type: string;
  created_at: string;
  description?: string;
  payment_id?: string;
  available_delta_cents: number;
  pending_delta_cents: number;
  reserved_delta_cents: number;
  blocked_delta_cents?: number;
  paid_delta_cents: number;
  fee_delta_cents?: number;
  gross_delta_cents?: number;
}
export interface SettlementOverview {
  company_id: string;
  terms: SettlementTerms | null;
  pending_cents: number;
  available_cents: number;
  reserved_cents: number;
  paid_cents: number;
  blocked_cents: number;
  fee_cents: number;
  provider_cost_cents?: number;
  gross_cents: number;
  refunded_cents: number;
  chargeback_cents: number;
  merchant_net_cents: number;
  attention_count?: number;
  terms_history?: SettlementTerms[];
  destination: PayoutDestination | null;
  withdrawals: Withdrawal[];
  ledger: SettlementEntry[];
  withdrawal_count: number;
  ledger_count: number;
}
export interface AdminSettlementOverview {
  companies: Array<
    Omit<
      SettlementOverview,
      | 'destination'
      | 'withdrawals'
      | 'ledger'
      | 'withdrawal_count'
      | 'ledger_count'
    > & { id: string; name: string }
  >;
  withdrawals: Withdrawal[];
  total: number;
  company_count: number;
  company_offset: number;
  company_limit: number;
}
// Postgres bigint values may arrive as strings. Reject an unrepresentable
// amount rather than round it or render an incorrect available balance.
export function normalizeSettlementAmounts<T>(input: T): T {
  if (Array.isArray(input))
    return input.map((value) => normalizeSettlementAmounts(value)) as T;
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (key.endsWith('_cents')) {
        const amount =
          typeof value === 'string' && /^-?\d+$/.test(value)
            ? Number(value)
            : value;
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount))
          throw new Error(
            'Valor financeiro inválido. Atualize os dados ou entre em contato com a plataforma.',
          );
        return [key, amount];
      }
      return [key, normalizeSettlementAmounts(value)];
    }),
  ) as T;
}
export async function settlementRequest<T>(
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<
    T & { error?: string }
  >('manage-reservation-settlements', { body });
  if (error || !data || data.error) {
    throw new Error(
      error
        ? await getFunctionErrorMessage(error)
        : data?.error || 'Não foi possível concluir a operação financeira.',
    );
  }
  return normalizeSettlementAmounts(data);
}
export const getSettlementOverview = (companyId: string, offset = 0) =>
  settlementRequest<SettlementOverview>({
    action: 'overview',
    company_id: companyId,
    offset,
    limit: 25,
  });
export const getAdminSettlementOverview = (
  status = 'all',
  offset = 0,
  companyOffset = 0,
  options: { limit?: number; companyLimit?: number } = {},
) =>
  settlementRequest<AdminSettlementOverview>({
    action: 'admin_overview',
    ...(status !== 'all' ? { status } : {}),
    offset,
    limit: options.limit ?? 25,
    company_offset: companyOffset,
    company_limit: options.companyLimit ?? 25,
  });
export const savePayoutDestination = (
  companyId: string,
  destination: PayoutDestination,
) =>
  settlementRequest<PayoutDestination>({
    action: 'save_destination',
    company_id: companyId,
    destination,
  });
export const requestWithdrawal = (
  companyId: string,
  amountCents: number,
  idempotencyKey: string,
) =>
  settlementRequest<Withdrawal>({
    action: 'request_withdrawal',
    company_id: companyId,
    amount: (amountCents / 100).toFixed(2),
    idempotency_key: idempotencyKey,
  });
export const cancelWithdrawal = (companyId: string, withdrawalId: string) =>
  settlementRequest<Withdrawal>({
    action: 'cancel_withdrawal',
    company_id: companyId,
    withdrawal_id: withdrawalId,
  });
export interface SaveSettlementTermsInput {
  company_id: string;
  pix_fee_bps: number;
  credit_card_fee_bps: number;
  release_policy: SettlementTerms['release_policy'];
  hold_days: number;
  effective_at: string | null;
  enabled: boolean;
}
export const saveSettlementTerms = (input: SaveSettlementTermsInput) =>
  settlementRequest<SettlementTerms>({ action: 'save_terms', ...input });
export const transitionWithdrawal = (
  withdrawalId: string,
  status: WithdrawalStatus,
  details: {
    reason?: string;
    receipt_path?: string;
    bank_reference?: string;
    paid_at?: string;
  } = {},
) =>
  settlementRequest<Withdrawal>({
    action: 'transition_withdrawal',
    withdrawal_id: withdrawalId,
    status,
    ...details,
  });
export const downloadWithdrawalReceipt = (
  companyId: string,
  withdrawalId: string,
) =>
  settlementRequest<{ signed_url: string }>({
    action: 'download_receipt',
    company_id: companyId,
    withdrawal_id: withdrawalId,
  });
export async function uploadWithdrawalReceipt(
  withdrawalId: string,
  file: File,
) {
  if (
    !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type) ||
    file.size <= 0 ||
    file.size > 5 * 1024 * 1024
  ) {
    throw new Error('Selecione um comprovante PDF, PNG ou JPEG de até 5 MB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return settlementRequest<{ receipt_path: string }>({
    action: 'upload_receipt',
    withdrawal_id: withdrawalId,
    filename: file.name,
    mime_type: file.type,
    content_base64: btoa(binary),
  });
}
export function parseSettlementMoney(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, decimals = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export const formatSettlementMoney = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    (cents === 0 ? 0 : cents) / 100,
  );
export const formatSettlementRate = (bps: number) =>
  `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(bps / 100)}%`;
export function getSettlementMethodFees(
  terms: Pick<SettlementTerms, 'fee_bps' | 'pix_fee_bps' | 'credit_card_fee_bps'>,
) {
  return {
    pix: terms.pix_fee_bps ?? terms.fee_bps,
    creditCard: terms.credit_card_fee_bps ?? terms.fee_bps,
  };
}
export function formatSettlementTermsRates(
  terms: Pick<SettlementTerms, 'fee_bps' | 'pix_fee_bps' | 'credit_card_fee_bps'>,
) {
  const fees = getSettlementMethodFees(terms);
  return `Pix ${formatSettlementRate(fees.pix)} · Cartão ${formatSettlementRate(fees.creditCard)}`;
}
export function parseSettlementRate(value: string): number | null {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 10000 ? bps : null;
}
export const withdrawalStatusLabels: Record<WithdrawalStatus, string> = {
  requested: 'Solicitado',
  under_review: 'Em análise',
  processing: 'Em pagamento',
  paid: 'Pago',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
};
export function describePayoutDestination(destination: PayoutDestination) {
  if (destination.kind === 'pix') {
    const types: Record<string, string> = {
      cpf: 'CPF',
      cnpj: 'CNPJ',
      email: 'E-mail',
      phone: 'Telefone',
      random: 'Chave aleatória',
    };
    return `Pix · ${types[destination.pix_key_type ?? ''] ?? ''} · ${destination.pix_key ?? ''}`;
  }
  return `Banco ${destination.bank_code ?? ''} · Ag. ${destination.agency ?? destination.branch ?? ''} · Conta ${destination.account_number ?? ''}`;
}
export function maskedPayoutDestination(destination: PayoutDestination) {
  const value =
    destination.kind === 'pix'
      ? destination.pix_key
      : destination.account_number;
  return `${destination.kind === 'pix' ? 'Pix' : 'Conta bancária'} · final ${value?.slice(-4) ?? '••••'}`;
}
export function settlementEntryLabel(entry: SettlementEntry) {
  const labels: Record<string, string> = {
    withdrawal_requested: 'Saldo reservado para saque',
    withdrawal_paid: 'Repasse realizado',
    withdrawal_released: 'Reserva de saque devolvida ao saldo',
  };
  if (labels[entry.entry_type]) return labels[entry.entry_type];
  if (entry.entry_type === 'payment_position') {
    if (Number(entry.blocked_delta_cents ?? 0) > 0)
      return 'Valor em conferência';
    if (entry.available_delta_cents > 0 && entry.pending_delta_cents < 0)
      return 'Saldo de reserva liberado';
    if (Number(entry.fee_delta_cents ?? 0) < 0)
      return 'Devolução ou ajuste de recebimento';
    return 'Recebimento de reserva';
  }
  return 'Movimentação financeira';
}
