import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export interface PlugueChatBroadcast {
  id: string;
  company_id: string;
  name?: string | null;
  template_id: string;
  template_name: string | null;
  audience_filter: Record<string, unknown>;
  status: string;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

async function throwFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response }).context;
  if (context) {
    let detailMessage: string | null = null;
    try {
      const detail = await context.clone().json();
      if (detail?.error) detailMessage = String(detail.error);
    } catch {
      detailMessage = null;
    }
    if (detailMessage) throw new Error(detailMessage);
  }
  throw error;
}

export function usePlugueChatBroadcasts(companyId?: string) {
  return useQuery({
    queryKey: ['pluguechat-broadcasts', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pluguechat_broadcasts' as any)
        .select('*')
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as PlugueChatBroadcast[];
    },
    enabled: !!companyId,
  });
}

export function useCreatePlugueChatBroadcast() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      company_id: string;
      name?: string | null;
      template_id: string;
      template_name?: string | null;
      recipient_reservation_ids?: string[];
      recipient_leads?: Array<{
        phone: string | null | undefined;
        guest_name?: string | null;
        reservation_id?: string | null;
        parameters?: Record<string, string>;
      }>;
      audience_filter?: Record<string, unknown>;
      scheduled_for?: string | null;
    }) => {
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: {
          action: 'create_broadcast',
          company_id: payload.company_id,
          name: payload.name ?? null,
          template_id: payload.template_id,
          template_name: payload.template_name ?? null,
          recipient_reservation_ids: payload.recipient_reservation_ids ?? [],
          recipient_leads: payload.recipient_leads ?? [],
          audience_filter: payload.audience_filter ?? {},
          scheduled_for: payload.scheduled_for ?? null,
        },
      });
      if (error) await throwFunctionError(error);
      if (data?.error) throw new Error(String(data.error));
      return data.broadcast as PlugueChatBroadcast;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-broadcasts', vars.company_id] });
      toast.success('Disparo criado.');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Erro ao criar disparo. Tente novamente.'),
  });
}

export function useCancelPlugueChatBroadcast() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, companyId }: { id: string; companyId: string }) => {
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: {
          action: 'cancel_broadcast',
          company_id: companyId,
          broadcast_id: id,
        },
      });
      if (error) await throwFunctionError(error);
      if (data?.error) throw new Error(String(data.error));
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-broadcasts', vars.companyId] });
      toast.success('Disparo cancelado.');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Erro ao cancelar disparo.'),
  });
}
