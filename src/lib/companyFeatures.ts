export type CompanyPlanTier = 'starter' | 'pro' | 'enterprise';
export type CompanyFeatureKey =
  | 'whatsapp_integration'
  | 'custom_public_page'
  | 'advanced_reports';

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
    label: 'Integracao WhatsApp',
    shortLabel: 'WhatsApp',
    description: 'Permite conectar instancias e automacoes via WhatsApp.',
  },
  {
    key: 'custom_public_page',
    label: 'Pagina publica customizada',
    shortLabel: 'Pagina publica',
    description: 'Libera personalizacao da vitrine publica da empresa.',
  },
  {
    key: 'advanced_reports',
    label: 'Relatorio avancado',
    shortLabel: 'Relatorios',
    description: 'Libera graficos, funil e analises detalhadas no dashboard.',
  },
];

const PLAN_DEFAULTS: Record<CompanyPlanTier, Record<CompanyFeatureKey, boolean>> = {
  starter: {
    whatsapp_integration: false,
    custom_public_page: false,
    advanced_reports: false,
  },
  pro: {
    whatsapp_integration: true,
    custom_public_page: true,
    advanced_reports: false,
  },
  enterprise: {
    whatsapp_integration: true,
    custom_public_page: true,
    advanced_reports: true,
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
