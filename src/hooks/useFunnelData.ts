import { useQuery, type QueryKey } from '@tanstack/react-query';
import { FUNNEL_STEPS, type FunnelStep } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';

const FUNNEL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FUNNEL_STALE_TIME_MS = 2 * 60 * 1000;
const MAX_FUNNEL_RANGE_DAYS = 366;

export interface FunnelDataPoint {
  step: FunnelStep;
  count: number;
}

export type FunnelCompanyScope =
  | { kind: 'company'; companyId: string }
  | { kind: 'global' };

export type FunnelDataSource = 'fast' | 'read_model' | 'fast_fallback';

export interface FunnelQueryParams {
  scope: 'company' | 'global';
  companyId: string | null;
  startDate: string;
  endDate: string;
  uniqueOnly: boolean;
}

export interface FunnelQueryResult {
  points: FunnelDataPoint[];
  request: FunnelQueryParams;
  dataSource: FunnelDataSource;
}

export interface UseFunnelDataOptions {
  scope: FunnelCompanyScope | null;
  startDate?: Date;
  endDate?: Date;
  uniqueOnly?: boolean;
  enabled: boolean;
}

export type FunnelPresentationState =
  | 'loading'
  | 'refreshing'
  | 'stale-error'
  | 'error'
  | 'valid-empty'
  | 'ready';

interface TrackingFunnelCountRow {
  step: unknown;
  event_count: unknown;
  data_source: unknown;
}

interface FunnelStateInput {
  data?: FunnelQueryResult;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
}

type FunnelQueryKey = readonly ['funnel-data', FunnelQueryParams];

export class FunnelDataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunnelDataValidationError';
  }
}

export class FunnelRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FunnelRequestValidationError';
  }
}

function toCanonicalCalendarDate(date: Date | undefined) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getCalendarDateOrdinal(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function getFunnelRequestValidationError(
  startDate: Date | undefined,
  endDate: Date | undefined,
) {
  const canonicalStartDate = toCanonicalCalendarDate(startDate);
  const canonicalEndDate = toCanonicalCalendarDate(endDate);
  if (!canonicalStartDate || !canonicalEndDate) return null;

  if (canonicalStartDate > canonicalEndDate) {
    return new FunnelRequestValidationError('A data final deve ser igual ou posterior à data inicial.');
  }

  const rangeDays = getCalendarDateOrdinal(canonicalEndDate) - getCalendarDateOrdinal(canonicalStartDate) + 1;
  if (rangeDays > MAX_FUNNEL_RANGE_DAYS) {
    return new FunnelRequestValidationError('Selecione um período de no máximo 366 dias para consultar o funil.');
  }

  return null;
}

function isFunnelStep(value: unknown): value is FunnelStep {
  return typeof value === 'string' && FUNNEL_STEPS.includes(value as FunnelStep);
}

function normalizeCount(value: unknown, step: FunnelStep) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FunnelDataValidationError(`Contagem inválida para a etapa ${step}.`);
  }

  return parsed;
}

export function normalizeFunnelQueryParams({
  scope,
  startDate,
  endDate,
  uniqueOnly = false,
}: Omit<UseFunnelDataOptions, 'enabled'>): FunnelQueryParams | null {
  if (!scope) return null;

  const canonicalStartDate = toCanonicalCalendarDate(startDate);
  const canonicalEndDate = toCanonicalCalendarDate(endDate);
  if (
    !canonicalStartDate
    || !canonicalEndDate
    || getFunnelRequestValidationError(startDate, endDate)
  ) return null;

  if (scope.kind === 'company') {
    const companyId = scope.companyId.trim();
    if (!companyId || companyId === 'all') return null;

    return {
      scope: 'company',
      companyId,
      startDate: canonicalStartDate,
      endDate: canonicalEndDate,
      uniqueOnly,
    };
  }

  return {
    scope: 'global',
    companyId: null,
    startDate: canonicalStartDate,
    endDate: canonicalEndDate,
    uniqueOnly,
  };
}

