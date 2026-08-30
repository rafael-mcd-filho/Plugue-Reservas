export const COMPANY_SETTINGS_SECTIONS = [
  'empresa',
  'agenda',
  'reservas',
  'disponibilidade',
  'pagina-publica',
] as const;

export type CompanySettingsSection = (typeof COMPANY_SETTINGS_SECTIONS)[number];

export const DEFAULT_COMPANY_SETTINGS_SECTION: CompanySettingsSection = 'empresa';

export const COMPANY_SETTINGS_SECTION_LABELS: Record<CompanySettingsSection, string> = {
  empresa: 'Empresa',
  agenda: 'Agenda',
  reservas: 'Reservas',
  disponibilidade: 'Disponibilidade',
  'pagina-publica': 'Página Pública',
};

export const COMPANY_SETTINGS_SECTION_DESCRIPTIONS: Record<CompanySettingsSection, string> = {
  empresa: 'Cadastro, localização e pagamentos',
  agenda: 'Horários e datas bloqueadas',
  reservas: 'Fluxo público de reservas',
  disponibilidade: 'Regras de agenda por período',
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
