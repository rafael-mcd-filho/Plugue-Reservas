import { describe, expect, it } from 'vitest';
import { hasMetaClickAttribution, hasPaidAttribution, isPaidTrafficMarker } from '@/lib/trackingAttribution';

describe('trackingAttribution', () => {
  it('detects explicit paid utm_medium markers', () => {
    expect(isPaidTrafficMarker('cpc')).toBe(true);
    expect(isPaidTrafficMarker('paid_social')).toBe(true);
    expect(isPaidTrafficMarker('Paid-Search')).toBe(true);
  });

  it('ignores organic or empty utm_medium values', () => {
    expect(isPaidTrafficMarker('organic')).toBe(false);
    expect(isPaidTrafficMarker('referral')).toBe(false);
    expect(isPaidTrafficMarker(null)).toBe(false);
  });

  it('detects paid attribution from reservation snapshots', () => {
    expect(hasPaidAttribution({ utm_medium: 'ppc' })).toBe(true);
    expect(hasPaidAttribution({ fbclid: 'fb-click-id' })).toBe(true);
    expect(hasPaidAttribution({ fbc: 'fb.1.123.fb-click-id' })).toBe(true);
    expect(hasPaidAttribution({ utm_medium: 'email' })).toBe(false);
    expect(hasPaidAttribution(null)).toBe(false);
  });

  it('detects Meta click attribution without treating fbp alone as paid', () => {
    expect(hasMetaClickAttribution({ snapshot: { fbclid: 'fb-click-id' } })).toBe(true);
    expect(hasMetaClickAttribution({ snapshot: { fbc: 'fb.1.123.fb-click-id' } })).toBe(true);
    expect(hasMetaClickAttribution({ fbc: 'fb.1.123.fb-click-id' })).toBe(true);
    expect(hasMetaClickAttribution({ snapshot: { fbp: 'fb.1.123.browser-id' } })).toBe(false);
  });
});
