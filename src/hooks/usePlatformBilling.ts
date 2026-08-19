import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCompanyBillingSnapshot,
  getCompanyBillingSummary,
  getPlatformAsaasConfig,
  getPlatformBillingModuleStatus,
  getSuperadminBillingOverview,
  listCompanyBillingInvoices,
  removeCompanyBillingLink,
  searchAsaasCustomers,
  saveCompanyBillingLink,
  savePlatformAsaasConfig,
  setPlatformBillingEnabled,
  setCompanyBillingEnabled,
  syncAllCompanyBilling,
  syncCompanyBilling,
  testPlatformAsaasConfig,
  validateAsaasCustomer,
} from '@/lib/platform-billing-api';
import {
  CompanyBillingPixRequestCoordinator,
  getCompanyBillingPixExpirationTimestamp,
} from '@/lib/company-billing-pix-client';
import {
  createEmptyCompanyBillingSummary,
  type PlatformBillingEnvironment,
  type PlatformBillingOverview,
} from '@/lib/platform-billing-contracts';

const STATUS_STALE_TIME = 5 * 60 * 1000;
const BILLING_STALE_TIME = 60 * 1000;
const BILLING_SUMMARY_REFRESH_INTERVAL = 5 * 60 * 1000;

export const platformBillingQueryKeys = {
  all: ['platform-billing'] as const,
  moduleStatus: () => ['platform-billing', 'module-status'] as const,
  config: () => ['platform-billing', 'config'] as const,
  link: (companyId: string | undefined) => ['platform-billing', 'link', companyId] as const,
  summary: (companyId: string | undefined) => ['platform-billing', 'summary', companyId] as const,
  invoices: (companyId: string | undefined) => ['platform-billing', 'invoices', companyId] as const,
  overview: () => ['platform-billing', 'overview'] as const,
};

interface BillingQueryOptions {
  enabled?: boolean;
  /** Superadmin-only UI preview may read the local cache before customer rollout. */
  allowWhenDisabled?: boolean;
}

export function usePlatformBillingModuleStatus(options: BillingQueryOptions = {}) {
  return useQuery({
    queryKey: platformBillingQueryKeys.moduleStatus(),
    queryFn: getPlatformBillingModuleStatus,
    enabled: options.enabled ?? true,
    staleTime: STATUS_STALE_TIME,
    gcTime: 30 * 60 * 1000,
    refetchInterval: (options.enabled ?? true) ? BILLING_SUMMARY_REFRESH_INTERVAL : false,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function usePlatformAsaasConfig(options: BillingQueryOptions = {}) {
  const moduleStatus = usePlatformBillingModuleStatus(options);

  return useQuery({
    queryKey: platformBillingQueryKeys.config(),
    queryFn: getPlatformAsaasConfig,
    enabled: (options.enabled ?? true) && !!moduleStatus.data?.available,
    staleTime: BILLING_STALE_TIME,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSavePlatformAsaasConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      token: string;
      environment: PlatformBillingEnvironment;
    }) => {
      return savePlatformAsaasConfig({
        token: input.token,
        environment: input.environment,
      });
    },
    onSuccess: (config) => {
      queryClient.setQueryData(platformBillingQueryKeys.config(), config);
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.moduleStatus() });
      queryClient.invalidateQueries({ queryKey: ['platform-billing', 'link'] });
      queryClient.invalidateQueries({ queryKey: ['platform-billing', 'summary'] });
      queryClient.invalidateQueries({ queryKey: ['platform-billing', 'invoices'] });
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.overview() });
    },
  });
}

export function useSetPlatformBillingEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: setPlatformBillingEnabled,
    onSuccess: (config) => {
      queryClient.setQueryData(platformBillingQueryKeys.config(), config);
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.moduleStatus() });
      queryClient.invalidateQueries({ queryKey: ['platform-billing', 'summary'] });
      queryClient.invalidateQueries({ queryKey: ['platform-billing', 'invoices'] });
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.overview() });
    },
  });
}

export function useTestPlatformAsaasConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      token?: string;
      environment?: PlatformBillingEnvironment;
    }) => testPlatformAsaasConfig(input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.config() });
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.moduleStatus() });
    },
  });
}

export function useCompanyBillingLink(
  companyId?: string,
  options: BillingQueryOptions = {},
) {
  const moduleStatus = usePlatformBillingModuleStatus(options);

  return useQuery({
    queryKey: platformBillingQueryKeys.link(companyId),
    queryFn: async () => {
      if (!companyId) return null;
      const snapshot = await getCompanyBillingSnapshot(companyId);
      return snapshot.link;
    },
    enabled: (options.enabled ?? true) && !!companyId && !!moduleStatus.data?.available,
    staleTime: BILLING_STALE_TIME,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useValidateAsaasCustomer() {
  return useMutation({
    mutationFn: (input: { companyId?: string; customerId: string }) => validateAsaasCustomer(input),
  });
}

export function useSearchAsaasCustomers() {
  return useMutation({
    mutationFn: (input: { query: string; offset?: number; limit?: number }) => searchAsaasCustomers(input),
  });
}

function invalidateCompanyBillingQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
) {
  queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.link(companyId) });
  queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.summary(companyId) });
  queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.invoices(companyId) });
  queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.overview() });
}

export function useSaveCompanyBillingLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      companyId: string;
      customerId: string;
      descriptionMarker?: string;
    }) => saveCompanyBillingLink(input),
    onSuccess: (_, input) => {
      invalidateCompanyBillingQueries(queryClient, input.companyId);
    },
  });
}

export function useRemoveCompanyBillingLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { companyId: string }) => removeCompanyBillingLink(input.companyId),
    onSuccess: (_, input) => {
      invalidateCompanyBillingQueries(queryClient, input.companyId);
    },
  });
}

