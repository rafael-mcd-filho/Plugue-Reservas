import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReservationPaymentStatus } from '@/lib/asaas-prepayment-contracts';
import { fetchAllSupabasePages } from '@/lib/supabase-pagination';

const PAYMENT_COLUMNS = 'id, reservation_id, status, billing_type, max_installments, base_amount, charged_amount, rule_snapshot, payment_token, asaas_payment_id, asaas_payment_link_id, payment_link_external_reference, expires_at, paid_at, cancelled_at, metadata, created_at, reservation:reservations!reservation_payments_reservation_id_fkey(id, guest_name, guest_phone, status, date, time, party_size)';
// The generated database types do not include the prepayment migration yet.
const prepaymentDatabase = supabase as unknown as SupabaseClient;

export interface ReservationPaymentQueryOptions {
  companyId: string;
  from: Date;
  to: Date;
  status?: 'all' | ReservationPaymentStatus;
}

/** Read every server page before computing totals, searching or paginating the UI. */
export async function fetchCompanyReservationPayments({ companyId, from, to, status = 'all' }: ReservationPaymentQueryOptions) {
  if (!companyId) throw new Error('Empresa não identificada.');
  const startIso = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0).toISOString();
  const endIso = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).toISOString();
  const rangeFilter = ['created_at', 'paid_at', 'cancelled_at', 'expires_at']
    .map((column) => `and(${column}.gte.${startIso},${column}.lte.${endIso})`)
    .join(',');

  return fetchAllSupabasePages<Record<string, unknown>>((pageFrom, pageTo) => {
    let query = prepaymentDatabase
      .from('reservation_payments')
      .select(PAYMENT_COLUMNS)
      .eq('company_id', companyId)
      .or(rangeFilter)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (status === 'pending') {
      query = query.in('status', ['pending', 'awaiting_method']);
    } else if (status !== 'all') {
      query = query.eq('status', status);
    }

    return query.range(pageFrom, pageTo);
  });
}

export async function fetchCompanyReservationPaymentUsage(companyId: string, ruleIds: string[]) {
  if (!companyId) throw new Error('Empresa não identificada.');
  if (ruleIds.length === 0) return [];
  return fetchAllSupabasePages<{ rule_id: string | null }>((from, to) => prepaymentDatabase
    .from('reservation_payments')
    .select('id, rule_id')
    .eq('company_id', companyId)
    .in('rule_id', ruleIds)
    .order('id', { ascending: true })
    .range(from, to));
}
