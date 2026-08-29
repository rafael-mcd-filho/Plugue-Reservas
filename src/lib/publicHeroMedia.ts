export function normalizePublicHeroMediaUrls(
  urls?: readonly string[] | null,
  fallbackUrl?: string | null,
) {
  const normalized = (Array.isArray(urls) ? urls : [])
    .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    .map((url) => url.trim())
    .filter((url, index, list) => list.indexOf(url) === index)
    .slice(0, 4);

  if (normalized.length > 0) return normalized;

  const fallback = fallbackUrl?.trim();
  return fallback ? [fallback] : [];
}
