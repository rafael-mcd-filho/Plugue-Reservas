import { describe, expect, it } from 'vitest';
import { hasPaidAttribution, isPaidTrafficMarker } from '@/lib/trackingAttribution';

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
    expect(hasPaidAttribution({ utm_medium: 'email' })).toBe(false);
    expect(hasPaidAttribution(null)).toBe(false);
  });
});
