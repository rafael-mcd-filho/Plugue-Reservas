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
  page_view: 'P\u00E1gina P\u00FAblica',
  date_select: 'Sele\u00E7\u00E3o de Data',
  time_select: 'Sele\u00E7\u00E3o de Hor\u00E1rio',
  form_fill: 'Dados Pessoais',
  completed: 'Reserva Finalizada',
};

export { STEP_LABELS };

const PENDING_STEPS_STORAGE_KEY = 'rv_funnel_pending_steps';

interface FunnelPayload {
  company_id: string;
  visitor_id: string;
  step: FunnelStep;
  date: string;
}

function getVisitorId(): string {
  const key = 'rv_visitor_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function getTrackingDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getPayloadKey(payload: FunnelPayload): string {
  return `${payload.company_id}_${payload.visitor_id}_${payload.step}_${payload.date}`;
}

function readPendingSteps(): FunnelPayload[] {
  try {
    const raw = localStorage.getItem(PENDING_STEPS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is FunnelPayload => {
      return !!item
        && typeof item.company_id === 'string'
        && typeof item.visitor_id === 'string'
        && typeof item.step === 'string'
        && typeof item.date === 'string'
        && FUNNEL_STEPS.includes(item.step as FunnelStep);
    });
  } catch {
    return [];
  }
}

function writePendingSteps(payloads: FunnelPayload[]) {
  localStorage.setItem(PENDING_STEPS_STORAGE_KEY, JSON.stringify(payloads));
}

function queuePendingStep(payload: FunnelPayload) {
  const payloadKey = getPayloadKey(payload);
  const pending = readPendingSteps();

  if (pending.some((item) => getPayloadKey(item) === payloadKey)) return;

  writePendingSteps([...pending, payload]);
}

function removePendingStep(payload: FunnelPayload) {
  const payloadKey = getPayloadKey(payload);
  const pending = readPendingSteps().filter((item) => getPayloadKey(item) !== payloadKey);
  writePendingSteps(pending);
}

async function sendFunnelStep(payload: FunnelPayload) {
  try {
    const { error } = await (supabase.rpc as any)('track_public_funnel_step', {
      _company_id: payload.company_id,
      _visitor_id: payload.visitor_id,
      _step: payload.step,
      _date: payload.date, // YYYY-MM-DD format
    });

    if (error) {
      console.error('Funnel tracking error:', error);
      throw error;
    }
  } catch (err) {
    console.error('Failed to track funnel step:', payload.step, err);
    throw err;
  }
}

export function useFunnelTracking(companyId: string | undefined) {
  const logged = useRef<Set<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());

  const flushPendingSteps = useCallback(async () => {
    const pending = readPendingSteps();

    for (const payload of pending) {
      const payloadKey = getPayloadKey(payload);

      if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) continue;

      inFlight.current.add(payloadKey);

      try {
        await sendFunnelStep(payload);
        logged.current.add(payloadKey);
        removePendingStep(payload);
      } catch (error) {
        console.warn('Failed to track funnel step', payload.step, error);
      } finally {
        inFlight.current.delete(payloadKey);
      }
    }
  }, []);

  useEffect(() => {
    void flushPendingSteps();

    const handleOnline = () => {
      void flushPendingSteps();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void flushPendingSteps();
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushPendingSteps]);

  const trackStep = useCallback(async (step: FunnelStep) => {
    if (!companyId) return;

    const payload: FunnelPayload = {
      company_id: companyId,
      visitor_id: getVisitorId(),
      step,
      date: getTrackingDate(),
    };
    const payloadKey = getPayloadKey(payload);

    if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) return;

    queuePendingStep(payload);
    await flushPendingSteps();
  }, [companyId, flushPendingSteps]);

  return { trackStep };
}
