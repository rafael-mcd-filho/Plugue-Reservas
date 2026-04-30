const PAID_UTM_MEDIUM_VALUES = new Set([
  'ads',
  'cpc',
  'cpm',
  'cpv',
  'paid',
  'paid-social',
  'paid_social',
  'ppc',
  'social_paid',
]);

export function normalizeTrackingTextValue(value: unknown) {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function getAttributionString(
  snapshot: Record<string, unknown> | null | undefined,
  key: string,
) {
  return normalizeTrackingTextValue(snapshot?.[key]);
}

export function isPaidTrafficMarker(utmMedium: string | null | undefined) {
  if (!utmMedium) return false;

  const normalizedMedium = utmMedium.trim().toLowerCase();
  if (PAID_UTM_MEDIUM_VALUES.has(normalizedMedium)) return true;
  return normalizedMedium.startsWith('paid');
}

export function hasMetaClickAttribution(params: {
  snapshot?: Record<string, unknown> | null;
  fbclid?: unknown;
  fbc?: unknown;
}) {
  return [
    getAttributionString(params.snapshot, 'fbclid'),
    getAttributionString(params.snapshot, 'fbc'),
    normalizeTrackingTextValue(params.fbclid),
    normalizeTrackingTextValue(params.fbc),
  ].some(Boolean);
}

export function hasPaidAttribution(
  snapshot: Record<string, unknown> | null | undefined,
) {
  return isPaidTrafficMarker(getAttributionString(snapshot, 'utm_medium'))
    || hasMetaClickAttribution({ snapshot });
}
