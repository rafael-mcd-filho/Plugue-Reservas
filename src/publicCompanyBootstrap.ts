import { getPublicCompanySlugFromPathname } from '@/lib/publicRoutes';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://hdpxqqiudiotanrybvcf.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkcHhxcWl1ZGlvdGFucnlidmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjk0OTksImV4cCI6MjA4ODY0NTQ5OX0.OeJWsYMXQSMqNz05eqfgceMj3iQNX0pQH-4gxKOaNhY';

interface PublicCompanyPrefetch {
  slug: string;
  promise: Promise<unknown | null>;
}

declare global {
  interface Window {
    __pluguePublicCompanyPrefetch?: PublicCompanyPrefetch;
  }
}

function fetchPublicCompany(slug: string) {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_company_by_slug`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ _slug: slug }),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Public company prefetch failed with status ${response.status}`);
    }

    const payload = await response.json() as unknown;
    if (Array.isArray(payload)) return payload[0] ?? null;
    return payload && typeof payload === 'object' ? payload : null;
  });
}

export function startPublicCompanyPrefetch(pathname = window.location.pathname) {
  const slug = getPublicCompanySlugFromPathname(pathname);
  if (!slug) return null;

  const current = window.__pluguePublicCompanyPrefetch;
  if (current?.slug === slug) return current.promise;

  const promise = fetchPublicCompany(slug);
  // The React Query request consumes this promise and falls back to supabase-js
  // if the early request fails, so there is no unhandled rejection here.
  void promise.catch(() => undefined);
  window.__pluguePublicCompanyPrefetch = { slug, promise };
  return promise;
}

export function getPrefetchedPublicCompany(slug: string) {
  const prefetch = window.__pluguePublicCompanyPrefetch;
  return prefetch?.slug === slug ? prefetch.promise : null;
}

if (typeof window !== 'undefined') {
  startPublicCompanyPrefetch();
}
