import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SystemFavicon from './SystemFavicon';
import { DEFAULT_SYSTEM_FAVICON, removePublicCompanyIcons, syncPublicCompanyIcons, syncSystemFavicon } from '@/lib/publicCompanyIcons';

const branding = vi.hoisted(() => ({ data: undefined as { system_logo_url: string } | undefined }));
vi.mock('@/hooks/useSettings', () => ({ useSystemBranding: () => branding }));

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() } });
  document.head.innerHTML = '<link rel="icon" href="/old.ico">';
  removePublicCompanyIcons();
  syncSystemFavicon(null);
  branding.data = undefined;
});
afterEach(cleanup);

describe('system favicon on all routes', () => {
  it('shows the current bundled logo before branding resolves, then uses the configured system logo', () => {
    const { rerender } = render(<SystemFavicon />);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe(new URL(DEFAULT_SYSTEM_FAVICON, window.location.origin).href);
    branding.data = { system_logo_url: '/configured-system.png' };
    rerender(<SystemFavicon />);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe('http://localhost:3000/configured-system.png');
  });

  it('preserves a company logo while refreshing the platform fallback', () => {
    syncPublicCompanyIcons('/restaurant.png', 'company:restaurant');
    branding.data = { system_logo_url: '/configured-system.png' };
    render(<SystemFavicon />);
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe('http://localhost:3000/restaurant.png');
    syncPublicCompanyIcons(null, 'company:restaurant');
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe('http://localhost:3000/configured-system.png');
  });
});
