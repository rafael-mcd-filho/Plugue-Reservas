import {
  getAttributionString,
  normalizeTrackingTextValue,
} from '@/lib/trackingAttribution';

export type ReservationOriginKey =
  | 'online'
  | 'affiliate'
  | 'manual'
  | 'waitlist';

export interface ReservationOriginAware {
  source?: string | null;
  origin_tracking_session_id?: string | null;
  origin_anonymous_id?: string | null;
  origin_affiliate_link_id?: string | null;
  attribution_snapshot?: Record<string, unknown> | null;
  tracking_session?: {
    utm_medium?: string | null;
    fbclid?: string | null;
    fbc?: string | null;
  } | null;
  session_utm_medium?: string | null;
  session_fbclid?: string | null;
  session_fbc?: string | null;
  origin_fbc?: string | null;
}

export const RESERVATION_ORIGIN_CONFIG: Record<ReservationOriginKey, { label: string; color: string }> = {
  online: {
    label: 'Online',
    color: 'hsl(202, 89%, 48%)',
  },
  affiliate: {
    label: 'Filiados e parceiros',
    color: 'hsl(145, 63%, 42%)',
  },
  manual: {
    label: 'Criada no painel',
    color: 'hsl(0, 0%, 35%)',
  },
  waitlist: {
    label: 'Convertida da fila',
    color: 'hsl(338, 78%, 55%)',
  },
};

export function normalizeReservationSource(source: string | null | undefined) {
  return source === 'waitlist' ? 'waitlist' : 'reservation';
}

export function isPublicReservation(reservation: ReservationOriginAware) {
  if (normalizeTrackingTextValue(reservation.origin_tracking_session_id)) return true;
  if (normalizeTrackingTextValue(reservation.origin_anonymous_id)) return true;
  return getAttributionString(reservation.attribution_snapshot, 'tracking_source') === 'public_web';
}

export function classifyReservationOrigin(reservation: ReservationOriginAware): ReservationOriginKey {
  if (normalizeReservationSource(reservation.source) === 'waitlist') {
    return 'waitlist';
  }

  if (normalizeTrackingTextValue(reservation.origin_affiliate_link_id)) {
    return 'affiliate';
  }

  if (isPublicReservation(reservation)) {
    return 'online';
  }

  return 'manual';
}
