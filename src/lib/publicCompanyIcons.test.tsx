import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCachedFavicon,
  removePublicCompanyIcons,
  DEFAULT_SYSTEM_FAVICON,
  syncSystemFavicon,
  syncPublicCompanyIcons,
  useFaviconOverride,
} from './publicCompanyIcons';

const COMPANY_CACHE_KEY = 'company:restaurante-teste';
const COMPANY_STORAGE_KEY = `plugue:favicon:v2:${COMPANY_CACHE_KEY}`;
const defaultFavicon = () => new URL(DEFAULT_SYSTEM_FAVICON, window.location.origin).href;

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
    removePublicCompanyIcons();
    syncSystemFavicon(null);
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

  it('replaces the cached icon and restores the current platform icon on cleanup', () => {
    syncPublicCompanyIcons('/company-logo.png', COMPANY_CACHE_KEY);

    expect(favicon()?.href).toBe('http://localhost:3000/company-logo.png');
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBe('http://localhost:3000/company-logo.png');
    expect(favicon('apple-touch-icon')?.href).toBe('http://localhost:3000/company-logo.png');

    removePublicCompanyIcons();

    expect(favicon()?.href).toBe(defaultFavicon());
    expect(favicon('apple-touch-icon')?.href).toBe(defaultFavicon());
  });

  it('clears a stale cached icon after a definitive empty result', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, '/stale-logo.png');
    applyCachedFavicon(COMPANY_CACHE_KEY);

    syncPublicCompanyIcons(null, COMPANY_CACHE_KEY);

    expect(favicon()?.href).toBe(defaultFavicon());
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
    expect(favicon()?.href).toBe(defaultFavicon());
  });

  it('ignores a blocked localStorage read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    expect(() => applyCachedFavicon(COMPANY_CACHE_KEY)).not.toThrow();
    expect(favicon()?.href).toBe(defaultFavicon());
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
    expect(favicon()?.href).toBe(defaultFavicon());
  });

  it('does not leave the previous tenant icon when the route owner changes', () => {
    window.localStorage.setItem('plugue:favicon:v2:company:restaurante-b', '/restaurant-b.png');

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

  it('uses the configured system logo for a company without a logo', () => {
    syncSystemFavicon('/current-platform-logo.png');
    syncPublicCompanyIcons(null, COMPANY_CACHE_KEY);
    for (const rel of ['icon', 'alternate icon', 'shortcut icon', 'apple-touch-icon']) {
      expect(favicon(rel)?.href).toBe('http://localhost:3000/current-platform-logo.png');
    }
  });

  it('updates the fallback when platform branding arrives after a logo-less company', () => {
    syncPublicCompanyIcons(null, COMPANY_CACHE_KEY);
    expect(favicon()?.href).toBe(defaultFavicon());
    syncSystemFavicon('/new-platform-logo.png');
    expect(favicon()?.href).toBe('http://localhost:3000/new-platform-logo.png');
  });

  it('keeps a company logo when platform branding updates and restores the latest system logo on exit', () => {
    syncSystemFavicon('/platform-one.png');
    syncPublicCompanyIcons('/own-company-logo.png', COMPANY_CACHE_KEY);
    syncSystemFavicon('/platform-two.png');
    expect(favicon()?.href).toBe('http://localhost:3000/own-company-logo.png');
    removePublicCompanyIcons(COMPANY_CACHE_KEY);
    expect(favicon()?.href).toBe('http://localhost:3000/platform-two.png');
  });

  it('replaces every duplicate icon declaration and removes obsolete MIME types and sizes', () => {
    document.head.innerHTML = '<link rel="icon" href="/old.svg" type="image/svg+xml" sizes="32x32"><link rel="icon" href="/old.ico"><link rel="alternate icon" href="/old.ico" type="image/x-icon">';
    syncSystemFavicon('/current.png');
    document.head.querySelectorAll<HTMLLinkElement>('link[rel*="icon"]').forEach((element) => {
      expect(element.href).toBe('http://localhost:3000/current.png');
      expect(element.hasAttribute('type')).toBe(false);
      expect(element.hasAttribute('sizes')).toBe(false);
    });
  });

  it('uses the new system cache and ignores legacy cached icons', () => {
    window.localStorage.setItem('plugue:favicon:system', '/obsolete-icon.png');
    window.localStorage.setItem('plugue:favicon:company:other', '/obsolete-company.png');
    applyCachedFavicon('company:other');
    expect(favicon()?.href).toBe(defaultFavicon());
    window.localStorage.setItem('plugue:favicon:v2:system', '/configured-platform.png');
    applyCachedFavicon('system');
    expect(favicon()?.href).toBe('http://localhost:3000/configured-platform.png');
  });

  it('does not carry a previous company icon into a company without a cached logo', () => {
    syncSystemFavicon('/current-platform.png');
    const { rerender, unmount } = renderHook(({ key, url }: { key: string; url: string | null | undefined }) => useFaviconOverride(url, key), { initialProps: { key: COMPANY_CACHE_KEY, url: '/company-a.png' as string | null | undefined } });
    rerender({ key: 'company:without-logo', url: undefined });
    expect(favicon()?.href).toBe('http://localhost:3000/current-platform.png');
    rerender({ key: 'company:without-logo', url: null });
    expect(favicon()?.href).toBe('http://localhost:3000/current-platform.png');
    unmount();
  });

  it('does not let cleanup from an old company remove another company logo', () => {
    syncPublicCompanyIcons('/company-b.png', 'company:b');
    removePublicCompanyIcons('company:a');
    expect(favicon()?.href).toBe('http://localhost:3000/company-b.png');
  });

  it('falls back to the system logo for blank or unsupported company URLs', () => {
    syncSystemFavicon('/current-platform.png');
    for (const value of ['   ', 'javascript:alert(1)', 'file:///old-icon.ico']) {
      syncPublicCompanyIcons(value, COMPANY_CACHE_KEY);
      expect(favicon()?.href).toBe('http://localhost:3000/current-platform.png');
    }
  });
});
