type PreviewRequest = {
  query: {
    slug?: string | string[];
  };
  headers: Record<string, string | string[] | undefined>;
};

type PreviewResponse = {
  status: (code: number) => PreviewResponse;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
};

interface PublicCompanyPreview {
  name: string;
  description: string | null;
  logo_url: string | null;
  address: string | null;
}

const DEFAULT_SYSTEM_NAME = 'Plugue Reservas';
const DEFAULT_DESCRIPTION = 'Plataforma de reservas para restaurantes com página pública, painel por unidade e automações via WhatsApp.';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_SUPABASE_URL = 'https://hdpxqqiudiotanrybvcf.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkcHhxcWl1ZGlvdGFucnlidmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjk0OTksImV4cCI6MjA4ODY0NTQ5OX0.OeJWsYMXQSMqNz05eqfgceMj3iQNX0pQH-4gxKOaNhY';

function getHeader(headers: PreviewRequest['headers'], key: string) {
  const value = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getOrigin(request: PreviewRequest) {
  const host = getHeader(request.headers, 'x-forwarded-host') ?? getHeader(request.headers, 'host') ?? '';
  const proto = getHeader(request.headers, 'x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://plugue-reservas.vercel.app';
}

function getSlug(request: PreviewRequest) {
  const value = request.query.slug;
  const slug = Array.isArray(value) ? value[0] : value;
  return slug && SLUG_PATTERN.test(slug) ? slug : null;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function richTextToPlainText(value: string | null | undefined) {
  if (!value) return '';

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSeoText(value: string, maxLength = 155) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const trimmed = normalized.slice(0, maxLength - 1);
  const lastSpace = trimmed.lastIndexOf(' ');
  return `${trimmed.slice(0, lastSpace > 80 ? lastSpace : trimmed.length).trim()}...`;
}

function toAbsoluteUrl(url: string | null | undefined, origin: string) {
  if (!url) return null;

  try {
    return new URL(url, origin).toString();
  } catch {
    return null;
  }
}

async function fetchCompany(slug: string): Promise<PublicCompanyPreview | null> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
    ?? process.env.SUPABASE_URL
    ?? DEFAULT_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.VITE_SUPABASE_ANON_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY;

  const url = new URL('/rest/v1/companies_public', supabaseUrl);
  url.searchParams.set('slug', `eq.${slug}`);
  url.searchParams.set('select', 'name,description,logo_url,address');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });

  if (!response.ok) return null;

  const rows = await response.json() as PublicCompanyPreview[];
  return rows[0] ?? null;
}

function renderPreviewHtml({
  title,
  description,
  canonicalUrl,
  imageUrl,
}: {
  title: string;
  description: string;
  canonicalUrl: string;
  imageUrl: string | null;
}) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeCanonicalUrl = escapeHtml(canonicalUrl);
  const safeImageUrl = imageUrl ? escapeHtml(imageUrl) : null;

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:site_name" content="${DEFAULT_SYSTEM_NAME}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="pt_BR" />
    <meta property="og:url" content="${safeCanonicalUrl}" />
    ${safeImageUrl ? `<meta property="og:image" content="${safeImageUrl}" />
    <meta property="og:image:secure_url" content="${safeImageUrl}" />
    <meta property="og:image:alt" content="${safeTitle}" />
    <meta name="twitter:image" content="${safeImageUrl}" />
    <meta name="twitter:image:alt" content="${safeTitle}" />
    <link rel="icon" href="${safeImageUrl}" />
    <link rel="shortcut icon" href="${safeImageUrl}" />
    <link rel="apple-touch-icon" href="${safeImageUrl}" />` : ''}
    <meta name="twitter:card" content="${safeImageUrl ? 'summary_large_image' : 'summary'}" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDescription}" />
    <link rel="canonical" href="${safeCanonicalUrl}" />
  </head>
  <body>
    <a href="${safeCanonicalUrl}">${safeTitle}</a>
  </body>
</html>`;
}

export default async function handler(request: PreviewRequest, response: PreviewResponse) {
  const origin = getOrigin(request);
  const slug = getSlug(request);
  const canonicalUrl = slug ? `${origin}/${slug}` : origin;
  const company = slug ? await fetchCompany(slug) : null;
  const companyLogo = toAbsoluteUrl(company?.logo_url, origin);
  const companyDescription = richTextToPlainText(company?.description);
  const title = company
    ? `Reservar mesa no ${company.name} | ${DEFAULT_SYSTEM_NAME}`
    : DEFAULT_SYSTEM_NAME;
  const description = company
    ? truncateSeoText(
        companyDescription
          ? companyDescription
          : `Página de reserva do ${company.name}${company.address ? ` em ${company.address}` : ''}. Consulte horários, localização e faça sua reserva online.`,
      )
    : DEFAULT_DESCRIPTION;

  response.status(200);
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  response.send(renderPreviewHtml({
    title,
    description,
    canonicalUrl,
    imageUrl: companyLogo,
  }));
}
