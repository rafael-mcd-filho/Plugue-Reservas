import { useEffect } from 'react';

const FAVICON_CACHE_PREFIX = 'plugue:favicon:';

function getFaviconCacheStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Private browsing / disabled storage — the cache is just an optimization.
    return null;
  }
}

function readCachedFaviconUrl(cacheKey: string) {
  const storage = getFaviconCacheStorage();
  if (!storage) return null;

  try {
    return storage.getItem(`${FAVICON_CACHE_PREFIX}${cacheKey}`);
  } catch {
    return null;
  }
}

function writeCachedFaviconUrl(cacheKey: string, url: string | null) {
  const storage = getFaviconCacheStorage();
  if (!storage) return;

  try {
    if (url) {
      storage.setItem(`${FAVICON_CACHE_PREFIX}${cacheKey}`, url);
    } else {
      storage.removeItem(`${FAVICON_CACHE_PREFIX}${cacheKey}`);
    }
  } catch {
    // Storage can become unavailable after it was obtained (quota/privacy mode).
    // Favicon updates must continue to work even when the cache cannot be written.
  }
}

function toAbsoluteUrl(url: string | null | undefined) {
  if (!url || typeof window === 'undefined') return null;

  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return null;
  }
}

function upsertPublicCompanyIcon(rel: string, href: string, type?: string) {
  if (typeof document === 'undefined') return;

  let element = document.head.querySelector<HTMLLinkElement>(`link[data-public-company-icon="${rel}"]`)
    ?? document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement('link');
    element.rel = rel;
    document.head.appendChild(element);
  }

  if (!element.hasAttribute('data-public-company-icon-original-href') && element.hasAttribute('href')) {
    element.setAttribute('data-public-company-icon-original-href', element.getAttribute('href') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-original-type') && element.hasAttribute('type')) {
    element.setAttribute('data-public-company-icon-original-type', element.getAttribute('type') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-original-sizes') && element.hasAttribute('sizes')) {
    element.setAttribute('data-public-company-icon-original-sizes', element.getAttribute('sizes') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-generated')) {
    element.setAttribute('data-public-company-icon-generated', element.hasAttribute('href') ? 'false' : 'true');
  }

  element.setAttribute('data-public-company-icon', rel);
  element.rel = rel;
  element.href = href;

  if (type) {
    element.type = type;
  } else {
    element.removeAttribute('type');
  }

  if (rel === 'alternate icon') {
    element.setAttribute('sizes', 'any');
  }
}

export function removePublicCompanyIcons() {
  if (typeof document === 'undefined') return;

  document.head.querySelectorAll<HTMLLinkElement>('link[data-public-company-icon]').forEach((element) => {
    const wasGenerated = element.getAttribute('data-public-company-icon-generated') === 'true';

    if (wasGenerated) {
      element.remove();
      return;
    }

    const originalHref = element.getAttribute('data-public-company-icon-original-href');
    const originalType = element.getAttribute('data-public-company-icon-original-type');
    const originalSizes = element.getAttribute('data-public-company-icon-original-sizes');

    if (originalHref) {
      element.href = originalHref;
    } else {
      element.removeAttribute('href');
    }

    if (originalType) {
      element.type = originalType;
    } else {
      element.removeAttribute('type');
    }

    if (originalSizes) {
      element.setAttribute('sizes', originalSizes);
    } else {
      element.removeAttribute('sizes');
    }

    element.removeAttribute('data-public-company-icon');
    element.removeAttribute('data-public-company-icon-original-href');
    element.removeAttribute('data-public-company-icon-original-type');
    element.removeAttribute('data-public-company-icon-original-sizes');
    element.removeAttribute('data-public-company-icon-generated');
  });
}

export function syncPublicCompanyIcons(logoUrl: string | null | undefined, cacheKey?: string) {
  // `undefined` means the branding request has not produced a definitive result yet.
  // Keep an eagerly restored cached icon until the request succeeds or fails.
  if (logoUrl === undefined) return;

  const absoluteLogoUrl = toAbsoluteUrl(logoUrl);
  if (!absoluteLogoUrl) {
    removePublicCompanyIcons();
    if (cacheKey) writeCachedFaviconUrl(cacheKey, null);
    return;
  }

  upsertPublicCompanyIcon('icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('alternate icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('shortcut icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('apple-touch-icon', absoluteLogoUrl);

  // Remembered so the next page load can show the right icon immediately
  // (applyCachedFavicon), instead of flashing the default one while this
  // logo is still being fetched.
  if (cacheKey) writeCachedFaviconUrl(cacheKey, absoluteLogoUrl);
}

/**
 * Applies a favicon remembered from a previous visit, if any. Call this as early as possible
 * (before the page's data has loaded) to avoid flashing the default icon on repeat visits.
 */
export function applyCachedFavicon(cacheKey: string) {
  const cachedUrl = readCachedFaviconUrl(cacheKey);
  if (!cachedUrl) return;

  upsertPublicCompanyIcon('icon', cachedUrl);
  upsertPublicCompanyIcon('alternate icon', cachedUrl);
  upsertPublicCompanyIcon('shortcut icon', cachedUrl);
  upsertPublicCompanyIcon('apple-touch-icon', cachedUrl);
}

/** Points the browser tab icon at `logoUrl` while the calling page is mounted, then restores the default favicon. */
export function useFaviconOverride(logoUrl: string | null | undefined, cacheKey = 'system') {
  useEffect(() => {
    if (logoUrl === undefined) {
      applyCachedFavicon(cacheKey);
      return;
    }
    syncPublicCompanyIcons(logoUrl, cacheKey);
  }, [logoUrl, cacheKey]);

  // Keep cleanup independent from data transitions, but restore the default when
  // the owner route changes or unmounts so another tenant never inherits this icon.
  useEffect(() => () => removePublicCompanyIcons(), [cacheKey]);
}
