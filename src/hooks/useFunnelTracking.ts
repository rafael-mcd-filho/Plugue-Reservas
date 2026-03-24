import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Steps in order for the funnel
export const FUNNEL_STEPS = [
  'page_view',
  'date_select',
  'time_select',
  'form_fill',
  'completed',
] as const;

export type FunnelStep = typeof FUNNEL_STEPS[number];

const STEP_LABELS: Record<FunnelStep, string> = {
  page_view: 'Página Pública',
  date_select: 'Seleção de Data',
  time_select: 'Seleção de Horário',
  form_fill: 'Dados Pessoais',
  completed: 'Reserva Finalizada',
};

export { STEP_LABELS };

const PENDING_STEPS_STORAGE_KEY = 'rv_funnel_pending_steps';
const MAX_PENDING_STEPS = 50;
const RPC_TIMEOUT_MS = 8000;
const MAX_RETRY_COUNT = 5;

// ---------------------------------------------------------------------------
// Debug event bus — emite eventos para o FunnelDebugPanel quando ativo.
// Não tem impacto em produção (zero overhead quando nenhum listener ativo).
// ---------------------------------------------------------------------------
export type FunnelDebugEventType = 'queued' | 'sent' | 'failed' | 'retry' | 'discarded';

export interface FunnelDebugEvent {
  type: FunnelDebugEventType;
  step: FunnelStep;
  date: string;
  retryCount?: number;
  errorMessage?: string;
  timestamp: string;
}

function emitDebug(type: FunnelDebugEventType, payload: FunnelPayload, extra?: { retryCount?: number; errorMessage?: string }): void {
  try {
    window.dispatchEvent(new CustomEvent<FunnelDebugEvent>('funnel:debug', {
      detail: {
        type,
        step: payload.step,
        date: payload.date,
        retryCount: extra?.retryCount,
        errorMessage: extra?.errorMessage,
        timestamp: new Date().toISOString(),
      },
    }));
  } catch { /* silencioso — debug não pode quebrar produção */ }
}

interface FunnelPayload {
  company_id: string;
  visitor_id: string;
  step: FunnelStep;
  date: string;
  retryCount?: number;
}

export function getVisitorId(): string {
  const key = 'rv_visitor_id';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private mode, etc.)
    return crypto.randomUUID();
  }
}

/** Retorna a data atual em UTC no formato YYYY-MM-DD. */
function getTrackingDateUTC(): string {
  return new Date().toISOString().split('T')[0];
}

function getPayloadKey(payload: FunnelPayload): string {
  return `${payload.company_id}_${payload.visitor_id}_${payload.step}_${payload.date}`;
}

function readPendingSteps(): FunnelPayload[] {
  try {
    const raw = localStorage.getItem(PENDING_STEPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FunnelPayload => {
      return (
        !!item &&
        typeof item === 'object' &&
        typeof (item as FunnelPayload).company_id === 'string' &&
        typeof (item as FunnelPayload).visitor_id === 'string' &&
        typeof (item as FunnelPayload).step === 'string' &&
        typeof (item as FunnelPayload).date === 'string' &&
        FUNNEL_STEPS.includes((item as FunnelPayload).step as FunnelStep)
      );
    });
  } catch (err) {
    console.warn('[Funnel] Failed to read pending steps from localStorage:', err);
    return [];
  }
}

function writePendingSteps(payloads: FunnelPayload[]): void {
  try {
    localStorage.setItem(PENDING_STEPS_STORAGE_KEY, JSON.stringify(payloads));
  } catch (err) {
    console.warn('[Funnel] Failed to write pending steps to localStorage:', err);
  }
}

function queuePendingStep(payload: FunnelPayload): void {
  const payloadKey = getPayloadKey(payload);
  const pending = readPendingSteps();

  // Deduplicar
  if (pending.some((item) => getPayloadKey(item) === payloadKey)) return;

  // Limitar tamanho da fila para evitar overflow do localStorage
  const trimmed = pending.length >= MAX_PENDING_STEPS
    ? pending.slice(pending.length - MAX_PENDING_STEPS + 1)
    : pending;

  writePendingSteps([...trimmed, { ...payload, retryCount: 0 }]);
}

