export const DEFAULT_COMPANY_TIME_ZONE = 'America/Sao_Paulo';

export interface CompanyTimeZoneOption {
  value: string;
  label: string;
  offsetLabel: string;
}

/**
 * Os quatro fusos que realmente diferem no Brasil hoje. Os demais identificadores
 * IANA brasileiros (Fortaleza, Recife, Bahia, Cuiaba...) existem por historico de
 * horario de verao, encerrado em 2019: para qualquer data posterior eles produzem
 * exatamente o mesmo resultado que a opcao canonica correspondente, entao listar
 * todos so poluiria o seletor.
 */
export const COMPANY_TIME_ZONE_OPTIONS: CompanyTimeZoneOption[] = [
  { value: 'America/Noronha', label: 'Fernando de Noronha', offsetLabel: '-2 horas' },
  { value: 'America/Sao_Paulo', label: 'Brasília', offsetLabel: '-3 horas' },
  { value: 'America/Manaus', label: 'Amazonas', offsetLabel: '-4 horas' },
  { value: 'America/Rio_Branco', label: 'Acre', offsetLabel: '-5 horas' },
];

/**
 * Fusos brasileiros equivalentes a uma das opcoes canonicas. Mantem selecionavel
 * o valor ja gravado de empresas antigas sem exibir uma opcao redundante.
 */
const EQUIVALENT_TIME_ZONES: Record<string, string> = {
  'America/Fortaleza': 'America/Sao_Paulo',
  'America/Recife': 'America/Sao_Paulo',
  'America/Bahia': 'America/Sao_Paulo',
  'America/Maceio': 'America/Sao_Paulo',
  'America/Belem': 'America/Sao_Paulo',
  'America/Santarem': 'America/Sao_Paulo',
  'America/Araguaina': 'America/Sao_Paulo',
  'America/Cuiaba': 'America/Manaus',
  'America/Campo_Grande': 'America/Manaus',
  'America/Porto_Velho': 'America/Manaus',
  'America/Boa_Vista': 'America/Manaus',
  'America/Eirunepe': 'America/Rio_Branco',
};

const KNOWN_VALUES = new Set(COMPANY_TIME_ZONE_OPTIONS.map((option) => option.value));

export function isKnownCompanyTimeZone(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_VALUES.has(value.trim());
}

/**
 * Aceita qualquer fuso IANA que o runtime reconheca, para nao descartar um valor
 * legitimo gravado fora da lista brasileira.
 */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (KNOWN_VALUES.has(trimmed)) return true;

  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Converte um fuso gravado para a opcao canonica equivalente, preservando
 * qualquer valor valido que nao tenha equivalente conhecido.
 */
export function resolveCompanyTimeZone(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_COMPANY_TIME_ZONE;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_COMPANY_TIME_ZONE;
  if (KNOWN_VALUES.has(trimmed)) return trimmed;

  const equivalent = EQUIVALENT_TIME_ZONES[trimmed];
  if (equivalent) return equivalent;

  return isSupportedTimeZone(trimmed) ? trimmed : DEFAULT_COMPANY_TIME_ZONE;
}

export function normalizeCompanyTimeZone(value: unknown): string {
  return resolveCompanyTimeZone(value);
}

/**
 * Garante que um fuso valido sem equivalente conhecido continue selecionavel, em
 * vez de o seletor trocar silenciosamente o valor da empresa ao abrir a tela.
 */
export function buildCompanyTimeZoneOptions(currentValue: unknown): CompanyTimeZoneOption[] {
  const resolved = resolveCompanyTimeZone(currentValue);
  if (KNOWN_VALUES.has(resolved)) return COMPANY_TIME_ZONE_OPTIONS;

  return [
    ...COMPANY_TIME_ZONE_OPTIONS,
    { value: resolved, label: resolved, offsetLabel: 'personalizado' },
  ];
}

export function formatCompanyTimeZoneLabel(value: string): string {
  const option = COMPANY_TIME_ZONE_OPTIONS.find((candidate) => candidate.value === value);
  return option ? `${option.label} (${option.offsetLabel})` : value;
}
