import { normalizeReservationStatus } from '@/lib/reservation-status';
import { normalizePhoneDigits } from '@/lib/validation';
import { normalizeStoredPhoneE164, toStoredWhatsAppNumber } from '@/lib/phone';

export type CanonicalLeadVisitOrigin = 'reservation' | 'waitlist';

interface CanonicalLeadPresenceInput {
  status: string | null | undefined;
  visitOrigin: CanonicalLeadVisitOrigin;
}

export interface CanonicalLeadPresenceEventInput extends CanonicalLeadPresenceInput {
  visitId: string;
}

interface CanonicalLeadPresenceRecord {
  status: string | null | undefined;
  visit_id: string;
  visit_origin: CanonicalLeadVisitOrigin;
}

interface ReservationWaitlistLink {
  origin_waitlist_id: string | null | undefined;
  status: string | null | undefined;
}

/**
 * Mirrors public.normalize_whatsapp_phone, which is also used by the
 * recurrence report to identify a customer.
 */
export function normalizeLeadPhoneKey(value: string | null | undefined) {
  return toStoredWhatsAppNumber(value);
}

/** Reactivation RPC phone_normalized is already a full international identity. */
export function getLeadReactivationPhone(candidate: {
  guest_phone?: string | null;
  guest_phone_e164?: string | null;
  phone_normalized?: string | null;
}) {
  return normalizeStoredPhoneE164(candidate.guest_phone_e164)
    || (candidate.phone_normalized ? normalizeStoredPhoneE164(`+${normalizePhoneDigits(candidate.phone_normalized)}`) : '')
    || normalizeStoredPhoneE164(candidate.guest_phone);
}

export function matchesLeadPhoneDigits(
  phone: string | null | undefined,
  searchDigits: string | null | undefined,
) {
  const normalizedPhone = normalizePhoneDigits(phone);
  const normalizedSearch = normalizePhoneDigits(searchDigits);

  if (!normalizedSearch) return false;

  return normalizedPhone.includes(normalizedSearch)
    || normalizeLeadPhoneKey(phone).includes(normalizedSearch);
}

export function countsAsCanonicalLeadPresence({
  status,
  visitOrigin,
}: CanonicalLeadPresenceInput) {
  if (visitOrigin === 'waitlist') {
    return status?.trim().toLowerCase() === 'seated';
  }

  return normalizeReservationStatus(status) === 'checked_in';
}

export function getCanonicalLeadPresenceEventKey(input: CanonicalLeadPresenceEventInput) {
  if (!countsAsCanonicalLeadPresence(input)) return null;

  return `${input.visitOrigin}:${input.visitId}`;
}

export function shouldIncludeCanonicalLeadVisit(
  visitOrigin: CanonicalLeadVisitOrigin,
  visitId: string,
  linkedWaitlistIds: ReadonlySet<string>,
) {
  return visitOrigin !== 'waitlist' || !linkedWaitlistIds.has(visitId);
}

export function getPresenceLinkedWaitlistIds<T extends ReservationWaitlistLink>(reservations: T[]) {
  const waitlistIds = new Set<string>();

  for (const reservation of reservations) {
    if (
      reservation.origin_waitlist_id
      && countsAsCanonicalLeadPresence({
        status: reservation.status,
        visitOrigin: 'reservation',
      })
    ) {
      waitlistIds.add(reservation.origin_waitlist_id);
    }
  }

  return waitlistIds;
}

export function selectCanonicalLeadPresenceEvents<T extends CanonicalLeadPresenceRecord>(visits: T[]) {
  const eventKeys = new Set<string>();

  return visits.filter((visit) => {
    const eventKey = getCanonicalLeadPresenceEventKey({
      visitId: visit.visit_id,
      status: visit.status,
      visitOrigin: visit.visit_origin,
    });

    if (!eventKey || eventKeys.has(eventKey)) return false;

    eventKeys.add(eventKey);
    return true;
  });
}
