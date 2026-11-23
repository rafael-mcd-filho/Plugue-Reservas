import { supabase } from '@/integrations/supabase/client';

export type PublicReservationChangeReason = 'disabled' | 'payment' | 'cutoff' | 'status' | 'unavailable' | 'stale' | 'no_changes' | 'full' | 'party_size' | 'blocked' | 'message_processing';
export interface PublicReservationChangeSnapshot {
  id: string;
  date: string;
  time: string;
  party_size: number;
  updated_at: string;
}
export interface PublicReservationChangeSlot {
  time: string;
  available: boolean;
  reason: PublicReservationChangeReason | null;
  duration_minutes: number;
}
export interface PublicReservationChangeOptions {
  allowed: boolean;
  reason: PublicReservationChangeReason | null;
  revision: string;
  reservation: PublicReservationChangeSnapshot;
  min_notice_minutes: number;
  time_zone: string;
  server_now: string;
  date: string;
  party_size: number;
  max_party_size: number;
  slots: PublicReservationChangeSlot[];
}
export interface PublicReservationChangeResult {
  changed: boolean;
  replayed: boolean;
  reason: PublicReservationChangeReason | null;
  revision: string;
  reservation: PublicReservationChangeSnapshot;
}

const reasons = new Set<PublicReservationChangeReason>(['disabled', 'payment', 'cutoff', 'status', 'unavailable', 'stale', 'no_changes', 'full', 'party_size', 'blocked', 'message_processing']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const invalidResponse = () => new Error('Não foi possível consultar a alteração da reserva.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function reason(value: unknown): PublicReservationChangeReason | null {
  if (value === null) return null;
  if (typeof value === 'string' && reasons.has(value as PublicReservationChangeReason)) return value as PublicReservationChangeReason;
  throw invalidResponse();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidResponse();
  return value;
}
function snapshot(value: unknown, reservationId: string): PublicReservationChangeSnapshot {
  const row = object(value);
  if (row.id !== reservationId || typeof row.date !== 'string' || !datePattern.test(row.date)
    || typeof row.time !== 'string' || !timePattern.test(row.time)
    || !Number.isInteger(row.party_size) || Number(row.party_size) < 1) throw invalidResponse();
  return { id: reservationId, date: row.date, time: row.time, party_size: Number(row.party_size), updated_at: timestamp(row.updated_at) };
}
export function parsePublicReservationChangeOptions(value: unknown, reservationId: string): PublicReservationChangeOptions {
  const row = object(value);
  if (typeof row.allowed !== 'boolean' || typeof row.date !== 'string' || !datePattern.test(row.date)
    || !Number.isInteger(row.party_size) || !Number.isInteger(row.max_party_size)
    || Number(row.party_size) < 1 || Number(row.max_party_size) < 1
    || !Number.isInteger(row.min_notice_minutes) || Number(row.min_notice_minutes) < 0
    || typeof row.time_zone !== 'string' || !Array.isArray(row.slots)) throw invalidResponse();
  // Validate the time zone before using it to bound the date picker.
  try { new Intl.DateTimeFormat('en', { timeZone: row.time_zone }).format(); } catch { throw invalidResponse(); }
  const parsedReason = reason(row.reason);
  if (row.allowed && parsedReason !== null) throw invalidResponse();
  const slots = row.slots.map((value): PublicReservationChangeSlot => {
    const slot = object(value);
    if (typeof slot.time !== 'string' || !timePattern.test(slot.time) || typeof slot.available !== 'boolean'
      || !Number.isInteger(slot.duration_minutes) || Number(slot.duration_minutes) < 1) throw invalidResponse();
    const slotReason = reason(slot.reason);
    if (slot.available && slotReason !== null) throw invalidResponse();
    return { time: slot.time, available: slot.available, reason: slotReason, duration_minutes: Number(slot.duration_minutes) };
  });
  return {
    allowed: row.allowed, reason: parsedReason, revision: timestamp(row.revision),
    reservation: snapshot(row.reservation, reservationId), min_notice_minutes: Number(row.min_notice_minutes),
    time_zone: row.time_zone, server_now: timestamp(row.server_now), date: row.date,
    party_size: Number(row.party_size), max_party_size: Number(row.max_party_size), slots,
  };
}
export function parsePublicReservationChangeResult(value: unknown, reservationId: string): PublicReservationChangeResult {
  const row = object(value);
  if (typeof row.changed !== 'boolean' || typeof row.replayed !== 'boolean') throw invalidResponse();
  const parsedReason = reason(row.reason);
  if (row.changed && parsedReason !== null) throw invalidResponse();
  return { changed: row.changed, replayed: row.replayed, reason: parsedReason, revision: timestamp(row.revision), reservation: snapshot(row.reservation, reservationId) };
}

export async function getPublicReservationChangeOptions(input: { trackingCode: string; visitorId: string; reservationId: string; date: string; partySize: number }) {
  const { data, error } = await supabase.rpc('get_public_reservation_change_options' as never, {
    _tracking_code: input.trackingCode, _visitor_id: input.visitorId, _date: input.date, _party_size: input.partySize,
  } as never);
  if (error) throw error;
  const parsed = parsePublicReservationChangeOptions(data, input.reservationId);
  if (parsed.date !== input.date || parsed.party_size !== input.partySize) throw invalidResponse();
  return parsed;
}
export async function changePublicReservation(input: { trackingCode: string; visitorId: string; reservationId: string; date: string; time: string; partySize: number; revision: string; requestId: string }) {
  const { data, error } = await supabase.rpc('change_public_reservation' as never, {
    _tracking_code: input.trackingCode, _visitor_id: input.visitorId, _date: input.date,
    _time: input.time, _party_size: input.partySize, _expected_revision: input.revision, _request_id: input.requestId,
  } as never);
  if (error) throw error;
  return parsePublicReservationChangeResult(data, input.reservationId);
}

export function publicReservationChangeMessage(reason: PublicReservationChangeReason | null) {
  switch (reason) {
    case 'payment': return 'Alterações de reservas com pagamento são feitas pelo WhatsApp.';
    case 'cutoff': return 'O prazo para alterar pelo site terminou. Fale com a equipe pelo WhatsApp.';
    case 'status': return 'Esta reserva já não pode ser alterada pelo site.';
    case 'stale': return 'A reserva foi atualizada. Confira os dados e confirme novamente.';
    case 'full': return 'Este horário acabou de ficar sem vagas. Escolha outro horário.';
    case 'party_size': return 'A quantidade de pessoas não é permitida neste horário. Ajuste o grupo ou escolha outro horário.';
    case 'blocked': case 'unavailable': return 'Esta opção não está disponível. Escolha outra data ou horário.';
    case 'no_changes': return 'A reserva já está com esses dados.';
    case 'message_processing': return 'Uma mensagem desta reserva está sendo enviada. Aguarde um momento e tente novamente.';
    default: return 'Alterações de reserva são feitas de forma rápida pelo WhatsApp. Clique no botão abaixo para falar com o restaurante.';
  }
}

export function publicReservationChangeDateBounds(serverNow: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(serverNow));
  const value = (part: string) => parts.find(item => item.type === part)!.value;
  const min = `${value('year')}-${value('month')}-${value('day')}`;
  const maxDate = new Date(`${min}T12:00:00Z`);
  maxDate.setUTCDate(maxDate.getUTCDate() + 365);
  return { min, max: maxDate.toISOString().slice(0, 10) };
}
