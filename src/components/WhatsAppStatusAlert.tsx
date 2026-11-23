import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { usePlugueChatConfig } from '@/hooks/usePlugueChatConfig';
import { useWhatsAppInstance } from '@/hooks/useAutomations';
import { useWhatsAppChannel } from '@/hooks/useWhatsAppChannel';

export default function WhatsAppStatusAlert() {
  const { companyId, slug } = useCompanySlug();
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
  const queueLabel = queueCount > 0
    ? `${queueCount.toLocaleString('pt-BR')} ${queueCount === 1 ? 'mensagem' : 'mensagens'} na fila`
    : null;

  // Abre Mensagens já na aba Canal, onde a conexão é refeita.
  const openChannelTab = () => {
    try {
      window.sessionStorage.setItem(`automations:tab:${companyId}`, 'channel');
    } catch { /* Sem armazenamento, a tela abre na aba padrão, que também é Canal. */ }
  };

  return (
    <Link
      to={`/${slug}/admin/automacoes`}
      onClick={openChannelTab}
      className="inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-destructive/25 bg-card px-3 py-1 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
      title={`WhatsApp desconectado: ${detail}. Abrir Mensagens › Canal para reconectar.`}
      aria-label={`WhatsApp desconectado${queueLabel ? `, ${queueLabel}` : ''}. Abrir o canal para reconectar`}
    >
      <WifiOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>WhatsApp desconectado</span>
      {queueLabel && (
        <span className="hidden font-medium text-destructive/75 md:inline">· {queueLabel}</span>
      )}
    </Link>
  );
}