function removePendingStep(payload: FunnelPayload): void {
  const payloadKey = getPayloadKey(payload);
  const pending = readPendingSteps().filter((item) => getPayloadKey(item) !== payloadKey);
  writePendingSteps(pending);
}

function updateRetryCount(payload: FunnelPayload, retryCount: number): void {
  const payloadKey = getPayloadKey(payload);
  const pending = readPendingSteps().map((item) =>
    getPayloadKey(item) === payloadKey ? { ...item, retryCount } : item
  );
  writePendingSteps(pending);
}

async function sendFunnelStep(payload: FunnelPayload): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const { error } = await (supabase.rpc as any)('track_public_funnel_step', {
      _company_id: payload.company_id,
      _visitor_id: payload.visitor_id,
      _step: payload.step,
      _date: payload.date, // YYYY-MM-DD em UTC
    });

    if (error) {
      console.warn(`[Funnel] RPC error for step "${payload.step}":`, error.message ?? error);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function getBackoffDelayMs(retryCount: number): number {
  // 1s, 2s, 4s, 8s, 16s (max ~16s)
  return Math.min(1000 * 2 ** retryCount, 16000);
}

export function useFunnelTracking(companyId: string | undefined) {
  const logged = useRef<Set<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());
  const isFlushInProgress = useRef(false);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback((delayMs = 0) => {
    if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    flushTimeoutRef.current = setTimeout(() => {
      flushTimeoutRef.current = null;
      void flushPendingSteps();
    }, delayMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushPendingSteps = useCallback(async (): Promise<void> => {
    // Evita flush paralelo (race condition)
    if (isFlushInProgress.current) return;
    isFlushInProgress.current = true;

    try {
      const pending = readPendingSteps();
      if (pending.length === 0) return;

      for (const payload of pending) {
        const payloadKey = getPayloadKey(payload);

        if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) continue;

        const retryCount = payload.retryCount ?? 0;
        if (retryCount >= MAX_RETRY_COUNT) {
          console.warn(`[Funnel] Max retries reached for step "${payload.step}", discarding.`);
          emitDebug('discarded', payload, { retryCount });
          removePendingStep(payload);
          continue;
        }

        inFlight.current.add(payloadKey);

        try {
          await sendFunnelStep(payload);
          logged.current.add(payloadKey);
          emitDebug('sent', payload);
          removePendingStep(payload);
        } catch (err: unknown) {
          const nextRetry = retryCount + 1;
          const errorMessage = err instanceof Error ? err.message : String(err);
          updateRetryCount(payload, nextRetry);
          const delay = getBackoffDelayMs(nextRetry);
          console.warn(`[Funnel] Retry ${nextRetry}/${MAX_RETRY_COUNT} for step "${payload.step}" in ${delay}ms`);
          emitDebug('retry', payload, { retryCount: nextRetry, errorMessage });
          scheduleFlush(delay);
        } finally {
          inFlight.current.delete(payloadKey);
        }
      }
    } finally {
      isFlushInProgress.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleFlush]);

  useEffect(() => {
    void flushPendingSteps();

    const handleOnline = () => void flushPendingSteps();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void flushPendingSteps();
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    };
  }, [flushPendingSteps]);

  const trackStep = useCallback(async (step: FunnelStep): Promise<void> => {
    if (!companyId) {
      console.warn('[Funnel] trackStep called without companyId, ignoring.');
      return;
    }

    const payload: FunnelPayload = {
      company_id: companyId,
      visitor_id: getVisitorId(),
      step,
      date: getTrackingDateUTC(), // ← UTC, não timezone local
    };
    const payloadKey = getPayloadKey(payload);

    if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) return;

    queuePendingStep(payload);
    emitDebug('queued', payload);
    await flushPendingSteps();
  }, [companyId, flushPendingSteps]);

  return { trackStep };
}
