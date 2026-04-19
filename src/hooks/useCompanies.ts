import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { CompanyPlanTier } from '@/lib/companyFeatures';

export type CompanyStatus = 'active' | 'paused';

export interface Company {
  id: string;
  name: string;
  slug: string;
  plan_tier: CompanyPlanTier;
  razao_social: string | null;
  cnpj: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  responsible_name: string | null;
  responsible_email: string | null;
  responsible_phone: string | null;
  instagram: string | null;
  whatsapp: string | null;
  show_public_whatsapp_button?: boolean | null;
  show_public_sticky_reserve_button?: boolean | null;
  show_public_reservation_exit_prompt?: boolean | null;
  public_reservation_exit_prompt_primary_text?: string | null;
  public_reservation_exit_prompt_primary_text_size?: string | null;
  public_reservation_exit_prompt_secondary_text?: string | null;
  public_reservation_exit_prompt_secondary_text_size?: string | null;
  public_waitlist_enabled?: boolean | null;
  google_maps_url: string | null;
  description: string | null;
  logo_url: string | null;
  opening_hours: any[] | null;
  payment_methods: Record<string, boolean> | null;
  reservation_duration: number | null;
  max_guests_per_slot: number | null;
  status: CompanyStatus;
  created_at: string;
  updated_at: string;
}

export type CompanyInsert = Omit<Company, 'id' | 'created_at' | 'updated_at' | 'plan_tier'> & {
  plan_tier?: CompanyPlanTier;
};

function getCompanyMutationErrorMessage(err: any, fallbackPrefix: string) {
  const message = String(err?.message || '');
  const details = String(err?.details || '');
  const code = String(err?.code || '');
  const combined = `${message} ${details}`.toLowerCase();

  if (
    combined.includes('companies_cnpj_key') ||
    (code === '23505' && combined.includes('(cnpj)'))
  ) {
    return 'Ja existe uma empresa com este CNPJ';
  }

  if (
    combined.includes('companies_slug_key') ||
    (code === '23505' && combined.includes('(slug)'))
  ) {
    return 'Ja existe uma empresa com este slug';
  }

  if (combined.includes('already been registered')) {
    return 'Este email ja esta cadastrado no sistema';
  }

  return message ? `${fallbackPrefix}: ${message}` : fallbackPrefix;
}

export function useCompanies() {
  return useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Company[];
    },
  });
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (company: CompanyInsert) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Não autenticado');

      const response = await supabase.functions.invoke('create-company', {
        body: company,
      });

      if (response.error) throw response.error;
      const result = response.data;
      if (result?.error) throw new Error(result.error);
      return result;
    },
    onSuccess: async (data) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      if (data?.warning) {
        toast.warning(data.warning);
      }

      if (data?.admin_user?.access_link) {
        try {
          await navigator.clipboard.writeText(data.admin_user.access_link);
          toast.success('Empresa criada. Link unico do admin copiado.');
          return;
        } catch {
          toast.success('Empresa criada. Link unico do admin gerado.');
          return;
        }
      }

      toast.success('Empresa criada com sucesso!');
    },
    onError: (err: any) => {
      toast.error(getCompanyMutationErrorMessage(err, 'Erro ao criar empresa'));
    },
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Company> & { id: string }) => {
      const { data, error } = await supabase
        .from('companies' as any)
        .update({ ...updates, updated_at: new Date().toISOString() } as any)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as Company;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa atualizada!');
    },
    onError: (err: any) => {
      toast.error(getCompanyMutationErrorMessage(err, 'Erro ao atualizar'));
    },
  });
}

export function useDeleteCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('companies' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa removida!');
    },
    onError: (err: any) => {
      toast.error(`Erro ao remover: ${err.message}`);
    },
  });
}
