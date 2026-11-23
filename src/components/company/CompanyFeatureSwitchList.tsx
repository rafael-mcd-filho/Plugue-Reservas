import { BarChart3, CreditCard, Globe, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { COMPANY_FEATURE_DEFINITIONS, CompanyFeatureKey } from '@/lib/companyFeatures';
import type { CompanyFeatureState } from '@/hooks/useCompanyFeatures';

interface CompanyFeatureSwitchListProps {
  features: CompanyFeatureState;
  disabled?: boolean;
  compact?: boolean;
  onToggle: (featureKey: CompanyFeatureKey, enabled: boolean) => void;
}

export default function CompanyFeatureSwitchList({
  features,
  disabled,
  compact = false,
  onToggle,
}: CompanyFeatureSwitchListProps) {
  return (
    <div className="space-y-3">
      {COMPANY_FEATURE_DEFINITIONS.map((feature) => {
        const enabled = features[feature.key];

        return (
          <div
            key={feature.key}
            className={`flex items-start justify-between gap-4 rounded-lg border border-border ${compact ? 'p-3' : 'p-4'}`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
                {getFeatureIcon(feature.key)}
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium`}>{feature.label}</p>
                  <Badge variant={enabled ? 'default' : 'secondary'}>
                    {enabled ? 'Ativo' : 'Desligado'}
                  </Badge>
                </div>
                <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground mt-1`}>
                  {feature.description}
                </p>
              </div>
            </div>
            <Switch
              checked={enabled}
              disabled={disabled}
              aria-label={feature.label}
              onCheckedChange={(checked) => onToggle(feature.key, checked)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function CompanyFeatureBadges({ features }: { features?: CompanyFeatureState | null }) {
  if (!features) return <span className="text-sm text-muted-foreground">—</span>;

  const activeFeatures = COMPANY_FEATURE_DEFINITIONS.filter((feature) => features[feature.key]);

  if (activeFeatures.length === 0) {
    return <span className="text-sm text-muted-foreground">Nenhuma ativa</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {activeFeatures.map((feature) => (
        <Badge key={feature.key} variant="secondary" className="text-[10px]">
          {feature.shortLabel}
        </Badge>
      ))}
    </div>
  );
}

/** Versão compacta para listas: quantidade de recursos ativos e a lista no passar do mouse. */
export function CompanyFeatureSummary({ features }: { features?: CompanyFeatureState | null }) {
  if (!features) return <span className="text-sm text-muted-foreground">—</span>;
  const activeFeatures = COMPANY_FEATURE_DEFINITIONS.filter((feature) => features[feature.key]);
  const total = COMPANY_FEATURE_DEFINITIONS.length;
  if (activeFeatures.length === 0) return <span className="text-sm text-muted-foreground">Nenhum ativo</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
          aria-label={`${activeFeatures.length} de ${total} recursos ativos: ${activeFeatures.map((feature) => feature.shortLabel).join(', ')}`}
        >
          {activeFeatures.length} de {total} ativos
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">
        {activeFeatures.map((feature) => feature.shortLabel).join(' · ')}
      </TooltipContent>
    </Tooltip>
  );
}

function getFeatureIcon(featureKey: CompanyFeatureKey) {
  if (featureKey === 'whatsapp_integration') return <MessageCircle className="h-4 w-4" />;
  if (featureKey === 'custom_public_page') return <Globe className="h-4 w-4" />;
  if (featureKey === 'reservation_prepayment') return <CreditCard className="h-4 w-4" />;
  return <BarChart3 className="h-4 w-4" />;
}
