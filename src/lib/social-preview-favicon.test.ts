// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../api/social-preview';

const company = {
  name: 'Restaurante de exemplo', description: 'Descrição da unidade.', logo_url: null as string | null,
  address: null, hero_media_urls: ['https://images.example.test/banner.jpg'], hero_media_type: 'image',
};
const request = { query: { slug: 'restaurante' }, headers: { host: 'booking.example.test', 'x-forwarded-proto': 'https' } };
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function render() {
  const response = { status: vi.fn(), setHeader: vi.fn(), send: vi.fn() };
  response.status.mockReturnValue(response);
  await handler(request, response);
  expect(response.status).toHaveBeenCalledWith(200);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  return response.send.mock.calls[0][0] as string;
}

function expectIcons(html: string, logo: string) {
  for (const rel of ['icon', 'shortcut icon', 'apple-touch-icon']) {
    expect(html).toContain(`<link rel="${rel}" href="${logo}" />`);
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://database.example.test');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-test-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('social preview favicon fallback', () => {
  it('keeps the company logo and does not fetch system branding when it exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ ...company, logo_url: 'https://images.example.test/company.png' }]));
    vi.stubGlobal('fetch', fetchMock);
    const html = await render();
    expectIcons(html, 'https://images.example.test/company.png');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(html).toContain('<meta property="og:image" content="https://images.example.test/banner.jpg" />');
    expect(html).toContain('<title>Reservas | Restaurante de exemplo</title>');
  });

  it.each([
    { shape: 'array', branding: [{ system_logo_url: 'https://images.example.test/system.png' }] },
    { shape: 'object', branding: { system_logo_url: 'https://images.example.test/system.png' } },
  ])('uses configured system branding returned as $shape without changing the banner', async ({ branding }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([company])).mockResolvedValueOnce(jsonResponse(branding));
    vi.stubGlobal('fetch', fetchMock);
    const html = await render();
    expectIcons(html, 'https://images.example.test/system.png');
    expect(html).toContain('<meta property="og:image" content="https://images.example.test/banner.jpg" />');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://database.example.test/rest/v1/rpc/get_public_system_branding');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', headers: { apikey: 'public-test-key' } });
  });

  it('uses system branding for missing companies while retaining the existing title and absent share image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse([{ system_logo_url: '/configured-system.png' }])));
    const html = await render();
    expectIcons(html, 'https://booking.example.test/configured-system.png');
    expect(html).toContain('<title>Plug Guest</title>');
    expect(html).not.toContain('property="og:image"');
  });

  it.each(['empty', 'http error', 'network error', 'invalid response'] as const)('falls back to the current static icon after a branding %s', async (scenario) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([company]));
    if (scenario === 'network error') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else if (scenario === 'http error') fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    else if (scenario === 'invalid response') fetchMock.mockResolvedValueOnce(new Response('invalid json'));
    else fetchMock.mockResolvedValueOnce(jsonResponse([{ system_logo_url: '  ' }]));
    vi.stubGlobal('fetch', fetchMock);
    expectIcons(await render(), 'https://booking.example.test/favicon.png?v=plug-guest-20261122');
  });
});
