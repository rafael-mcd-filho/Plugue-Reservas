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

type AutomationWrite = Pick<AutomationSetting, 'company_id' | 'type' | 'enabled' | 'message_template'>;

export interface WhatsAppInstance {
  id: string;
  company_id: string;
  instance_name: string;
  status: string;
  phone_number: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
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
  refresh_profile?: boolean;
}

export function useAutomationSettings(companyId?: string, enabled = true) {
  return useQuery({
    queryKey: ['automation-settings', companyId],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from('automation_settings' as any)
        .select('*')
        .eq('company_id', companyId!)
        .abortSignal(signal);

      if (error) throw error;
      return (data ?? []) as unknown as AutomationSetting[];
    },
    enabled: !!companyId && enabled,
  });
}

export function useUpsertAutomation() {
  const qc = useQueryClient();

  return useMutation({
    onMutate: async (automation: AutomationWrite) => {
      await qc.cancelQueries({ queryKey: ['automation-settings', automation.company_id], exact: true });
    },
    mutationFn: async (automation: AutomationWrite) => {
      const { data, error } = await supabase
        .from('automation_settings' as any)
        .upsert(
          {
            ...automation,
            updated_at: new Date().toISOString(),
          } as any,
          { onConflict: 'company_id,type' },
        )
        .select('*')
        .single();

      if (error) throw error;
      return data as unknown as AutomationSetting;
    },
    onSuccess: async (saved, vars) => {
      await qc.cancelQueries({ queryKey: ['automation-settings', vars.company_id], exact: true });
      qc.setQueryData<AutomationSetting[]>(['automation-settings', vars.company_id], (previous = []) => [
        ...previous.filter((item) => item.type !== vars.type), saved,
      ]);
      void qc.invalidateQueries({ queryKey: ['automation-settings', vars.company_id], exact: true });
      toast.success('Automação salva!');
    },
    onError: () => toast.error('Erro ao salvar automação. Tente novamente.'),
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
  const { isImpersonatingCompany, effectiveRole, scopeCompanyId } = useImpersonation();

  return useMutation({
    mutationFn: async (payload: EvolutionApiPayload) => {
      const { data, error } = await supabase.functions.invoke('evolution-api', {
        body: {
          ...payload,
          ...(isImpersonatingCompany && scopeCompanyId
            ? {
                scope_company_id: scopeCompanyId,
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
