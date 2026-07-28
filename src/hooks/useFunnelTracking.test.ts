import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentAttribution, getVisitorId } from '@/hooks/useFunnelTracking';

describe('useFunnelTracking helpers', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    localStorage.clear();
  });

  it('captures pr_ad from the current page query string', () => {
    window.history.replaceState(null, '', '/beco-magico?utm_medium=paid&pr_ad=campaign-code');

    expect(getCurrentAttribution()).toMatchObject({
      utm_medium: 'paid',
      pr_ad: 'campaign-code',
    });
  });

  it('normalizes an empty pr_ad to null', () => {
    window.history.replaceState(null, '', '/beco-magico?utm_medium=organic&pr_ad=%20%20');

    expect(getCurrentAttribution().pr_ad).toBeNull();
  });

  it('keeps the anonymous UUID stable in localStorage', () => {
    const firstVisitorId = getVisitorId();

    expect(getVisitorId()).toBe(firstVisitorId);
    expect(localStorage.getItem('pg_tracking_anonymous_id')).toBe(firstVisitorId);
  });
});
