import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';

export default function WhatsAppStatusAlert() {
  const { companyId } = useCompanySlug();
  const { data: featureFlags } = useCompanyFeatureFlags(companyId);

  const { data: instance } = useQuery({
    queryKey: ['whatsapp-instance-status', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_whatsapp_instances')
        .select('status, instance_name')
        .eq('company_id', companyId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  const { data: queueCount = 0 } = useQuery({
    queryKey: ['whatsapp-queue-count', companyId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('whatsapp_message_queue' as any)
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'pending');
      if (error) throw error;
      return count || 0;
    },
    refetchInterval: 30000,
    enabled: instance?.status === 'disconnected',
  });

  if (!featureFlags?.features.whatsapp_integration || !instance || instance.status === 'connected') {
    return null;
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm">
      <WifiOff className="h-4 w-4 shrink-0 text-destructive" />
      <span className="font-medium text-destructive">WhatsApp desconectado</span>
      {queueCount > 0 && (
        <span className="text-destructive/70">
          {' - '} {queueCount} {queueCount === 1 ? 'mensagem' : 'mensagens'} na fila
        </span>
      )}
    </div>
  );
}
