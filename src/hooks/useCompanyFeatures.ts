import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  COMPANY_FEATURE_DEFINITIONS,
  CompanyFeatureKey,
  getPlanDefaultFeatures,
  resolveCompanyFeatures,
  normalizeCompanyPlanTier,
} from '@/lib/companyFeatures';
import type { CompanyPlanTier } from '@/lib/companyFeatures';

export interface CompanyFeatureOverrideRow {
  id: string;
  company_id: string;
  feature_key: CompanyFeatureKey;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type CompanyFeatureState = Record<CompanyFeatureKey, boolean>;

export function useCompanyFeatureFlags(companyId?: string) {
  return useQuery({
    queryKey: ['company-feature-flags', companyId],
    queryFn: async () => {
      if (!companyId) return null;

      const [{ data: company, error: companyError }, rpcResult] = await Promise.all([
        supabase
          .from('companies' as any)
          .select('*')
          .eq('id', companyId)
          .maybeSingle(),
        (supabase as any).rpc('get_company_feature_flags', { _company_id: companyId }),
      ]);

      if (companyError) throw companyError;

      const planTier = normalizeCompanyPlanTier(company?.plan_tier);
      if (rpcResult.error) {
        return {
          planTier,
          features: getPlanDefaultFeatures(planTier),
        };
      }

      const rpcRows = (rpcResult.data ?? []) as Array<{ feature_key: CompanyFeatureKey; enabled: boolean }>;
      const overrideMap = rpcRows.reduce((acc, row) => {
        acc[row.feature_key] = row.enabled;
        return acc;
      }, {} as Partial<Record<CompanyFeatureKey, boolean>>);

      return {
        planTier,
        features: resolveCompanyFeatures(planTier, overrideMap),
      };
    },
    enabled: !!companyId,
  });
}

export function useCompanyFeatureOverrides(companyId?: string) {
  return useQuery({
    queryKey: ['company-feature-overrides', companyId],
    queryFn: async () => {
      if (!companyId) return [];

      const { data, error } = await supabase
        .from('company_feature_overrides' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('feature_key');

      if (error) {
        console.warn('Feature override table not available yet:', error);
        return [];
      }
      return (data ?? []) as CompanyFeatureOverrideRow[];
    },
    enabled: !!companyId,
  });
}

export function useUpsertCompanyFeatureOverride() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      companyId: string;
      featureKey: CompanyFeatureKey;
      enabled: boolean;
    }) => {
      const { data, error } = await supabase
        .from('company_feature_overrides' as any)
        .upsert({
          company_id: payload.companyId,
          feature_key: payload.featureKey,
          enabled: payload.enabled,
          updated_at: new Date().toISOString(),
        } as any, { onConflict: 'company_id,feature_key' })
        .select()
        .single();

      if (error) throw error;
      return data as CompanyFeatureOverrideRow;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['company-feature-flags', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-feature-overrides', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company-public'] });
      toast.success('Permissao atualizada.');
    },
    onError: (error: any) => {
      toast.error(`Erro ao atualizar permissao: ${error.message}`);
    },
  });
}

export function useDeleteCompanyFeatureOverride() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      companyId: string;
      featureKey: CompanyFeatureKey;
    }) => {
      const { error } = await supabase
        .from('company_feature_overrides' as any)
        .delete()
        .eq('company_id', payload.companyId)
        .eq('feature_key', payload.featureKey);

      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['company-feature-flags', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-feature-overrides', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company-public'] });
      toast.success('Permissao voltou a seguir o plano.');
    },
    onError: (error: any) => {
      toast.error(`Erro ao remover override: ${error.message}`);
    },
  });
}

export function useSaveCompanyFeatures() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: {
      companyId: string;
      features: CompanyFeatureState;
    }) => {
      const rows = COMPANY_FEATURE_DEFINITIONS.map((definition) => ({
        company_id: payload.companyId,
        feature_key: definition.key,
        enabled: payload.features[definition.key],
        updated_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from('company_feature_overrides' as any)
        .upsert(rows as any[], { onConflict: 'company_id,feature_key' });

      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['company-feature-flags', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['company-feature-overrides', variables.companyId] });
      queryClient.invalidateQueries({ queryKey: ['companies-feature-matrix'] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company-public'] });
      toast.success('Features atualizadas.');
    },
    onError: (error: any) => {
      toast.error(`Erro ao salvar features: ${error.message}`);
    },
  });
}

export function useCompaniesFeatureMatrix(companies: Array<{ id: string; plan_tier?: CompanyPlanTier | string | null }>) {
  const companyKeys = companies
    .map((company) => `${company.id}:${company.plan_tier ?? ''}`)
    .sort();

  return useQuery({
    queryKey: ['companies-feature-matrix', companyKeys],
    queryFn: async () => {
      if (companies.length === 0) return {};

      const companyIds = companies.map((company) => company.id);
      const defaultMatrix = companies.reduce((acc, company) => {
        const planTier = normalizeCompanyPlanTier(company.plan_tier);
        acc[company.id] = getPlanDefaultFeatures(planTier);
        return acc;
      }, {} as Record<string, CompanyFeatureState>);

      const { data, error } = await supabase
        .from('company_feature_overrides' as any)
        .select('company_id, feature_key, enabled')
        .in('company_id', companyIds);

      if (error) {
        console.warn('Company feature matrix not available yet:', error);
        return defaultMatrix;
      }

      const groupedOverrides = (data ?? []).reduce((acc, row: any) => {
        const companyId = row.company_id as string;
        if (!acc[companyId]) acc[companyId] = {};
        acc[companyId][row.feature_key as CompanyFeatureKey] = !!row.enabled;
        return acc;
      }, {} as Record<string, Partial<Record<CompanyFeatureKey, boolean>>>);

      return companies.reduce((acc, company) => {
        const planTier = normalizeCompanyPlanTier(company.plan_tier);
        acc[company.id] = resolveCompanyFeatures(planTier, groupedOverrides[company.id] ?? {});
        return acc;
      }, {} as Record<string, CompanyFeatureState>);
    },
    enabled: companies.length > 0,
  });
}

export function emptyFeatureFlagMap() {
  return COMPANY_FEATURE_DEFINITIONS.reduce((acc, definition) => {
    acc[definition.key] = false;
    return acc;
  }, {} as Record<CompanyFeatureKey, boolean>);
}
