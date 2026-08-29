import { describe, expect, it } from 'vitest';
import {
  getPublicApplicationCompanySlug,
  getPublicCompanySlugFromPathname,
  isPublicApplicationPath,
} from './publicRoutes';

describe('public application route selection', () => {
  it.each([
    '/beco-magico-joao-pessoa',
    '/beco-magico-joao-pessoa/f/parceiro',
    '/beco-magico-joao-pessoa/fila',
    '/beco-magico-joao-pessoa/fila/ABC123',
    '/beco-magico-joao-pessoa/reserva/ABC123',
    '/beco-magico-joao-pessoa/avaliacao/token',
    '/pagamento/token',
  ])('uses the public shell for %s', (pathname) => {
    expect(isPublicApplicationPath(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/login',
    '/dashboard',
    '/empresas/123',
    '/beco-magico-joao-pessoa/admin',
    '/beco-magico-joao-pessoa/admin/configuracoes',
  ])('keeps the administrative shell for %s', (pathname) => {
    expect(isPublicApplicationPath(pathname)).toBe(false);
  });

  it('prefetches company data only for the company and affiliate pages', () => {
    expect(getPublicCompanySlugFromPathname('/beco-magico-joao-pessoa')).toBe('beco-magico-joao-pessoa');
    expect(getPublicCompanySlugFromPathname('/beco-magico-joao-pessoa/f/parceiro')).toBe('beco-magico-joao-pessoa');
    expect(getPublicCompanySlugFromPathname('/beco-magico-joao-pessoa/fila')).toBeNull();
    expect(getPublicCompanySlugFromPathname('/login')).toBeNull();
  });

  it.each([
    ['/beco-magico-joao-pessoa', 'beco-magico-joao-pessoa'],
    ['/beco-magico-joao-pessoa/fila', 'beco-magico-joao-pessoa'],
    ['/beco-magico-joao-pessoa/fila/ABC123', 'beco-magico-joao-pessoa'],
    ['/beco-magico-joao-pessoa/reserva/ABC123', 'beco-magico-joao-pessoa'],
    ['/beco-magico-joao-pessoa/avaliacao/token', 'beco-magico-joao-pessoa'],
    ['/beco-magico-joao-pessoa/f/parceiro', 'beco-magico-joao-pessoa'],
  ])('extracts the tenant from public company route %s', (pathname, expectedSlug) => {
    expect(getPublicApplicationCompanySlug(pathname)).toBe(expectedSlug);
  });

  it.each([
    '/pagamento/token',
    '/login',
    '/dashboard',
    '/',
  ])('does not invent a company slug for %s', (pathname) => {
    expect(getPublicApplicationCompanySlug(pathname)).toBeNull();
  });
});
