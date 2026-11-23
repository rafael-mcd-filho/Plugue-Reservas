import AutomationsTab from '@/components/company/AutomationsTab';
import { Skeleton } from '@/components/ui/skeleton';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useWhatsAppChannel } from '@/hooks/useWhatsAppChannel';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';

export default function CompanyAutomations() {
  const { companyId, companyName } = useCompanySlug();
  const { data: featureFlags, isLoading: featureFlagsLoading, isPending: featureFlagsPending, isError: featureFlagsError, refetch, isFetching } = useCompanyFeatureFlags(companyId);
  // Prefetch em paralelo com feature flags — quando AutomationsTab montar, o cache já estará quente
  useWhatsAppChannel(companyId);
  const whatsappEnabled = featureFlags?.features.whatsapp_integration ?? false;
  const [openedCompany, setOpenedCompany] = useState<string | null>(null);
  useEffect(() => {
    if (!featureFlagsError && !featureFlagsPending && whatsappEnabled) setOpenedCompany(companyId);
  }, [companyId, featureFlagsError, featureFlagsPending, whatsappEnabled]);
  const retainEditor = openedCompany === companyId && featureFlagsError;

  if (featureFlagsError && !retainEditor) {
    return <div role="alert" className="space-y-3 text-sm">
      <p>Não foi possível verificar o acesso às mensagens da unidade. Tente novamente para continuar.</p>
      <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>Tentar novamente</Button>
    </div>;
  }

  if (featureFlagsLoading || featureFlagsPending) {
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
        <h1 className="text-xl font-semibold tracking-tight">Mensagens</h1>
        <p className="mt-1 text-muted-foreground">Canal WhatsApp, automações e histórico de mensagens da unidade {companyName}</p>
      </div>

      {featureFlagsError && <div role="alert" className="space-y-3 text-sm">
        <p>Não foi possível verificar o acesso às mensagens da unidade. Suas edições foram mantidas; tente novamente para continuar.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>Tentar novamente</Button>
      </div>}
      {whatsappEnabled || retainEditor ? (
        <div hidden={featureFlagsError}><AutomationsTab companyId={companyId} saveBlocked={featureFlagsError} /></div>
      ) : (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
          A integração com WhatsApp está desabilitada para esta empresa. Libere a feature no perfil da empresa para
          ativar conexão, automações e histórico de mensagens.
        </div>
      )}
    </div>
  );
}
