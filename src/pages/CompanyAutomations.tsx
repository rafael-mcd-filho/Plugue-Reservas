import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Bot, Webhook } from 'lucide-react';
import AutomationsTab from '@/components/company/AutomationsTab';
import WebhooksTab from '@/components/company/WebhooksTab';
import type { Company } from '@/hooks/useCompanies';

export default function CompanyAutomations() {
  const { slug } = useParams<{ slug: string }>();

  const { data: company, isLoading } = useQuery({
    queryKey: ['company-automations', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('*')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Company | null;
    },
    enabled: !!slug,
  });

  if (isLoading) {
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
        <h1 className="text-3xl font-bold tracking-tight">Automações</h1>
        <p className="text-muted-foreground mt-1">Integrações e automações da unidade {company?.name}</p>
      </div>

      <Tabs defaultValue="automations" className="space-y-6">
        <TabsList>
          <TabsTrigger value="automations" className="gap-2"><Bot className="h-4 w-4" /> Automações</TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-2"><Webhook className="h-4 w-4" /> Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="automations">
          {company && <AutomationsTab companyId={company.id} />}
        </TabsContent>

        <TabsContent value="webhooks">
          {company && <WebhooksTab companyId={company.id} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
