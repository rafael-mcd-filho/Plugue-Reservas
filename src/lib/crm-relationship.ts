import { supabase } from '@/integrations/supabase/client';
import { getReservationStatusLabel } from '@/lib/reservation-status';

export type CrmRelationshipSection = 'summary' | 'reservations' | 'payments' | 'messages';
export interface CrmRelationshipCapabilities { reservations: boolean; payments: boolean; messages: boolean }
export interface CrmRelationshipSummary {
  upcoming_count: number | null;
  reservation_count: number | null;
  cancelled_count: number | null;
  no_show_count: number | null;
}
export interface CrmRelationshipReservation {
  id: string; date: string; time: string; party_size: number; status: string;
  source: string | null; occasion: string | null; is_upcoming: boolean;
  relationship_role: 'holder' | 'companion'; holder_name: string | null;
}
export interface CrmRelationshipPayment {
  id: string; reservation_id: string; reservation_date: string; reservation_time: string;
  status: string; billing_type: string | null; base_amount: number | null;
  charged_amount: number | null; paid_at: string | null; created_at: string; refunded_at: string | null;
}
export interface CrmRelationshipMessage {
  id: string; channel: 'evolution' | 'pluguechat_official'; type: string; status: string;
  created_at: string; reservation_id: string | null; record_source: 'log';
  provider_status: string | null; message_preview: string | null;
}
export type CrmRelationshipRow = CrmRelationshipReservation | CrmRelationshipPayment | CrmRelationshipMessage;
export interface CrmRelationshipPage {
  company_id: string; customer_key: string; section: CrmRelationshipSection;
  page: number; page_size: number; total: number; rows: CrmRelationshipRow[];
  capabilities: CrmRelationshipCapabilities; summary: CrmRelationshipSummary;
}
export interface CrmRelationshipRequest {
  companyId: string; customerKey: string; section: CrmRelationshipSection;
  page?: number; pageSize?: number; signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is string => isString(value) && value.length > 0;
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isNullableAmount = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const isDate = (value: unknown): value is string => {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const isTime = (value: unknown): value is string => isString(value) && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(value);
const isTimestamp = (value: unknown): value is string => isString(value) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const isNullableTimestamp = (value: unknown) => value === null || isTimestamp(value);
const invalidResponse = () => new Error('Não foi possível carregar o relacionamento deste cliente.');

function reservationRow(value: unknown): CrmRelationshipReservation {
  if (!isRecord(value) || !isId(value.id) || !isDate(value.date) || !isTime(value.time)
    || !isInteger(value.party_size) || !isId(value.status) || !isNullableString(value.source)
    || !isNullableString(value.occasion) || typeof value.is_upcoming !== 'boolean'
    || !['holder', 'companion'].includes(String(value.relationship_role)) || !isNullableString(value.holder_name)) throw invalidResponse();
  return {
    id: value.id, date: value.date, time: value.time, party_size: value.party_size, status: value.status,
    source: value.source, occasion: value.occasion, is_upcoming: value.is_upcoming,
    relationship_role: value.relationship_role as CrmRelationshipReservation['relationship_role'], holder_name: value.holder_name,
  };
}

function paymentRow(value: unknown): CrmRelationshipPayment {
  if (!isRecord(value) || !isId(value.id) || !isId(value.reservation_id) || !isDate(value.reservation_date)
    || !isTime(value.reservation_time) || !isId(value.status) || !isNullableString(value.billing_type)
    || !isNullableAmount(value.base_amount) || !isNullableAmount(value.charged_amount)
    || !isNullableTimestamp(value.paid_at) || !isTimestamp(value.created_at)
    || !isNullableTimestamp(value.refunded_at)) throw invalidResponse();
  return {
    id: value.id, reservation_id: value.reservation_id, reservation_date: value.reservation_date,
    reservation_time: value.reservation_time, status: value.status, billing_type: value.billing_type,
    base_amount: value.base_amount, charged_amount: value.charged_amount,
    paid_at: value.paid_at as string | null, created_at: value.created_at, refunded_at: value.refunded_at as string | null,
  };
}

function messageRow(value: unknown): CrmRelationshipMessage {
  if (!isRecord(value) || !isId(value.id) || !['evolution', 'pluguechat_official'].includes(String(value.channel))
    || !isId(value.type) || !isId(value.status) || !isTimestamp(value.created_at)
    || !isNullableString(value.reservation_id) || value.record_source !== 'log'
    || !isNullableString(value.provider_status) || !isNullableString(value.message_preview)) throw invalidResponse();
  return {
    id: value.id, channel: value.channel as CrmRelationshipMessage['channel'], type: value.type,
    status: value.status, created_at: value.created_at, reservation_id: value.reservation_id,
    record_source: 'log', provider_status: value.provider_status, message_preview: value.message_preview,
  };
}

export function parseCrmRelationshipPage(value: unknown, request: Pick<CrmRelationshipRequest, 'companyId' | 'customerKey' | 'section'>): CrmRelationshipPage {
  if (!isRecord(value) || value.company_id !== request.companyId || value.customer_key !== request.customerKey
    || value.section !== request.section || !isInteger(value.page) || value.page < 1
    || !isInteger(value.page_size) || value.page_size < 1 || value.page_size > 100
    || !isInteger(value.total) || !Array.isArray(value.rows) || value.rows.length > value.page_size
    || !isRecord(value.capabilities) || !isRecord(value.summary)) throw invalidResponse();
  const capabilities = value.capabilities;
  for (const field of ['reservations', 'payments', 'messages']) if (typeof capabilities[field] !== 'boolean') throw invalidResponse();
  for (const field of ['upcoming_count', 'reservation_count', 'cancelled_count', 'no_show_count']) {
    if (value.summary[field] !== null && !isInteger(value.summary[field])) throw invalidResponse();
  }
  if ((request.section !== 'summary' && !capabilities[request.section])
    || (request.section === 'summary' && (value.rows.length !== 0 || value.total !== 0))) throw invalidResponse();
  const rows = value.rows.map((row) => request.section === 'reservations' ? reservationRow(row) : request.section === 'payments' ? paymentRow(row) : messageRow(row));
  if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.length > value.total) throw invalidResponse();
  const expectedPages = Math.max(1, Math.ceil(value.total / value.page_size));
  const expectedRows = Math.max(0, Math.min(value.page_size, value.total - (value.page - 1) * value.page_size));
  if (value.page > expectedPages || rows.length !== expectedRows) throw invalidResponse();
  return {
    company_id: request.companyId, customer_key: request.customerKey, section: request.section,
    page: value.page, page_size: value.page_size, total: value.total, rows,
    capabilities: capabilities as unknown as CrmRelationshipCapabilities,
    summary: value.summary as unknown as CrmRelationshipSummary,
  };
}

export async function getCrmRelationshipPage(request: CrmRelationshipRequest): Promise<CrmRelationshipPage> {
  if (!request.companyId || !request.customerKey) throw invalidResponse();
  if (request.signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const query = supabase.rpc('get_company_crm_relationship' as never, {
    _company_id: request.companyId, _customer_key: request.customerKey, _section: request.section,
    _page: Math.max(1, Math.floor(request.page ?? 1)), _page_size: Math.min(100, Math.max(1, Math.floor(request.pageSize ?? 25))),
  } as never);
  const { data, error } = await (request.signal ? query.abortSignal(request.signal) : query);
  if (request.signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) throw invalidResponse();
  return parseCrmRelationshipPage(data, request);
}

export function getCrmMessageStatusLabel(message: Pick<CrmRelationshipMessage, 'channel' | 'status' | 'provider_status'>) {
  const provider = message.provider_status?.toUpperCase();
  if (provider === 'READ') return 'Leitura registrada';
  if (['DELIVERED', 'DELIVERY_ACK'].includes(provider ?? '')) return 'Entrega registrada';
  if (['failed', 'error'].includes(message.status)) return 'Falhou';
  if (message.status === 'sent') return 'Enviada';
  if (message.status === 'pending' && message.channel === 'evolution') return 'Aceita pelo canal';
  if (['expired', 'cancelled', 'canceled'].includes(message.status)) return 'Encerrada';
  return 'Registrada';
}

export function getCrmReservationStatusLabel(status: string) {
  return ['confirmed', 'pending', 'checked_in', 'completed', 'cancelled', 'no_show', 'no-show', 'pending_payment', 'payment_expired', 'payment_cancelled', 'paid_after_expiration'].includes(status.trim().toLowerCase())
    ? getReservationStatusLabel(status)
    : 'Estado não reconhecido';
}
