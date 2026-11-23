import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import {
  createPlatformWhatsAppNotice, fetchPlatformWhatsAppNotices, retryPlatformWhatsAppNotice,
  type CreatePlatformWhatsAppNoticeInput, type PlatformWhatsAppNotice,
} from '@/lib/platform-whatsapp-notices';

const KEY = ['platform-whatsapp-notices'] as const;

export function usePlatformWhatsAppNotices({ enabled, offset = 0, limit = 25 }: { enabled: boolean; offset?: number; limit?: number }) {
  const { user, roles } = useAuth();
  const authorized = !!user && roles.includes('superadmin');
  return useQuery({
    queryKey: [...KEY, user?.id ?? null, authorized, offset, limit],
    queryFn: ({ signal }) => fetchPlatformWhatsAppNotices({ offset, limit }, signal),
    enabled: enabled && authorized, retry: false, staleTime: 0, gcTime: 0,
    refetchInterval: enabled && authorized
      ? query => query.state.data?.rows.some(row => row.status === 'queued' || row.status === 'processing') ? 5000 : false
      : false,
  });
}

/** O servidor devolve até 100 linhas por página; o histórico é lido inteiro até este limite. */
const ALL_NOTICES_MAX_ROWS = 2000;

/**
 * Histórico completo dos avisos por WhatsApp, para agrupar por envio.
 * As linhas de um mesmo envio podem estar em páginas diferentes do servidor.
 */
export function useAllPlatformWhatsAppNotices({ enabled }: { enabled: boolean }) {
  const { user, roles } = useAuth();
  const authorized = !!user && roles.includes('superadmin');
  return useQuery({
    queryKey: [...KEY, 'all', user?.id ?? null, authorized],
    queryFn: async ({ signal }) => {
      const rows: PlatformWhatsAppNotice[] = [];
      let total = 0;
      let offset = 0;
      do {
        const page = await fetchPlatformWhatsAppNotices({ offset, limit: 100 }, signal);
        rows.push(...page.rows);
        total = page.total;
        offset += 100;
        if (page.rows.length === 0) break;
      } while (offset < total && offset < ALL_NOTICES_MAX_ROWS);
      return { rows, total, truncated: rows.length < total };
    },
    enabled: enabled && authorized,
    retry: false,
    staleTime: 0,
    refetchInterval: enabled && authorized
      ? (query) => query.state.data?.rows.some((row) => row.status === 'queued' || row.status === 'processing') ? 5000 : false
      : false,
  });
}

export function useCreatePlatformWhatsAppNotice() {
  const queryClient = useQueryClient();
  const { user, roles } = useAuth();
  return useMutation({
    mutationKey: [...KEY, 'create', user?.id ?? null], retry: false,
    mutationFn: (input: CreatePlatformWhatsAppNoticeInput) => {
      if (!user || !roles.includes('superadmin')) throw new Error('Sem permissão para enviar avisos às empresas.');
      return createPlatformWhatsAppNotice(input);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useRetryPlatformWhatsAppNotice() {
  const queryClient = useQueryClient();
  const { user, roles } = useAuth();
  return useMutation({
    mutationKey: [...KEY, 'retry', user?.id ?? null], retry: false,
    mutationFn: (input: { notice_id: string }) => {
      if (!user || !roles.includes('superadmin')) throw new Error('Sem permissão para reenviar avisos às empresas.');
      return retryPlatformWhatsAppNotice(input);
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEY }); },
  });
}
