import { useQuery, type QueryKey } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  OccupancyCapacityValidationError,
  buildOccupancyCapacityQueryKey,
  buildOccupancyCapacityRpcParams,
  normalizeOccupancyCapacityReport,
  type OccupancyCapacityReportParams,
} from '@/lib/occupancy-capacity-report';

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

export function isSameOccupancyCapacityDataset(
  previousKey: QueryKey | undefined,
  currentKey: QueryKey,
) {
  if (!previousKey) return false;
  // Only the page may change. Never reuse personal data across report scopes.
  return previousKey[1] === currentKey[1]
    && previousKey[2] === currentKey[2]
    && previousKey[3] === currentKey[3]
    && previousKey[4] === currentKey[4]
    && previousKey[6] === currentKey[6]
    && previousKey[7] === currentKey[7]
    && previousKey[8] === currentKey[8];
}

export function shouldRetryOccupancyCapacity(failureCount: number, error: unknown) {
  if (failureCount >= 1 || error instanceof OccupancyCapacityValidationError) return false;
  const { code, status, name, text } = getErrorDescriptor(error);
  return !(code === '42501'
    || code === '57014'
    || status === 401
    || status === 403
    || name === 'AbortError'
    || text.includes('permission denied')
    || text.includes('jwt'));
}

export function useOccupancyCapacityReport(params: OccupancyCapacityReportParams) {
  const rpcParams = buildOccupancyCapacityRpcParams(params);
  const queryKey = buildOccupancyCapacityQueryKey(params);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      let request = (supabase as any).rpc('get_occupancy_capacity_report', rpcParams);
      if (request && typeof request.abortSignal === 'function') request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return normalizeOccupancyCapacityReport(data, rpcParams);
    },
    enabled: (params.enabled ?? true)
      && !!rpcParams._company_id
      && !!rpcParams._start_date
      && !!rpcParams._end_date,
    placeholderData: (previousData, previousQuery) => (
      previousData && isSameOccupancyCapacityDataset(previousQuery?.queryKey, queryKey)
        ? previousData
        : undefined
    ),
    retry: shouldRetryOccupancyCapacity,
    retryDelay: 750,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}
