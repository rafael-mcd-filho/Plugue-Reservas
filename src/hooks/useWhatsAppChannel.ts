import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export type WhatsAppChannel = 'evolution' | 'pluguechat_official';

const WHATSAPP_CHANNEL_SYNC_NAME = 'plugue-reservas:whatsapp-channel';
const WHATSAPP_CHANNEL_SYNC_STORAGE_KEY = 'plugue-reservas:whatsapp-channel-sync';
const CURRENT_TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type WhatsAppChannelSyncMessage = {
  type: 'whatsapp-channel-changed';
  companyId: string;
  channel: WhatsAppChannel;
  sourceId: string;
  updatedAt: number;
};

function isWhatsAppChannel(value: unknown): value is WhatsAppChannel {
  return value === 'evolution' || value === 'pluguechat_official';
}

function isChannelSyncMessage(value: unknown): value is WhatsAppChannelSyncMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WhatsAppChannelSyncMessage>;
  return (
    candidate.type === 'whatsapp-channel-changed' &&
    typeof candidate.companyId === 'string' &&
    isWhatsAppChannel(candidate.channel) &&
    typeof candidate.sourceId === 'string'
  );
}

function publishChannelChange(companyId: string, channel: WhatsAppChannel) {
  if (typeof window === 'undefined') return;

  const message: WhatsAppChannelSyncMessage = {
    type: 'whatsapp-channel-changed',
    companyId,
    channel,
    sourceId: CURRENT_TAB_ID,
    updatedAt: Date.now(),
  };

  try {
    const broadcast = new BroadcastChannel(WHATSAPP_CHANNEL_SYNC_NAME);
    broadcast.postMessage(message);
    broadcast.close();
  } catch {
    // BroadcastChannel is a best-effort cross-tab sync helper.
  }

  try {
    window.localStorage.setItem(WHATSAPP_CHANNEL_SYNC_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // localStorage is only used as a fallback signal for older browsers.
  }
}

export function useWhatsAppChannel(companyId?: string) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!companyId || typeof window === 'undefined') return;

    const applyMessage = (message: unknown) => {
      if (!isChannelSyncMessage(message)) return;
      if (message.companyId !== companyId) return;
      if (message.sourceId === CURRENT_TAB_ID) return;

      qc.setQueryData(['whatsapp-channel', companyId], message.channel);
      void qc.invalidateQueries({ queryKey: ['whatsapp-channel', companyId], exact: true });
    };

    let broadcast: BroadcastChannel | null = null;
    try {
      broadcast = new BroadcastChannel(WHATSAPP_CHANNEL_SYNC_NAME);
      broadcast.onmessage = (event) => applyMessage(event.data);
    } catch {
      broadcast = null;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== WHATSAPP_CHANNEL_SYNC_STORAGE_KEY || !event.newValue) return;
      try {
        applyMessage(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed cross-tab sync payloads.
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      broadcast?.close();
      window.removeEventListener('storage', handleStorage);
    };
  }, [companyId, qc]);

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
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
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
      qc.setQueryData(['whatsapp-channel', vars.company_id], result.channel);
      qc.invalidateQueries({ queryKey: ['whatsapp-channel', vars.company_id] });
      publishChannelChange(vars.company_id, result.channel);
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
