import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentAttribution, getVisitorId } from '@/hooks/useFunnelTracking';

if (!window.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } satisfies Storage,
  });
}

describe('useFunnelTracking helpers', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    document.cookie = '_fbp=; Max-Age=0; path=/';
    document.cookie = '_fbc=; Max-Age=0; path=/';
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
    expect(window.localStorage.getItem('pg_tracking_anonymous_id')).toBe(firstVisitorId);
  });

  it('does not throw when Meta cookies contain malformed URI encoding', () => {
    document.cookie = '_fbp=%; path=/';
    document.cookie = '_fbc=%E0%A4%A; path=/';

    expect(() => getCurrentAttribution()).not.toThrow();
    expect(getCurrentAttribution()).toMatchObject({
      fbp: '%',
      fbc: '%E0%A4%A',
    });
  });
});
