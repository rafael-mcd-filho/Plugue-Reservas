const GOOGLE_MAPS_EMBED_HOSTS = new Set([
  'www.google.com',
  'google.com',
  'maps.google.com',
]);

export function normalizeGoogleMapsEmbedInput(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const isEmbedPath = url.pathname.startsWith('/maps/embed')
      || (url.pathname === '/maps' && url.searchParams.get('output') === 'embed');

    if (url.protocol !== 'https:' || !GOOGLE_MAPS_EMBED_HOSTS.has(hostname) || !isEmbedPath) {
      return '';
    }

    return url.toString();
  } catch {
    return '';
  }
}

export function getGoogleMapsEmbedUrl(
  rawValue: string | null | undefined,
  fallbackQuery: string | null | undefined,
) {
  const safeEmbedUrl = normalizeGoogleMapsEmbedInput(rawValue);
  if (safeEmbedUrl) return safeEmbedUrl;

  const query = fallbackQuery?.trim();
  if (!query) return null;

  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}
