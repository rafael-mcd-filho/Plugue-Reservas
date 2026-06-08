export type CompanyPlanTier = 'starter' | 'pro' | 'enterprise';
export type CompanyFeatureKey =
  | 'whatsapp_integration'
  | 'custom_public_page'
  | 'advanced_reports'
  | 'active_communication'
  | 'flow_protection'
  | 'reservation_prepayment'
  | 'nps_surveys';

export interface CompanyFeatureDefinition {
  key: CompanyFeatureKey;
  label: string;
  shortLabel: string;
  description: string;
}

export const COMPANY_PLAN_LABELS: Record<CompanyPlanTier, string> = {
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

export const COMPANY_FEATURE_DEFINITIONS: CompanyFeatureDefinition[] = [
  {
    key: 'whatsapp_integration',
    label: 'Integração WhatsApp',
    shortLabel: 'WhatsApp',
    description: 'Permite conectar instâncias e automações via WhatsApp.',
  },
  {
    key: 'custom_public_page',
    label: 'Página pública customizada',
    shortLabel: 'Página pública',
    description: 'Libera personalização da vitrine pública da empresa.',
  },
  {
    key: 'advanced_reports',
    label: 'Relatório avançado',
    shortLabel: 'Relatórios',
    description: 'Libera gráficos, funil e análises detalhadas no dashboard.',
  },
  {
    key: 'active_communication',
    label: 'Comunicação ativa',
    shortLabel: 'Comunicação',
    description: 'Habilita avisos e pop-ups na página pública de reservas.',
  },
  {
    key: 'flow_protection',
    label: 'Proteções de fluxo',
    shortLabel: 'Proteções',
    description: 'Habilita configurações de proteção do fluxo público de reservas.',
  },
  {
    key: 'reservation_prepayment',
    label: 'Pagamentos antecipados',
    shortLabel: 'Pagamentos',
    description: 'Habilita regras de sinal por Pix e cartão via Asaas antes de confirmar reservas.',
  },
  {
    key: 'nps_surveys',
    label: 'Avaliações pós-visita',
    shortLabel: 'Avaliações',
    description: 'Habilita coleta de NPS e satisfação após cada check-in.',
  },
];

const PLAN_DEFAULTS: Record<CompanyPlanTier, Record<CompanyFeatureKey, boolean>> = {
  starter: {
    whatsapp_integration: false,
    custom_public_page: false,
    advanced_reports: false,
    active_communication: false,
    flow_protection: false,
    reservation_prepayment: false,
    nps_surveys: false,
  },
  pro: {
    whatsapp_integration: true,
    custom_public_page: true,
    advanced_reports: false,
    active_communication: true,
    flow_protection: true,
    reservation_prepayment: false,
    nps_surveys: false,
  },
  enterprise: {
    whatsapp_integration: true,
    custom_public_page: true,
    advanced_reports: true,
    active_communication: true,
    flow_protection: true,
    reservation_prepayment: false,
    nps_surveys: false,
  },
};

export function normalizeCompanyPlanTier(value: string | null | undefined): CompanyPlanTier {
  if (value === 'starter' || value === 'pro' || value === 'enterprise') {
    return value;
  }

  return 'enterprise';
}

export function getPlanDefaultFeatures(planTier: CompanyPlanTier): Record<CompanyFeatureKey, boolean> {
  return PLAN_DEFAULTS[planTier];
}

export function resolveCompanyFeatures(
  planTier: CompanyPlanTier,
  overrides: Partial<Record<CompanyFeatureKey, boolean>>,
): Record<CompanyFeatureKey, boolean> {
  const defaults = getPlanDefaultFeatures(planTier);

  return COMPANY_FEATURE_DEFINITIONS.reduce((acc, definition) => {
    acc[definition.key] = overrides[definition.key] ?? defaults[definition.key];
    return acc;
  }, {} as Record<CompanyFeatureKey, boolean>);
}
