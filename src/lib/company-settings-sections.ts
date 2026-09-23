export const COMPANY_SETTINGS_SECTIONS = [
  'empresa',
  'agenda',
  'reservas',
  'disponibilidade',
  'pagina-publica',
] as const;

export type CompanySettingsSection = (typeof COMPANY_SETTINGS_SECTIONS)[number];

// Como as seções aparecem no menu: o que descreve a casa fica em "Empresa"; o
// que o cliente encontra na hora de reservar fica em "Configurações".
export const COMPANY_PROFILE_SETTINGS_SECTIONS = [
  'empresa',
  'agenda',
  'reservas',
] as const satisfies readonly CompanySettingsSection[];

export const COMPANY_EXPERIENCE_SETTINGS_SECTIONS = [
  'disponibilidade',
  'pagina-publica',
] as const satisfies readonly CompanySettingsSection[];

export const DEFAULT_COMPANY_SETTINGS_SECTION: CompanySettingsSection = 'empresa';

// Os slugs seguem os antigos para nao quebrar links salvos; so os rotulos mudaram.
export const COMPANY_SETTINGS_SECTION_LABELS: Record<CompanySettingsSection, string> = {
  empresa: 'Cadastro',
  agenda: 'Horários',
  reservas: 'Regras de reservas',
  disponibilidade: 'Disponibilidade',
  'pagina-publica': 'Página Pública',
};

// As descricoes de Horarios, Regras e Disponibilidade se citam entre si: as tres
// definem a grade publicada, e a precedencia nao e obvia sozinha.
export const COMPANY_SETTINGS_SECTION_DESCRIPTIONS: Record<CompanySettingsSection, string> = {
  empresa: 'Dados, localização e pagamentos',
  agenda: 'Dias, horários e datas fechadas',
  reservas: 'Padrões que a disponibilidade pode substituir',
  disponibilidade: 'Substitui horários e padrões em datas e períodos',
  'pagina-publica': 'Mídia, textos e avisos',
};

// As abas antigas viraram paginas; o parametro ?tab= continua valendo como redirecionamento.
const LEGACY_TAB_SECTIONS: Record<string, CompanySettingsSection> = {
  info: 'empresa',
  location: 'empresa',
  payments: 'empresa',
  hours: 'agenda',
  blocked: 'agenda',
  reservations: 'reservas',
  availability: 'disponibilidade',
  'schedule-rules': 'disponibilidade',
  rules: 'disponibilidade',
  'public-page': 'pagina-publica',
};

export function isCompanySettingsSection(value: string | null | undefined): value is CompanySettingsSection {
  return !!value && COMPANY_SETTINGS_SECTIONS.includes(value as CompanySettingsSection);
}

export function resolveCompanySettingsSection(
  section: string | null | undefined,
  legacyTab?: string | null,
): CompanySettingsSection {
  if (isCompanySettingsSection(section)) return section;
  if (legacyTab && LEGACY_TAB_SECTIONS[legacyTab]) return LEGACY_TAB_SECTIONS[legacyTab];
  return DEFAULT_COMPANY_SETTINGS_SECTION;
}

export function getCompanySettingsSectionPath(slug: string, section: CompanySettingsSection) {
  return `/${slug}/admin/configuracoes/${section}`;
}
