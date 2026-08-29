import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCachedFavicon,
  removePublicCompanyIcons,
  syncPublicCompanyIcons,
  useFaviconOverride,
} from './publicCompanyIcons';

const COMPANY_CACHE_KEY = 'company:restaurante-teste';
const COMPANY_STORAGE_KEY = `plugue:favicon:${COMPANY_CACHE_KEY}`;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

function favicon(rel = 'icon') {
  return document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
}

describe('public company favicon', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.ico" type="image/x-icon">';
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removePublicCompanyIcons();
    window.localStorage.clear();
  });

  it('restores a cached icon early and keeps it while branding is unresolved', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, '/cached-logo.png');

    applyCachedFavicon(COMPANY_CACHE_KEY);
    syncPublicCompanyIcons(undefined, COMPANY_CACHE_KEY);

    expect(favicon()?.href).toBe('http://localhost:3000/cached-logo.png');
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBe('/cached-logo.png');
  });

  it('replaces the cached icon and restores the original icon on cleanup', () => {
    syncPublicCompanyIcons('/company-logo.png', COMPANY_CACHE_KEY);

    expect(favicon()?.href).toBe('http://localhost:3000/company-logo.png');
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBe('http://localhost:3000/company-logo.png');
    expect(favicon('apple-touch-icon')?.href).toBe('http://localhost:3000/company-logo.png');

    removePublicCompanyIcons();

    expect(favicon()?.href).toBe('http://localhost:3000/favicon.ico');
    expect(favicon('apple-touch-icon')).toBeNull();
  });

  it('clears a stale cached icon after a definitive empty result', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, '/stale-logo.png');
    applyCachedFavicon(COMPANY_CACHE_KEY);

    syncPublicCompanyIcons(null, COMPANY_CACHE_KEY);

    expect(favicon()?.href).toBe('http://localhost:3000/favicon.ico');
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBeNull();
  });

  it('does not fail favicon updates when localStorage writes are blocked', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    expect(() => syncPublicCompanyIcons('/company-logo.png', COMPANY_CACHE_KEY)).not.toThrow();
    expect(favicon()?.href).toBe('http://localhost:3000/company-logo.png');

    vi.restoreAllMocks();
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    expect(() => syncPublicCompanyIcons(null, COMPANY_CACHE_KEY)).not.toThrow();
    expect(favicon()?.href).toBe('http://localhost:3000/favicon.ico');
  });

  it('ignores a blocked localStorage read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    expect(() => applyCachedFavicon(COMPANY_CACHE_KEY)).not.toThrow();
    expect(favicon()?.href).toBe('http://localhost:3000/favicon.ico');
  });

  it('keeps the cached icon through a pending hook state and cleans up on unmount', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, '/cached-logo.png');
    applyCachedFavicon(COMPANY_CACHE_KEY);

    const { rerender, unmount } = renderHook(
      ({ logoUrl }: { logoUrl: string | null | undefined }) => (
        useFaviconOverride(logoUrl, COMPANY_CACHE_KEY)
      ),
      { initialProps: { logoUrl: undefined as string | null | undefined } },
    );

    expect(favicon()?.href).toBe('http://localhost:3000/cached-logo.png');

    rerender({ logoUrl: '/fresh-logo.png' });
    expect(favicon()?.href).toBe('http://localhost:3000/fresh-logo.png');

    unmount();
    expect(favicon()?.href).toBe('http://localhost:3000/favicon.ico');
  });

  it('does not leave the previous tenant icon when the route owner changes', () => {
    window.localStorage.setItem('plugue:favicon:company:restaurante-b', '/restaurant-b.png');

    const { rerender } = renderHook(
      ({ cacheKey, logoUrl }: { cacheKey: string; logoUrl: string | null | undefined }) => (
        useFaviconOverride(logoUrl, cacheKey)
      ),
      {
        initialProps: {
          cacheKey: COMPANY_CACHE_KEY,
          logoUrl: '/restaurant-a.png' as string | null | undefined,
        },
      },
    );

    expect(favicon()?.href).toBe('http://localhost:3000/restaurant-a.png');

    rerender({ cacheKey: 'company:restaurante-b', logoUrl: undefined });

    expect(favicon()?.href).toBe('http://localhost:3000/restaurant-b.png');
  });
});
