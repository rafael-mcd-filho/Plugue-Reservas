import { describe, expect, it } from 'vitest';
import {
  hasMetaClickAttribution,
  hasPaidAttribution,
  hasPaidAttributionV2,
  isPaidTrafficMarker,
  isPaidTrafficMarkerV2,
} from '@/lib/trackingAttribution';

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

  it('accepts only the exact paid utm_medium in the V2 rule', () => {
    expect(isPaidTrafficMarkerV2('paid')).toBe(true);
    expect(isPaidTrafficMarkerV2(' PAID ')).toBe(true);
    expect(isPaidTrafficMarkerV2('paid_social')).toBe(false);
    expect(isPaidTrafficMarkerV2('paid-search')).toBe(false);
    expect(isPaidTrafficMarkerV2('cpc')).toBe(false);
  });

  it('accepts a non-empty pr_ad as a V2 paid touch', () => {
    expect(hasPaidAttributionV2({ pr_ad: 'campaign-code' })).toBe(true);
    expect(hasPaidAttributionV2({ pr_ad: '  campaign-code  ' })).toBe(true);
    expect(hasPaidAttributionV2({ pr_ad: '   ' })).toBe(false);
  });

  it('does not classify an organic V2 access as paid', () => {
    expect(hasPaidAttributionV2({ utm_medium: 'organic' })).toBe(false);
    expect(hasPaidAttributionV2({ utm_medium: 'cpc' })).toBe(false);
    expect(hasPaidAttributionV2({ fbclid: 'fb-click-id' })).toBe(false);
    expect(hasPaidAttributionV2(null)).toBe(false);
  });
});
