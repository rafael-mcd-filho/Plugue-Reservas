import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export type WhatsAppChannel = 'evolution' | 'pluguechat_official';

export function useWhatsAppChannel(companyId?: string) {
  return useQuery({
    queryKey: ['whatsapp-channel', companyId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_company_whatsapp_channel' as any, {
        _company_id: companyId!,
      });
      if (error) throw error;
      return (data ?? 'evolution') as WhatsAppChannel;
    },
    enabled: !!companyId,
    retry: false,
    staleTime: 30_000,
  });
}

export function useSwitchWhatsAppChannel() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { company_id: string; channel: WhatsAppChannel; expected_channel: WhatsAppChannel }) => {
      const { data, error } = await supabase.functions.invoke('whatsapp-automation-channel', {
        body: { action: 'switch', ...payload },
      });
      if (error) throw error;
      return data as { channel: WhatsAppChannel };
    },
    onSuccess: (result, vars) => {
      qc.invalidateQueries({ queryKey: ['whatsapp-channel', vars.company_id] });
      const label = result.channel === 'pluguechat_official' ? 'PlugueChat Oficial' : 'WhatsApp conectado';
      toast.success(`Canal alterado para ${label}.`);
    },
    onError: (err: any) => {
      const message: string = err?.message ?? '';
      if (message.includes('channel_mismatch')) {
        toast.error('O canal mudou em outra aba. Atualize a página e tente novamente.');
      } else {
        toast.error('Erro ao trocar canal. Tente novamente.');
      }
    },
  });
}
