import { describe, expect, it } from 'vitest';
import {
  COMPANY_TIME_ZONE_OPTIONS,
  DEFAULT_COMPANY_TIME_ZONE,
  buildCompanyTimeZoneOptions,
  formatCompanyTimeZoneLabel,
  isKnownCompanyTimeZone,
  isSupportedTimeZone,
  normalizeCompanyTimeZone,
  resolveCompanyTimeZone,
} from './company-time-zones';

describe('company-time-zones', () => {
  it('expoe apenas fusos IANA reconhecidos pelo runtime', () => {
    for (const option of COMPANY_TIME_ZONE_OPTIONS) {
      expect(() => new Intl.DateTimeFormat('pt-BR', { timeZone: option.value })).not.toThrow();
    }
  });

  it('oferece um unico fuso por offset, sem repetir -3 horas', () => {
    const offsets = COMPANY_TIME_ZONE_OPTIONS.map((option) => option.offsetLabel);
    expect(offsets).toEqual(['-2 horas', '-3 horas', '-4 horas', '-5 horas']);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('usa o horario de Brasilia como padrao', () => {
    expect(DEFAULT_COMPANY_TIME_ZONE).toBe('America/Sao_Paulo');
    expect(COMPANY_TIME_ZONE_OPTIONS.map((o) => o.value)).toContain(DEFAULT_COMPANY_TIME_ZONE);
  });

  it('reconhece apenas os fusos canonicos como itens da lista', () => {
    expect(isKnownCompanyTimeZone('America/Manaus')).toBe(true);
    expect(isKnownCompanyTimeZone('  America/Sao_Paulo  ')).toBe(true);
    expect(isKnownCompanyTimeZone('America/Fortaleza')).toBe(false);
    expect(isKnownCompanyTimeZone(null)).toBe(false);
  });

  it('aceita fuso IANA valido fora da lista brasileira', () => {
    expect(isSupportedTimeZone('Europe/Lisbon')).toBe(true);
    expect(isSupportedTimeZone('America/Manaus')).toBe(true);
    expect(isSupportedTimeZone('Fuso/Inexistente')).toBe(false);
    expect(isSupportedTimeZone('')).toBe(false);
  });

  it('resolve fusos UTC-3 equivalentes para o horario de Brasilia', () => {
    for (const equivalent of [
      'America/Fortaleza',
      'America/Recife',
      'America/Bahia',
      'America/Maceio',
      'America/Belem',
      'America/Santarem',
      'America/Araguaina',
    ]) {
      expect(resolveCompanyTimeZone(equivalent)).toBe('America/Sao_Paulo');
    }
  });

  it('resolve fusos UTC-4 e UTC-5 equivalentes', () => {
    for (const equivalent of ['America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista']) {
      expect(resolveCompanyTimeZone(equivalent)).toBe('America/Manaus');
    }
    expect(resolveCompanyTimeZone('America/Eirunepe')).toBe('America/Rio_Branco');
  });

  it('preserva fusos canonicos e valores validos sem equivalente', () => {
    expect(resolveCompanyTimeZone('America/Manaus')).toBe('America/Manaus');
    expect(resolveCompanyTimeZone('America/Noronha')).toBe('America/Noronha');
    expect(resolveCompanyTimeZone('Europe/Lisbon')).toBe('Europe/Lisbon');
  });

  it('normaliza valores invalidos para o default', () => {
    expect(normalizeCompanyTimeZone('')).toBe(DEFAULT_COMPANY_TIME_ZONE);
    expect(normalizeCompanyTimeZone(null)).toBe(DEFAULT_COMPANY_TIME_ZONE);
    expect(normalizeCompanyTimeZone('Fuso/Inexistente')).toBe(DEFAULT_COMPANY_TIME_ZONE);
    expect(normalizeCompanyTimeZone(' America/Manaus ')).toBe('America/Manaus');
  });

  it('nao acrescenta opcao para fuso equivalente ja coberto pela lista', () => {
    expect(buildCompanyTimeZoneOptions('America/Fortaleza')).toHaveLength(COMPANY_TIME_ZONE_OPTIONS.length);
    expect(buildCompanyTimeZoneOptions('America/Cuiaba')).toHaveLength(COMPANY_TIME_ZONE_OPTIONS.length);
    expect(buildCompanyTimeZoneOptions('')).toHaveLength(COMPANY_TIME_ZONE_OPTIONS.length);
  });

  it('preserva um fuso valido sem equivalente como opcao selecionavel', () => {
    const options = buildCompanyTimeZoneOptions('Europe/Lisbon');
    expect(options).toHaveLength(COMPANY_TIME_ZONE_OPTIONS.length + 1);
    expect(options.at(-1)).toEqual({
      value: 'Europe/Lisbon',
      label: 'Europe/Lisbon',
      offsetLabel: 'personalizado',
    });
  });

  it('formata rotulo com offset e cai para o proprio valor quando desconhecido', () => {
    expect(formatCompanyTimeZoneLabel('America/Manaus')).toBe('Amazonas (-4 horas)');
    expect(formatCompanyTimeZoneLabel('Europe/Lisbon')).toBe('Europe/Lisbon');
  });
});