export function useSetCompanyBillingEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      companyId: string;
      enabled: boolean;
      expectedBillingRevision?: string | null;
    }) => setCompanyBillingEnabled(input),
    onSuccess: (link, input) => {
      queryClient.setQueryData(platformBillingQueryKeys.link(input.companyId), link);
      queryClient.setQueryData<PlatformBillingOverview>(
        platformBillingQueryKeys.overview(),
        (current) => current
          ? {
              ...current,
              companies: current.companies.map((company) => company.companyId === input.companyId
                ? {
                    ...company,
                    billingEnabled: link.billingEnabled,
                    billingRevision: link.billingRevision,
                  }
                : company),
            }
          : current,
      );
      invalidateCompanyBillingQueries(queryClient, input.companyId);
    },
  });
}

export function useSyncCompanyBilling() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { companyId: string }) => syncCompanyBilling(input.companyId),
    onSuccess: (_, input) => {
      invalidateCompanyBillingQueries(queryClient, input.companyId);
    },
  });
}

export function useCompanyBillingSummary(
  companyId?: string,
  options: BillingQueryOptions = {},
) {
  const moduleStatus = usePlatformBillingModuleStatus(options);
  const moduleEnabled = !!moduleStatus.data?.enabled;
  const billingReadable = moduleEnabled || options.allowWhenDisabled === true;

  return useQuery({
    queryKey: platformBillingQueryKeys.summary(companyId),
    queryFn: () => companyId
      ? getCompanyBillingSummary(companyId)
      : createEmptyCompanyBillingSummary(null, moduleEnabled),
    enabled: (options.enabled ?? true)
      && !!companyId
      && !!moduleStatus.data?.available
      && billingReadable,
    staleTime: BILLING_STALE_TIME,
    refetchInterval: billingReadable ? BILLING_SUMMARY_REFRESH_INTERVAL : false,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useCompanyBillingInvoices(
  companyId?: string,
  options: BillingQueryOptions = {},
) {
  const moduleStatus = usePlatformBillingModuleStatus(options);
  const moduleEnabled = !!moduleStatus.data?.enabled;
  const billingReadable = moduleEnabled || options.allowWhenDisabled === true;

  return useQuery({
    queryKey: platformBillingQueryKeys.invoices(companyId),
    queryFn: () => companyId ? listCompanyBillingInvoices(companyId) : [],
    enabled: (options.enabled ?? true)
      && !!companyId
      && !!moduleStatus.data?.available
      && billingReadable,
    staleTime: BILLING_STALE_TIME,
    refetchInterval: billingReadable ? BILLING_SUMMARY_REFRESH_INTERVAL : false,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useCompanyBillingInvoicePixQrCode() {
  const coordinatorRef = useRef<CompanyBillingPixRequestCoordinator | null>(null);
  const expiredInvoiceIdRef = useRef<string | null>(null);
  const [expiredInvoiceId, setExpiredInvoiceId] = useState<string | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new CompanyBillingPixRequestCoordinator();
  }

  const mutation = useMutation({
    mutationFn: (input: { companyId: string; invoiceId: string }) => {
      if (!coordinatorRef.current || coordinatorRef.current.isDisposed) {
        coordinatorRef.current = new CompanyBillingPixRequestCoordinator();
      }
      return coordinatorRef.current.request(input);
    },
    onMutate: () => {
      expiredInvoiceIdRef.current = null;
      setExpiredInvoiceId(null);
    },
    onSuccess: () => {
      expiredInvoiceIdRef.current = null;
      setExpiredInvoiceId(null);
    },
    gcTime: 0,
    retry: false,
  });
  const { data: mutationData, reset: resetMutation } = mutation;

  const resetMutationRef = useRef(resetMutation);
  resetMutationRef.current = resetMutation;

  useEffect(() => {
    if (!coordinatorRef.current || coordinatorRef.current.isDisposed) {
      coordinatorRef.current = new CompanyBillingPixRequestCoordinator();
    }
    const coordinator = coordinatorRef.current;
    return () => {
      expiredInvoiceIdRef.current = null;
      resetMutationRef.current();
      coordinator.dispose();
    };
  }, []);

  useEffect(() => {
    if (!mutationData) return undefined;

    const expirationTimestamp = getCompanyBillingPixExpirationTimestamp(
      mutationData.expirationDate,
    );
    let timer: number | null = null;
    let cancelled = false;

    const scheduleExpiration = () => {
      if (cancelled) return;
      const remaining = expirationTimestamp === null
        ? 0
        : expirationTimestamp - Date.now();
      if (remaining <= 0) {
        expiredInvoiceIdRef.current = mutationData.invoiceId;
        setExpiredInvoiceId(mutationData.invoiceId);
        resetMutation();
        return;
      }
      timer = window.setTimeout(
        scheduleExpiration,
        Math.min(2_147_483_647, remaining + 1),
      );
    };

    scheduleExpiration();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mutationData, resetMutation]);

  return { ...mutation, expiredInvoiceId };
}

export function useSuperadminBillingOverview(options: BillingQueryOptions = {}) {
  const moduleStatus = usePlatformBillingModuleStatus(options);

  return useQuery({
    queryKey: platformBillingQueryKeys.overview(),
    queryFn: getSuperadminBillingOverview,
    enabled: (options.enabled ?? true) && !!moduleStatus.data?.available,
    staleTime: BILLING_STALE_TIME,
    refetchInterval: moduleStatus.data?.enabled ? BILLING_SUMMARY_REFRESH_INTERVAL : false,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSyncAllCompanyBilling() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: syncAllCompanyBilling,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformBillingQueryKeys.all });
    },
  });
}
