import AutomationsTab from '@/components/company/AutomationsTab';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useCompanySlug } from '@/contexts/CompanySlugContext';

export default function CompanyAutomations() {
  const { companyId, companyName } = useCompanySlug();
  const { data: featureFlags, isLoading: featureFlagsLoading } = useCompanyFeatureFlags(companyId);
  const whatsappEnabled = featureFlags?.features.whatsapp_integration ?? false;

  if (featureFlagsLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Automações</h1>
        <p className="mt-1 text-muted-foreground">Envios automáticos via WhatsApp da unidade {companyName}</p>
      </div>

      {whatsappEnabled ? (
        <AutomationsTab companyId={companyId} />
      ) : (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
          A integração com WhatsApp está desabilitada para esta empresa. Libere a feature no perfil da empresa para
          ativar conexão, automações e histórico de mensagens.
        </div>
      )}
    </div>
  );
}
