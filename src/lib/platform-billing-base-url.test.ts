import { describe, expect, it } from 'vitest';
import { resolvePlatformAsaasBaseUrl } from '../../supabase/functions/_shared/platform-billing-base-url.ts';

describe('platform billing Asaas base URL safety', () => {
  it('uses the official endpoint for each configured environment', () => {
    expect(resolvePlatformAsaasBaseUrl({ environment: 'sandbox' })).toBe(
      'https://api-sandbox.asaas.com/v3',
    );
    expect(resolvePlatformAsaasBaseUrl({ environment: 'production' })).toBe(
      'https://api.asaas.com/v3',
    );
  });

  it('accepts only the exact official production base URL', () => {
    expect(resolvePlatformAsaasBaseUrl({
      environment: 'production',
      override: 'https://api.asaas.com/v3/',
    })).toBe('https://api.asaas.com/v3');

    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'production',
      override: 'https://proxy.example.com/asaas/v3',
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('endpoint oficial do Asaas');
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'production',
      override: 'https://api.asaas.com/outro-caminho',
    })).toThrow('endpoint oficial do Asaas');
  });

  it('rejects HTTP before considering any override gate or allowlist', () => {
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override: 'http://proxy.example.com/asaas/v3',
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('deve usar HTTPS');
  });

  it('requires both the sandbox gate and exact proxy-origin allowlist', () => {
    const override = 'https://proxy.example.com/asaas/v3/';
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('PLATFORM_ASAAS_ALLOW_BASE_URL_OVERRIDE=true');
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override,
      allowSandboxOverride: true,
    })).toThrow('não está na allowlist');
    expect(resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override,
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://other.example.com, https://proxy.example.com',
    })).toBe('https://proxy.example.com/asaas/v3');
  });

  it('matches proxy origin and non-default port exactly', () => {
    const options = {
      environment: 'sandbox' as const,
      override: 'https://proxy.example.com:8443/asaas/v3',
      allowSandboxOverride: true,
    };
    expect(() => resolvePlatformAsaasBaseUrl({
      ...options,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('não está na allowlist');
    expect(resolvePlatformAsaasBaseUrl({
      ...options,
      allowedProxyOrigins: 'https://proxy.example.com:8443',
    })).toBe('https://proxy.example.com:8443/asaas/v3');
  });

  it.each([
    'https://user:password@proxy.example.com/asaas/v3',
    'https://proxy.example.com/asaas/v3?token=1',
    'https://proxy.example.com/asaas/v3#fragment',
  ])('rejects credentials, query or fragment in %s', (override) => {
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override,
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('não pode conter');
  });

  it.each([
    ['https://localhost/asaas/v3', 'https://localhost'],
    ['https://service.local/asaas/v3', 'https://service.local'],
    ['https://127.0.0.1/asaas/v3', 'https://127.0.0.1'],
    ['https://[::1]/asaas/v3', 'https://[::1]'],
  ])('rejects local/IP proxy target %s', (override, allowedProxyOrigins) => {
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override,
      allowSandboxOverride: true,
      allowedProxyOrigins,
    })).toThrow('host local ou IP');
  });

  it('rejects another Asaas environment even if it was allowlisted', () => {
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override: 'https://api.asaas.com/v3',
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://api.asaas.com',
    })).toThrow('não corresponde ao ambiente');
  });

  it('rejects origin-prefix tricks and malformed allowlist entries', () => {
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override: 'https://proxy.example.com.evil.test/asaas/v3',
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://proxy.example.com',
    })).toThrow('não está na allowlist');
    expect(() => resolvePlatformAsaasBaseUrl({
      environment: 'sandbox',
      override: 'https://proxy.example.com/asaas/v3',
      allowSandboxOverride: true,
      allowedProxyOrigins: 'https://proxy.example.com/not-an-origin',
    })).toThrow('Origem permitida do proxy Asaas inválida');
  });
});