export function validateFunnelRows(rows: unknown): FunnelDataPoint[] {
  if (!Array.isArray(rows) || rows.length !== FUNNEL_STEPS.length) {
    throw new FunnelDataValidationError('O funil retornou uma quantidade inesperada de etapas.');
  }

  const countsByStep = new Map<FunnelStep, number>();
  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'object') {
      throw new FunnelDataValidationError('O funil retornou uma etapa inválida.');
    }

    const row = rawRow as TrackingFunnelCountRow;
    if (!isFunnelStep(row.step)) {
      throw new FunnelDataValidationError('O funil retornou uma etapa desconhecida.');
    }
    if (countsByStep.has(row.step)) {
      throw new FunnelDataValidationError(`A etapa ${row.step} foi retornada mais de uma vez.`);
    }

    countsByStep.set(row.step, normalizeCount(row.event_count, row.step));
  }

  if (countsByStep.size !== FUNNEL_STEPS.length) {
    throw new FunnelDataValidationError('O funil não retornou todas as etapas esperadas.');
  }

  const points = FUNNEL_STEPS.map((step) => ({ step, count: countsByStep.get(step)! }));
  if (points.some((point, index) => index > 0 && point.count > points[index - 1].count)) {
    throw new FunnelDataValidationError('O funil retornou etapas fora da ordem esperada.');
  }

  return points;
}

export function getFunnelPresentationState({
  data,
  isPending,
  isFetching,
  isError,
}: FunnelStateInput): FunnelPresentationState {
  if (!data && isFetching) return 'loading';
  if (!data && isPending) return 'loading';
  if (!data && isError) return 'error';
  if (data && isFetching) return 'refreshing';
  if (data && isError) return 'stale-error';
  if (data?.points.every((point) => point.count === 0)) return 'valid-empty';
  return data ? 'ready' : 'loading';
}

function getErrorDescriptor(error: unknown) {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; details?: unknown; status?: unknown; statusCode?: unknown; name?: unknown }
    : {};
  const code = String(candidate.code ?? '').toUpperCase();
  const status = Number(candidate.status ?? candidate.statusCode ?? 0);
  const text = [candidate.name, candidate.message, candidate.details, error]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();

  return { code, status, text };
}

export function shouldRetryFunnelQuery(failureCount: number, error: unknown) {
  if (
    failureCount >= 1
    || error instanceof FunnelDataValidationError
    || error instanceof FunnelRequestValidationError
  ) return false;

  const { code, status, text } = getErrorDescriptor(error);
  const isAborted = text.includes('aborterror') || text.includes('aborted');
  const isTimeout = code === '57014'
    || code === 'PGRST003'
    || text.includes('timeout')
    || text.includes('timed out')
    || text.includes('canceling statement');
  const isAuthOrPermission = status === 401
    || status === 403
    || code === '401'
    || code === '403'
    || code === '42501'
    || code === 'PGRST301'
    || code === 'PGRST302'
    || text.includes('jwt')
    || text.includes('permission denied')
    || text.includes('not authorized')
    || text.includes('unauthorized');

  return !isAborted && !isTimeout && !isAuthOrPermission;
}

export function getFunnelErrorMessage(error: unknown) {
  if (error instanceof FunnelRequestValidationError) return error.message;
  if (error instanceof FunnelDataValidationError) {
    return 'Os dados recebidos estavam incompletos ou inválidos. Tente atualizar novamente.';
  }

  const { code, status, text } = getErrorDescriptor(error);
  if (code === '57014' || code === 'PGRST003' || text.includes('timeout') || text.includes('timed out')) {
    return 'A consulta demorou mais que o esperado. Tente novamente em alguns instantes.';
  }
  if (status === 401 || code === '401' || code === 'PGRST301' || code === 'PGRST302' || text.includes('jwt')) {
    return 'Sua sessão precisa ser renovada antes de carregar este relatório.';
  }
  if (status === 403 || code === '403' || code === '42501' || text.includes('permission denied')) {
    return 'Você não tem permissão para consultar este relatório.';
  }

  return 'Não foi possível atualizar o funil agora. Verifique sua conexão e tente novamente.';
}

