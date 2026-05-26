import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

export interface PlugueChatConfig {
  id: string;
  company_id: string;
  enabled: boolean;
  from_number: string;
  status: string;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  // api_token_encrypted nunca é retornado ao frontend
}

export interface PlugueChatTemplate {
  id: string;
  company_id: string;
  type: string;
  enabled: boolean;
  template_id: string;
  template_name: string | null;
  created_at: string;
  updated_at: string;
}

export function usePlugueChatConfig(companyId?: string) {
  return useQuery({
    queryKey: ['pluguechat-config', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pluguechat_official_configs' as any)
        .select('id,company_id,enabled,from_number,status,last_success_at,last_error,created_at,updated_at')
        .eq('company_id', companyId!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as PlugueChatConfig | null;
    },
    enabled: !!companyId,
  });
}

export function useSavePlugueChatConfig() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { company_id: string; from_number: string; api_token?: string }) => {
      const { data, error } = await supabase.functions.invoke('pluguechat-api', {
        body: { action: 'save_config', ...payload },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-config', vars.company_id] });
      toast.success('Configuração salva.');
    },
    onError: () => toast.error('Erro ao salvar configuração. Tente novamente.'),
  });
}

export function usePlugueChatTemplates(companyId?: string) {
  return useQuery({
    queryKey: ['pluguechat-templates', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pluguechat_automation_templates' as any)
        .select('*')
        .eq('company_id', companyId!);
      if (error) throw error;
      return (data ?? []) as unknown as PlugueChatTemplate[];
    },
    enabled: !!companyId,
  });
}

export function useUpsertPlugueChatTemplate() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (template: {
      company_id: string;
      type: string;
      enabled: boolean;
      template_id: string;
      template_name?: string | null;
    }) => {
      const { error } = await supabase
        .from('pluguechat_automation_templates' as any)
        .upsert(
          {
            ...template,
            updated_at: new Date().toISOString(),
          } as any,
          { onConflict: 'company_id,type' },
        );
      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pluguechat-templates', vars.company_id] });
      toast.success('Template salvo.');
    },
    onError: () => toast.error('Erro ao salvar template. Tente novamente.'),
  });
}
