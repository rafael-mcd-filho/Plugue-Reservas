export const AFFILIATE_LINK_CODE_PATTERN = /^[A-Za-z0-9-]{3,40}$/;
const AFFILIATE_ATTRIBUTION_STORAGE_KEY = 'pg_affiliate_attribution_v1';
const AFFILIATE_ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RANDOM_CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface AffiliateAttributionRecord {
  companyId: string;
  companySlug: string;
  affiliateLinkId: string;
  code: string;
  referenceName: string;
  landingPath: string | null;
  capturedAt: string;
  expiresAt: string;
}

type StoredAffiliateAttributionMap = Record<string, AffiliateAttributionRecord>;

export function normalizeAffiliateLinkCode(value: string | null | undefined) {
  return (value || '').trim();
}

export function isValidAffiliateLinkCode(value: string | null | undefined) {
  return AFFILIATE_LINK_CODE_PATTERN.test(normalizeAffiliateLinkCode(value));
}

export function generateAffiliateLinkCode(length = 6) {
  return Array.from({ length }, () => {
    const index = Math.floor(Math.random() * RANDOM_CODE_CHARACTERS.length);
    return RANDOM_CODE_CHARACTERS[index];
  }).join('');
}

export function buildAffiliateLinkPath(slug: string, code: string) {
  return `/${slug}/f/${encodeURIComponent(code)}`;
}

export function buildAffiliateLinkUrl(origin: string, slug: string, code: string) {
  return `${origin}${buildAffiliateLinkPath(slug, code)}`;
}

function readStoredAttributionMap(): StoredAffiliateAttributionMap {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(AFFILIATE_ATTRIBUTION_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed as StoredAffiliateAttributionMap;
  } catch {
    return {};
  }
}

function writeStoredAttributionMap(value: StoredAffiliateAttributionMap) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AFFILIATE_ATTRIBUTION_STORAGE_KEY, JSON.stringify(value));
}

function pruneExpiredAttributionMap(map: StoredAffiliateAttributionMap) {
  const now = Date.now();

  return Object.fromEntries(
    Object.entries(map).filter(([, record]) => {
      const expiresAt = new Date(record.expiresAt).getTime();
      return Number.isFinite(expiresAt) && expiresAt > now;
    }),
  );
}

export function setAffiliateAttribution(record: {
  companyId: string;
  companySlug: string;
  affiliateLinkId: string;
  code: string;
  referenceName: string;
  landingPath?: string | null;
}) {
  const current = pruneExpiredAttributionMap(readStoredAttributionMap());
  const capturedAt = new Date().toISOString();

  current[record.companySlug] = {
    companyId: record.companyId,
    companySlug: record.companySlug,
    affiliateLinkId: record.affiliateLinkId,
    code: record.code,
    referenceName: record.referenceName,
    landingPath: record.landingPath ?? null,
    capturedAt,
    expiresAt: new Date(Date.now() + AFFILIATE_ATTRIBUTION_TTL_MS).toISOString(),
  };

  writeStoredAttributionMap(current);
  return current[record.companySlug];
}

export function getAffiliateAttribution(input: {
  companySlug?: string | null;
  companyId?: string | null;
}) {
  const current = pruneExpiredAttributionMap(readStoredAttributionMap());
  writeStoredAttributionMap(current);

  if (input.companySlug) {
    const record = current[input.companySlug];
    if (record && (!input.companyId || record.companyId === input.companyId)) {
      return record;
    }
  }

  if (!input.companyId) return null;

  return Object.values(current).find((record) => record.companyId === input.companyId) ?? null;
}

export function clearAffiliateAttribution(companySlug: string | null | undefined) {
  if (!companySlug) return;

  const current = pruneExpiredAttributionMap(readStoredAttributionMap());
  delete current[companySlug];
  writeStoredAttributionMap(current);
}
