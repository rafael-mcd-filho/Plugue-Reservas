import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { CompanyPlanTier } from '@/lib/companyFeatures';
import { getFunctionErrorMessage } from '@/lib/functionErrors';

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
  custom_public_page_enabled?: boolean | null;
  public_header_style?: 'classic' | 'modern' | null;
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
  hero_media_url?: string | null;
  hero_media_type?: 'image' | 'video' | null;
  opening_hours: any[] | null;
  payment_methods: Record<string, boolean> | null;
  reservation_duration: number | null;
  reservation_slot_interval_minutes: number | null;
  max_guests_per_slot: number | null;
  large_party_whatsapp_threshold?: number | null;
  reservation_late_tolerance_minutes?: number | null;
  status: CompanyStatus;
  deletion_requested_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type CompanyDeletionRequestStatus =
  | 'grace_period' | 'running' | 'needs_attention' | 'completed' | 'failed' | 'canceled';

export const COMPANY_DELETION_REQUEST_STATUS_LABEL: Record<CompanyDeletionRequestStatus, string> = {
  grace_period: 'Em carência (cancelável)',
  running: 'Excluindo em lotes...',
  needs_attention: 'Precisa de atenção',
  completed: 'Concluída',
  failed: 'Falhou',
  canceled: 'Cancelada',
};

export interface CompanyDeletionRequest {
  id: string;
  company_id: string;
  company_name_snapshot: string;
  company_slug_snapshot: string;
  requested_by: string;
  requested_reason: string;
  confirmation_text: string;
  requested_at: string;
  status: CompanyDeletionRequestStatus;
  grace_period_ends_at: string;
  canceled_by: string | null;
  canceled_at: string | null;
  phase_index: number;
  phase: string | null;
  deleted_counts: Record<string, number>;
  external_teardown_result: Record<string, unknown>;
  impact_preview: Record<string, number>;
  attempts: number;
  consecutive_errors: number;
  last_error: string | null;
  started_processing_at: string | null;
  completed_at: string | null;
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

      if (response.error) {
        const message = await getFunctionErrorMessage(response.error);
        const error = new Error(message) as Error & { original?: unknown };
        error.original = response.error;
        throw error;
      }

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

// Deletion no longer runs as a single synchronous DELETE from the browser --
// that cascades through ~60 tables in one statement and blows the
// authenticated role's 8s statement_timeout for any company with real
// history (see docs/problema-exclusao-empresas.md). Instead, a superadmin
// requests deletion; a cancelable grace period follows; then a service_role
// worker drains the company's data in small batches (supabase/migrations/
// 20260826162000_add_company_deletion_engine.sql) before removing the
// company row itself.

export function getCompanyDeletionRequestErrorMessage(err: any): string {
  const code = String(err?.code || '');
  const message = String(err?.message || '');

  if (code === '55006') return 'Já existe uma solicitação de exclusão ativa para esta empresa.';
  if (code === '55000') return 'A exclusão assíncrona de empresas está temporariamente desativada.';
  if (code === '22023' && message.toLowerCase().includes('confirma')) {
    return 'O texto digitado não corresponde ao nome ou identificador da empresa.';
  }
  if (code === '42501') return 'Somente superadministradores podem solicitar a exclusão de empresas.';

  return message ? `Erro ao solicitar exclusão: ${message}` : 'Não foi possível solicitar a exclusão da empresa.';
}

export function useCompanyDeletionRequests() {
  return useQuery({
    queryKey: ['company-deletion-requests'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_company_deletion_requests' as any);
      if (error) throw error;
      return (data ?? []) as CompanyDeletionRequest[];
    },
    // Light polling so progress/status are visible without a manual refresh
    // while a deletion is in its grace period or actively running.
    refetchInterval: 15000,
  });
}

export function useRequestCompanyDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      companyId, confirmationText, reason,
    }: { companyId: string; confirmationText: string; reason: string }) => {
      const { data, error } = await supabase.rpc('request_company_deletion' as any, {
        _company_id: companyId,
        _confirmation_text: confirmationText,
        _reason: reason,
      });
      if (error) throw error;
      return data as { request_id: string; grace_period_ends_at: string; impact_preview: Record<string, number> };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['company-deletion-requests'] });
      toast.success('Exclusão solicitada. A empresa entrou em período de carência cancelável.');
    },
    onError: (err: any) => toast.error(getCompanyDeletionRequestErrorMessage(err)),
  });
}

export function useCancelCompanyDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (companyId: string) => {
      const { data, error } = await supabase.rpc('cancel_company_deletion' as any, { _company_id: companyId });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['company-deletion-requests'] });
      toast.success('Exclusão cancelada.');
    },
    onError: (err: any) => toast.error(`Erro ao cancelar: ${err.message}`),
  });
}

export function useForceSkipCompanyDeletionTeardown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (companyId: string) => {
      const { data, error } = await supabase.rpc('force_skip_company_deletion_teardown' as any, {
        _company_id: companyId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-deletion-requests'] });
      toast.success('Etapa externa pulada manualmente; a exclusão vai continuar.');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}
