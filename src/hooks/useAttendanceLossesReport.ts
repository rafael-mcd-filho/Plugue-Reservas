import { useQuery, type QueryKey } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  AttendanceLossesValidationError,
  buildAttendanceLossesQueryKey,
  buildAttendanceLossesRpcParams,
  normalizeAttendanceLossesReport,
  type AttendanceLossesReportParams,
} from '@/lib/attendance-losses-report';

function getErrorDescriptor(error: unknown) {
  const candidate = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {};
  const code = String(candidate.code ?? '').toUpperCase();
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const name = String(candidate.name ?? '');
  const text = [candidate.message, candidate.details, error]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();
  return { code, status, name, text };
}

export function isSameAttendanceLossesDataset(
  previousKey: QueryKey | undefined,
  currentKey: QueryKey,
) {
  if (!previousKey) return false;
  // Só a página pode variar. Empresa, intervalo, filtros, tamanho e busca
  // precisam ser idênticos para que nenhum dado pessoal antigo reapareça.
  return previousKey[1] === currentKey[1]
    && previousKey[2] === currentKey[2]
    && previousKey[3] === currentKey[3]
    && previousKey[4] === currentKey[4]
    && previousKey[5] === currentKey[5]
    && previousKey[7] === currentKey[7]
    && previousKey[8] === currentKey[8]
    && previousKey[9] === currentKey[9];
}

export function shouldRetryAttendanceLosses(failureCount: number, error: unknown) {
  if (failureCount >= 1 || error instanceof AttendanceLossesValidationError) return false;
  const { code, status, name, text } = getErrorDescriptor(error);
  return !(code === '42501'
    || code === '57014'
    || status === 401
    || status === 403
    || name === 'AbortError'
    || text.includes('permission denied')
    || text.includes('jwt'));
}

export function useAttendanceLossesReport(params: AttendanceLossesReportParams) {
  const rpcParams = buildAttendanceLossesRpcParams(params);
  const queryKey = buildAttendanceLossesQueryKey(params);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_attendance_losses_report', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;

      if (error) throw error;
      return normalizeAttendanceLossesReport(data, rpcParams);
    },
    enabled: (params.enabled ?? true)
      && !!rpcParams._company_id
      && !!rpcParams._period_start
      && !!rpcParams._period_end,
    placeholderData: (previousData, previousQuery) => (
      previousData && isSameAttendanceLossesDataset(previousQuery?.queryKey, queryKey)
        ? previousData
        : undefined
    ),
    retry: shouldRetryAttendanceLosses,
    retryDelay: 750,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
