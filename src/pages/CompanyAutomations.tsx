import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Bot, Webhook } from 'lucide-react';
import AutomationsTab from '@/components/company/AutomationsTab';
import WebhooksTab from '@/components/company/WebhooksTab';
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
        <p className="mt-1 text-muted-foreground">Integrações e automações da unidade {companyName}</p>
      </div>

      <Tabs defaultValue={whatsappEnabled ? 'automations' : 'webhooks'} className="space-y-6">
        <TabsList>
          <TabsTrigger value="automations" className="gap-2">
            <Bot className="h-4 w-4" /> Automações
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-2">
            <Webhook className="h-4 w-4" /> Webhooks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="automations">
          {whatsappEnabled ? (
            <AutomationsTab companyId={companyId} />
          ) : (
            <div className="rounded-lg border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
              A integração com WhatsApp está desabilitada para esta empresa. Libere a feature no perfil da empresa para
              ativar conexão, automações e histórico de mensagens.
            </div>
          )}
        </TabsContent>

        <TabsContent value="webhooks">
          <WebhooksTab companyId={companyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
