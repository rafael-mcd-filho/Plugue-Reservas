import { toBrazilWhatsAppNumber } from '@/lib/validation';

export const LARGE_PARTY_SIZE = 10;
export const LARGE_PARTY_WHATSAPP_MESSAGE = 'Oi, vim pelo site e preciso de uma reserva a partir de {threshold} pessoas';
export const DEFAULT_RESERVATION_LATE_TOLERANCE_MINUTES = 10;

export function normalizeLargePartyThreshold(value: number | null | undefined) {
  if (value === null || value === undefined) return LARGE_PARTY_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return LARGE_PARTY_SIZE;
  return Math.max(2, Math.min(20, Math.round(parsed)));
}

export function isLargePartyReservation(partySize: number, threshold = LARGE_PARTY_SIZE) {
  return partySize >= normalizeLargePartyThreshold(threshold);
}

export function buildLargePartyWhatsappUrl(companyWhatsapp: string | null | undefined, threshold = LARGE_PARTY_SIZE) {
  const whatsappNumber = toBrazilWhatsAppNumber(companyWhatsapp);
  if (!whatsappNumber) {
    return null;
  }

  const message = LARGE_PARTY_WHATSAPP_MESSAGE.replace('{threshold}', String(normalizeLargePartyThreshold(threshold)));
  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
}

export function normalizeReservationLateToleranceMinutes(value: number | null | undefined) {
  if (value === null || value === undefined) return DEFAULT_RESERVATION_LATE_TOLERANCE_MINUTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RESERVATION_LATE_TOLERANCE_MINUTES;
  return Math.max(0, Math.min(120, Math.round(parsed)));
}
