import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export interface PlugueChatBroadcast {
  id: string;
  company_id: string;
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
      template_id: string;
      template_name?: string | null;
      audience_filter?: Record<string, unknown>;
      scheduled_for?: string | null;
    }) => {
      const { data, error } = await supabase
        .from('pluguechat_broadcasts' as any)
        .insert({
          company_id: payload.company_id,
          template_id: payload.template_id,
          template_name: payload.template_name ?? null,
          audience_filter: payload.audience_filter ?? {},
          status: payload.scheduled_for ? 'scheduled' : 'draft',
          scheduled_for: payload.scheduled_for ?? null,
        } as any)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as PlugueChatBroadcast;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-broadcasts', vars.company_id] });
      toast.success('Disparo criado.');
    },
    onError: () => toast.error('Erro ao criar disparo. Tente novamente.'),
  });
}

export function useCancelPlugueChatBroadcast() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, companyId }: { id: string; companyId: string }) => {
      const { error } = await supabase
        .from('pluguechat_broadcasts' as any)
        .update({
          status: 'cancelled',
          cancel_reason: 'manual',
          cancelled_at: new Date().toISOString(),
        } as any)
        .eq('id', id)
        .eq('company_id', companyId)
        .in('status' as any, ['draft', 'scheduled']);

      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-broadcasts', vars.companyId] });
      toast.success('Disparo cancelado.');
    },
    onError: () => toast.error('Erro ao cancelar disparo.'),
  });
}
