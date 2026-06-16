import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { usePlugueChatConfig } from '@/hooks/usePlugueChatConfig';
import { useWhatsAppInstance } from '@/hooks/useAutomations';
import { useWhatsAppChannel } from '@/hooks/useWhatsAppChannel';

export default function WhatsAppStatusAlert() {
  const { companyId } = useCompanySlug();
  const { data: featureFlags } = useCompanyFeatureFlags(companyId);
  const { data: activeChannel, isLoading: channelLoading } = useWhatsAppChannel(companyId);
  const { data: instance, isLoading: instanceLoading } = useWhatsAppInstance(companyId);
  const { data: plugueChatConfig, isLoading: plugueChatLoading } = usePlugueChatConfig(companyId);

  const channel = activeChannel ?? 'evolution';
  const isPlugueChatConfigured = !!(plugueChatConfig?.from_number && plugueChatConfig.status === 'configured');
  const evolutionDisconnected = channel === 'evolution' && instance?.status !== 'connected';
  const plugueChatDisconnected = channel === 'pluguechat_official' && !isPlugueChatConfigured;
  const statusLoading =
    channelLoading ||
    (channel === 'evolution' && instanceLoading) ||
    (channel === 'pluguechat_official' && plugueChatLoading);
  const shouldShowAlert =
    !!companyId &&
    !!featureFlags?.features.whatsapp_integration &&
    !statusLoading &&
    (evolutionDisconnected || plugueChatDisconnected);

  const { data: queueCount = 0 } = useQuery({
    queryKey: ['active-whatsapp-queue-count', companyId, channel],
    queryFn: async () => {
      const table = channel === 'pluguechat_official' ? 'pluguechat_message_queue' : 'whatsapp_message_queue';
      const { count, error } = await supabase
        .from(table as any)
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId!)
        .eq('status', 'pending');
      if (error) throw error;
      return count || 0;
    },
    refetchInterval: 30000,
    enabled: shouldShowAlert,
  });

  if (!shouldShowAlert) {
    return null;
  }

  const detail =
    channel === 'pluguechat_official'
      ? 'PlugueChat sem credenciais completas'
      : 'Evolution desconectada';

  return (
    <div
      className="flex min-w-0 max-w-[46vw] shrink items-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-1.5 text-sm sm:max-w-xs"
      title={`WhatsApp desconectado - ${detail}`}
    >
      <WifiOff className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 truncate font-medium text-destructive">WhatsApp desconectado</span>
      {queueCount > 0 && (
        <span className="hidden truncate text-destructive/70 sm:inline">
          {' - '}{queueCount} {queueCount === 1 ? 'mensagem' : 'mensagens'} na fila
        </span>
      )}
    </div>
  );
}