export function getFunnelQueryKey(params: FunnelQueryParams): FunnelQueryKey {
  return ['funnel-data', params] as const;
}

export function canReusePreviousFunnelData(
  current: FunnelQueryParams,
  previousParams: FunnelQueryParams | undefined,
) {
  return previousParams?.scope === current.scope
    && previousParams.companyId === current.companyId
    && previousParams.uniqueOnly === current.uniqueOnly;
}

function isSameFunnelIdentity(current: FunnelQueryParams, previousKey: QueryKey | undefined) {
  const previousParams = previousKey?.[1];
  return typeof previousParams === 'object'
    && previousParams !== null
    && canReusePreviousFunnelData(current, previousParams as FunnelQueryParams);
}

export function getFunnelAwareFreshnessLabel({
  hasFunnelError,
  isSyncing,
  isStale,
}: {
  hasFunnelError: boolean;
  isSyncing: boolean;
  isStale: boolean;
}) {
  if (hasFunnelError) return 'Erro parcial';
  if (isSyncing) return 'Sincronizando';
  if (isStale) return 'Dados com atraso';
  return 'Atualizado';
}

export function getFortalezaCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getFunnelRefetchInterval(params: FunnelQueryParams, today = getFortalezaCalendarDate()) {
  return params.startDate <= today && params.endDate >= today
    ? FUNNEL_REFRESH_INTERVAL_MS
    : false;
}

function validateFunnelDataSource(rows: unknown): FunnelDataSource {
  const sources = new Set(
    (rows as TrackingFunnelCountRow[]).map((row) => row.data_source),
  );
  if (sources.size !== 1) {
    throw new FunnelDataValidationError('O funil retornou fontes de dados inconsistentes.');
  }

  const [source] = sources;
  if (source !== 'fast' && source !== 'read_model' && source !== 'fast_fallback') {
    throw new FunnelDataValidationError('O funil retornou uma fonte de dados desconhecida.');
  }

  return source;
}

async function readFunnelReport(params: FunnelQueryParams, signal: AbortSignal) {
  const rpcName = params.scope === 'company'
    ? 'get_tracking_funnel_report'
    : 'get_global_tracking_funnel_report';
  const rpcParams = params.scope === 'company'
    ? {
        _company_id: params.companyId,
        _start_date: params.startDate,
        _end_date: params.endDate,
        _unique_only: params.uniqueOnly,
      }
    : {
        _start_date: params.startDate,
        _end_date: params.endDate,
        _unique_only: params.uniqueOnly,
      };
  let request = (supabase as any).rpc(rpcName, rpcParams);

  if (request && typeof request.abortSignal === 'function') {
    request = request.abortSignal(signal);
  }

  const { data, error } = await request;
  if (error) throw error;

  return {
    points: validateFunnelRows(data),
    dataSource: validateFunnelDataSource(data),
  };
}

export function useFunnelData(options: UseFunnelDataOptions) {
  const requestValidationError = getFunnelRequestValidationError(options.startDate, options.endDate);
  const params = normalizeFunnelQueryParams(options);
  const queryKey = params
    ? getFunnelQueryKey(params)
    : requestValidationError
      ? (['funnel-data', 'invalid-range', requestValidationError.message] as const)
      : (['funnel-data', 'incomplete'] as const);

  return useQuery<FunnelQueryResult>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (requestValidationError) throw requestValidationError;
      if (!params) {
        throw new Error('Os parâmetros do funil estão incompletos.');
      }

      const { points, dataSource } = await readFunnelReport(params, signal);
      return { points, request: params, dataSource };
    },
    enabled: options.enabled && (params !== null || requestValidationError !== null),
    placeholderData: params
      ? (previousData, previousQuery) => (
          previousData && isSameFunnelIdentity(params, previousQuery?.queryKey)
            ? previousData
            : undefined
        )
      : undefined,
    retry: shouldRetryFunnelQuery,
    retryDelay: 750,
    refetchInterval: params ? getFunnelRefetchInterval(params) : false,
    refetchIntervalInBackground: false,
    staleTime: FUNNEL_STALE_TIME_MS,
  });
}
