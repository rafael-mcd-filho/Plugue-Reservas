import {
  getAttributionString,
  hasMetaClickAttribution,
  isPaidTrafficMarker,
  normalizeTrackingTextValue,
} from '@/lib/trackingAttribution';

export type ReservationOriginKey =
  | 'direct_organic'
  | 'ads'
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
  direct_organic: {
    label: 'Direta/Orgânica',
    color: 'hsl(202, 89%, 48%)',
  },
  ads: {
    label: 'Ads',
    color: 'hsl(28, 85%, 55%)',
  },
  affiliate: {
    label: 'Filiado',
    color: 'hsl(145, 63%, 42%)',
  },
  manual: {
    label: 'Manual',
    color: 'hsl(0, 0%, 35%)',
  },
  waitlist: {
    label: 'Fila de Espera',
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

export function getReservationPaidAttributionMedium(reservation: ReservationOriginAware) {
  return getAttributionString(reservation.attribution_snapshot, 'utm_medium')
    ?? normalizeTrackingTextValue(reservation.tracking_session?.utm_medium)
    ?? normalizeTrackingTextValue(reservation.session_utm_medium)
    ?? null;
}

export function hasReservationMetaClickAttribution(reservation: ReservationOriginAware) {
  return hasMetaClickAttribution({
    snapshot: reservation.attribution_snapshot,
    fbclid: normalizeTrackingTextValue(reservation.tracking_session?.fbclid)
      ?? normalizeTrackingTextValue(reservation.session_fbclid),
    fbc: normalizeTrackingTextValue(reservation.origin_fbc)
      ?? normalizeTrackingTextValue(reservation.tracking_session?.fbc)
      ?? normalizeTrackingTextValue(reservation.session_fbc),
  });
}

export function classifyReservationOrigin(reservation: ReservationOriginAware): ReservationOriginKey {
  if (normalizeReservationSource(reservation.source) === 'waitlist') {
    return 'waitlist';
  }

  if (!isPublicReservation(reservation)) {
    return 'manual';
  }

  if (normalizeTrackingTextValue(reservation.origin_affiliate_link_id)) {
    return 'affiliate';
  }

  const utmMedium = getReservationPaidAttributionMedium(reservation);
  if (isPaidTrafficMarker(utmMedium) || hasReservationMetaClickAttribution(reservation)) {
    return 'ads';
  }

  return 'direct_organic';
}
