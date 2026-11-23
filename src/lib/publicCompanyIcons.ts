import { useEffect } from 'react';

const FAVICON_CACHE_PREFIX = 'plugue:favicon:v2:';
export const DEFAULT_SYSTEM_FAVICON = '/favicon.png?v=plug-guest-20261122';
const ICON_RELS = ['icon', 'alternate icon', 'shortcut icon', 'apple-touch-icon'];
const COMPANY_OWNER_ATTRIBUTE = 'data-company-favicon-owner';
let systemLogoUrl: string | null = null;

function getFaviconCacheStorage() {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function readCachedFaviconUrl(cacheKey: string) {
  try { return getFaviconCacheStorage()?.getItem(FAVICON_CACHE_PREFIX + cacheKey) ?? null; } catch { return null; }
}

function writeCachedFaviconUrl(cacheKey: string, url: string | null) {
  try {
    const storage = getFaviconCacheStorage();
    if (url) storage?.setItem(FAVICON_CACHE_PREFIX + cacheKey, url);
    else storage?.removeItem(FAVICON_CACHE_PREFIX + cacheKey);
  } catch { /* Storage is optional; the tab icon must still update. */ }
}

function toAbsoluteUrl(url: string | null | undefined) {
  if (!url?.trim() || typeof window === 'undefined') return null;
  try {
    const resolved = new URL(url.trim(), window.location.origin);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
  } catch { return null; }
}

function getSystemFaviconUrl() {
  return systemLogoUrl ?? toAbsoluteUrl(readCachedFaviconUrl('system')) ?? toAbsoluteUrl(DEFAULT_SYSTEM_FAVICON)!;
}

function companyIconOwner() {
  return document.head.querySelector<HTMLLinkElement>('link[' + COMPANY_OWNER_ATTRIBUTE + ']')?.getAttribute(COMPANY_OWNER_ATTRIBUTE);
}

function applyIconLinks(href: string, companyOwner?: string) {
  if (typeof document === 'undefined') return;
  for (const rel of ICON_RELS) {
    const existing = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="' + rel + '"]'));
    if (existing.length === 0) {
      const element = document.createElement('link');
      element.rel = rel;
      document.head.appendChild(element);
      existing.push(element);
    }
    // Update duplicate declarations too, so browsers cannot select an obsolete icon.
    for (const element of existing) {
      element.href = href;
      element.removeAttribute('type');
      element.removeAttribute('sizes');
      if (companyOwner) element.setAttribute(COMPANY_OWNER_ATTRIBUTE, companyOwner);
      else element.removeAttribute(COMPANY_OWNER_ATTRIBUTE);
    }
  }
}

/** Update the platform fallback without replacing a tenant's own logo. */
export function syncSystemFavicon(logoUrl: string | null | undefined) {
  if (typeof document === 'undefined') return;
  if (logoUrl !== undefined) {
    systemLogoUrl = toAbsoluteUrl(logoUrl);
    writeCachedFaviconUrl('system', systemLogoUrl);
  }
  if (!companyIconOwner()) applyIconLinks(getSystemFaviconUrl());
}

/** Restore the current platform logo, never the original/obsolete HTML icon. */
export function removePublicCompanyIcons(cacheKey?: string) {
  if (typeof document === 'undefined') return;
  if (cacheKey && companyIconOwner() !== cacheKey) return;
  applyIconLinks(getSystemFaviconUrl());
}

export function syncPublicCompanyIcons(logoUrl: string | null | undefined, cacheKey = 'system') {
  if (cacheKey === 'system') {
    syncSystemFavicon(logoUrl);
    return;
  }
  // Undefined is unresolved branding; retain this tenant's cached logo until known.
  if (logoUrl === undefined) return;
  const absoluteLogoUrl = toAbsoluteUrl(logoUrl);
  if (!absoluteLogoUrl) {
    writeCachedFaviconUrl(cacheKey, null);
    removePublicCompanyIcons();
    return;
  }
  applyIconLinks(absoluteLogoUrl, cacheKey);
  writeCachedFaviconUrl(cacheKey, absoluteLogoUrl);
}

/** Restore this tenant's cached logo; without one, use the platform fallback. */
export function applyCachedFavicon(cacheKey: string) {
  if (cacheKey === 'system') {
    syncSystemFavicon(undefined);
    return;
  }
  const cachedUrl = toAbsoluteUrl(readCachedFaviconUrl(cacheKey));
  if (cachedUrl) applyIconLinks(cachedUrl, cacheKey);
  else removePublicCompanyIcons();
}

/** Company logo when available; platform logo otherwise, including route cleanup. */
export function useFaviconOverride(logoUrl: string | null | undefined, cacheKey = 'system') {
  useEffect(() => {
    if (logoUrl === undefined) applyCachedFavicon(cacheKey);
    else syncPublicCompanyIcons(logoUrl, cacheKey);
  }, [logoUrl, cacheKey]);

  useEffect(() => () => {
    if (cacheKey !== 'system') removePublicCompanyIcons(cacheKey);
  }, [cacheKey]);
}
