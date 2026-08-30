type SitemapRequest = {
  headers: Record<string, string | string[] | undefined>;
};

type SitemapResponse = {
  status: (code: number) => SitemapResponse;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
};

// A view companies_public não expõe updated_at, então o sitemap sai sem <lastmod>.
interface PublicCompanySlug {
  slug: string;
}

const DEFAULT_SUPABASE_URL = 'https://hdpxqqiudiotanrybvcf.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkcHhxcWl1ZGlvdGFucnlidmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjk0OTksImV4cCI6MjA4ODY0NTQ5OX0.OeJWsYMXQSMqNz05eqfgceMj3iQNX0pQH-4gxKOaNhY';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function getHeader(headers: SitemapRequest['headers'], key: string) {
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getOrigin(request: SitemapRequest) {
  const host = getHeader(request.headers, 'x-forwarded-host') ?? getHeader(request.headers, 'host') ?? '';
  const proto = getHeader(request.headers, 'x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://plugguest.com.br';
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// A view companies_public já expõe apenas empresas ativas.
async function fetchCompanySlugs(): Promise<PublicCompanySlug[]> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
    ?? process.env.SUPABASE_URL
    ?? DEFAULT_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.VITE_SUPABASE_ANON_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY;

  const url = new URL('/rest/v1/companies_public', supabaseUrl);
  url.searchParams.set('select', 'slug');
  url.searchParams.set('order', 'slug.asc');
  url.searchParams.set('limit', '5000');

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) return [];

  const rows = await response.json() as PublicCompanySlug[];
  return rows.filter((row) => !!row?.slug && SLUG_PATTERN.test(row.slug));
}

function renderUrlEntry(location: string, changeFrequency: string, priority: string) {
  return [
    '  <url>',
    `    <loc>${escapeXml(location)}</loc>`,
    `    <changefreq>${changeFrequency}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
}

export default async function handler(request: SitemapRequest, response: SitemapResponse) {
  const origin = getOrigin(request);
  let companies: PublicCompanySlug[] = [];

  try {
    companies = await fetchCompanySlugs();
  } catch {
    // Um sitemap só com a landing page é melhor do que devolver erro para o robô.
    companies = [];
  }

  const entries = [
    renderUrlEntry(`${origin}/`, 'weekly', '1.0'),
    ...companies.map((company) => renderUrlEntry(`${origin}/${company.slug}`, 'weekly', '0.8')),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>`;

  response.status(200);
  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  response.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  response.send(xml);
}
