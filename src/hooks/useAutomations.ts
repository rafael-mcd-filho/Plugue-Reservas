import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useImpersonation } from '@/hooks/useImpersonation';
import { supabase } from '@/integrations/supabase/client';

export interface AutomationSetting {
  id: string;
  company_id: string;
  type: string;
  enabled: boolean;
  message_template: string;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppInstance {
  id: string;
  company_id: string;
  instance_name: string;
  status: string;
  phone_number: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvolutionApiPayload {
  action: string;
  company_id: string;
  instance_name?: string;
  phone?: string;
  message?: string;
  log_id?: string;
}

export function useAutomationSettings(companyId?: string) {
  return useQuery({
    queryKey: ['automation-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('automation_settings' as any)
        .select('*')
        .eq('company_id', companyId!);

      if (error) throw error;
      return (data ?? []) as unknown as AutomationSetting[];
    },
    enabled: !!companyId,
  });
}

export function useUpsertAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (automation: { company_id: string; type: string; enabled: boolean; message_template: string }) => {
      const { error } = await supabase
        .from('automation_settings' as any)
        .upsert(
          {
            ...automation,
            updated_at: new Date().toISOString(),
          } as any,
          { onConflict: 'company_id,type' },
        );

      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['automation-settings', vars.company_id] });
      toast.success('Automação salva!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useWhatsAppInstance(companyId?: string) {
  return useQuery({
    queryKey: ['whatsapp-instance', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_whatsapp_instances' as any)
        .select('*')
        .eq('company_id', companyId!)
        .maybeSingle();

      if (error) throw error;
      return data as unknown as WhatsAppInstance | null;
    },
    enabled: !!companyId,
  });
}

export function useEvolutionApi() {
  const { isImpersonatingCompany, effectiveRole } = useImpersonation();

  return useMutation({
    mutationFn: async (payload: EvolutionApiPayload) => {
      const { data, error } = await supabase.functions.invoke('evolution-api', {
        body: {
          ...payload,
          ...(isImpersonatingCompany
            ? {
                scope_company_id: payload.company_id,
                impersonated_by_superadmin: true,
                effective_role: effectiveRole,
              }
            : {}),
        },
      });

      if (error) throw error;
      return data;
    },
  });
}
