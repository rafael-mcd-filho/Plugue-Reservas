import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export const FUNNEL_STEPS = [
  'page_view',
  'date_select',
  'time_select',
  'form_fill',
  'completed',
] as const;

export type FunnelStep = typeof FUNNEL_STEPS[number];

export const STEP_LABELS: Record<FunnelStep, string> = {
  page_view: 'Pagina Publica',
  date_select: 'Selecao de Data',
  time_select: 'Selecao de Horario',
  form_fill: 'Dados Pessoais',
  completed: 'Reserva Finalizada',
};

const TRACKING_ANONYMOUS_KEY = 'pg_tracking_anonymous_id';
const TRACKING_STATE_KEY = 'pg_tracking_state_v1';
const PENDING_TRACKING_STORAGE_KEY = 'pg_tracking_pending_events';
const MAX_PENDING_EVENTS = 80;
const MAX_RETRY_COUNT = 5;

export type FunnelDebugEventType = 'queued' | 'sent' | 'failed' | 'retry' | 'discarded';

export interface FunnelDebugEvent {
  type: FunnelDebugEventType;
  step: FunnelStep;
  date: string;
  retryCount?: number;
  errorMessage?: string;
  timestamp: string;
}

interface StoredTrackingState {
  anonymous_id: string;
  company_id?: string;
  company_slug?: string;
  session_id?: string | null;
  journey_id?: string | null;
  touched_at?: string;
}

export interface TrackingUserData {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  external_id?: string | null;
}

interface TrackingEventPayload {
  event_name: string;
  event_id: string;
  company_id?: string;
  slug?: string;
  anonymous_id: string;
  session_id?: string | null;
  journey_id?: string | null;
  reservation_id?: string | null;
  step?: FunnelStep | null;
  page_url?: string | null;
  path?: string | null;
  referrer?: string | null;
  event_source_url?: string | null;
  occurred_at?: string;
  metadata?: Record<string, unknown>;
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  user_data?: TrackingUserData | null;
  retryCount?: number;
}

export interface TrackingSnapshot {
  anonymous_id: string;
  session_id: string | null;
  journey_id: string | null;
  company_id: string | undefined;
  company_slug: string | undefined;
  fbp: string | null;
  fbc: string | null;
  fbclid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  page_url: string | null;
  path: string | null;
  referrer: string | null;
  event_source_url: string | null;
  attribution_snapshot: Record<string, unknown>;
}

function emitDebug(type: FunnelDebugEventType, payload: TrackingEventPayload, extra?: { retryCount?: number; errorMessage?: string }) {
  if (!payload.step) return;

  try {
    window.dispatchEvent(new CustomEvent<FunnelDebugEvent>('funnel:debug', {
      detail: {
        type,
        step: payload.step,
        date: new Date().toISOString().split('T')[0],
        retryCount: extra?.retryCount,
        errorMessage: extra?.errorMessage,
        timestamp: new Date().toISOString(),
      },
    }));
  } catch {
    // Debug jamais deve quebrar a captura real.
  }
}

function safeGetLocation() {
  if (typeof window === 'undefined') {
    return {
      pageUrl: null,
      path: null,
      referrer: null,
      eventSourceUrl: null,
    };
  }

  const pageUrl = window.location.href;
  return {
    pageUrl,
    path: `${window.location.pathname}${window.location.search}`,
    referrer: document.referrer || null,
    eventSourceUrl: pageUrl,
  };
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  if (!cookie) return null;
  return decodeURIComponent(cookie.split('=').slice(1).join('='));
}

function deriveFbc(fbc: string | null, fbclid: string | null): string | null {
  if (fbc) return fbc;
  if (!fbclid) return null;
  return `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}`;
}

function getCurrentAttribution() {
  if (typeof window === 'undefined') {
    return {
      fbclid: null,
      fbp: null,
      fbc: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    };
  }

  const url = new URL(window.location.href);
  const fbclid = url.searchParams.get('fbclid');
  const fbp = getCookie('_fbp');
  const fbc = deriveFbc(getCookie('_fbc'), fbclid);

  return {
    fbclid,
    fbp,
    fbc,
    utm_source: url.searchParams.get('utm_source'),
    utm_medium: url.searchParams.get('utm_medium'),
    utm_campaign: url.searchParams.get('utm_campaign'),
    utm_content: url.searchParams.get('utm_content'),
    utm_term: url.searchParams.get('utm_term'),
  };
}

function readStoredState(): StoredTrackingState | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = localStorage.getItem(TRACKING_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTrackingState;
    if (!parsed || typeof parsed.anonymous_id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredState(state: StoredTrackingState) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TRACKING_STATE_KEY, JSON.stringify(state));
}

function mergeStoredState(next: Partial<StoredTrackingState>): StoredTrackingState {
  const previous = readStoredState() ?? { anonymous_id: getVisitorId() };
  const merged: StoredTrackingState = {
    ...previous,
    ...next,
    anonymous_id: next.anonymous_id ?? previous.anonymous_id ?? getVisitorId(),
    touched_at: new Date().toISOString(),
  };

  writeStoredState(merged);
  return merged;
}

function readPendingEvents(): TrackingEventPayload[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = localStorage.getItem(PENDING_TRACKING_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is TrackingEventPayload => {
      return (
        !!item &&
        typeof item === 'object' &&
        typeof (item as TrackingEventPayload).event_name === 'string' &&
        typeof (item as TrackingEventPayload).event_id === 'string' &&
        typeof (item as TrackingEventPayload).anonymous_id === 'string'
      );
    });
  } catch {
    return [];
  }
}

function writePendingEvents(payloads: TrackingEventPayload[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PENDING_TRACKING_STORAGE_KEY, JSON.stringify(payloads));
}

function getPendingEventKey(payload: TrackingEventPayload) {
  return [
    payload.session_id ?? 'no-session',
    payload.journey_id ?? 'no-journey',
    payload.event_name,
    payload.step ?? 'no-step',
    payload.path ?? 'no-path',
  ].join('|');
}

function queuePendingEvent(payload: TrackingEventPayload) {
  const payloadKey = getPendingEventKey(payload);
  const pending = readPendingEvents();

  if (pending.some((item) => getPendingEventKey(item) === payloadKey)) {
    return;
  }

  const nextQueue = pending.length >= MAX_PENDING_EVENTS
    ? pending.slice(pending.length - MAX_PENDING_EVENTS + 1)
    : pending;

  writePendingEvents([...nextQueue, payload]);
}

function removePendingEvent(payload: TrackingEventPayload) {
  const payloadKey = getPendingEventKey(payload);
  writePendingEvents(
    readPendingEvents().filter((item) => getPendingEventKey(item) !== payloadKey),
  );
}

function updatePendingRetryCount(payload: TrackingEventPayload, retryCount: number) {
  const payloadKey = getPendingEventKey(payload);
  writePendingEvents(
    readPendingEvents().map((item) => {
      if (getPendingEventKey(item) !== payloadKey) return item;
      return { ...item, retryCount };
    }),
  );
}

function getRetryDelayMs(retryCount: number) {
  return Math.min(1000 * 2 ** retryCount, 16000);
}

export function getVisitorId(): string {
  if (typeof window === 'undefined') {
    return crypto.randomUUID();
  }

  try {
    let id = localStorage.getItem(TRACKING_ANONYMOUS_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(TRACKING_ANONYMOUS_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function buildPayload(
  state: StoredTrackingState,
  companyId: string | undefined,
  companySlug: string | undefined,
  eventName: string,
  extra?: Partial<TrackingEventPayload>,
): TrackingEventPayload {
  const attribution = getCurrentAttribution();
  const location = safeGetLocation();

  return {
    event_name: eventName,
    event_id: crypto.randomUUID(),
    company_id: companyId,
    slug: companySlug,
    anonymous_id: state.anonymous_id,
    session_id: state.session_id ?? null,
    journey_id: state.journey_id ?? null,
    page_url: location.pageUrl,
    path: location.path,
    referrer: location.referrer,
    event_source_url: location.eventSourceUrl,
    occurred_at: new Date().toISOString(),
    fbp: attribution.fbp,
    fbc: attribution.fbc,
    fbclid: attribution.fbclid,
    utm_source: attribution.utm_source,
    utm_medium: attribution.utm_medium,
    utm_campaign: attribution.utm_campaign,
    utm_content: attribution.utm_content,
    utm_term: attribution.utm_term,
    ...extra,
  };
}

function buildSnapshot(state: StoredTrackingState, companyId: string | undefined, companySlug: string | undefined): TrackingSnapshot {
  const attribution = getCurrentAttribution();
  const location = safeGetLocation();

  return {
    anonymous_id: state.anonymous_id,
    session_id: state.session_id ?? null,
    journey_id: state.journey_id ?? null,
    company_id: companyId,
    company_slug: companySlug,
    fbp: attribution.fbp,
    fbc: attribution.fbc,
    fbclid: attribution.fbclid,
    utm_source: attribution.utm_source,
    utm_medium: attribution.utm_medium,
    utm_campaign: attribution.utm_campaign,
    utm_content: attribution.utm_content,
    utm_term: attribution.utm_term,
    page_url: location.pageUrl,
    path: location.path,
    referrer: location.referrer,
    event_source_url: location.eventSourceUrl,
    attribution_snapshot: {
      tracking_source: 'public_web',
      anonymous_id: state.anonymous_id,
      session_id: state.session_id ?? null,
      journey_id: state.journey_id ?? null,
      page_url: location.pageUrl,
      path: location.path,
      referrer: location.referrer,
      event_source_url: location.eventSourceUrl,
      fbp: attribution.fbp,
      fbc: attribution.fbc,
      fbclid: attribution.fbclid,
      utm_source: attribution.utm_source,
      utm_medium: attribution.utm_medium,
      utm_campaign: attribution.utm_campaign,
      utm_content: attribution.utm_content,
      utm_term: attribution.utm_term,
    },
  };
}

export function useFunnelTracking(companyId: string | undefined, companySlug?: string) {
  const logged = useRef<Set<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());
  const isFlushInProgress = useRef(false);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback((delayMs = 0) => {
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
    }

    flushTimeoutRef.current = setTimeout(() => {
      flushTimeoutRef.current = null;
      void flushPendingEvents();
    }, delayMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendEvent = useCallback(async (payload: TrackingEventPayload) => {
    const { data, error } = await supabase.functions.invoke('public-tracking', {
      body: payload,
    });

    if (error) {
      throw error;
    }

    const result = (data ?? {}) as {
      anonymous_id?: string;
      session_id?: string | null;
      journey_id?: string | null;
    };

    mergeStoredState({
      anonymous_id: result.anonymous_id ?? payload.anonymous_id,
      company_id: companyId,
      company_slug: companySlug,
      session_id: result.session_id ?? payload.session_id ?? null,
      journey_id: result.journey_id ?? payload.journey_id ?? null,
    });
  }, [companyId, companySlug]);

  const flushPendingEvents = useCallback(async (): Promise<void> => {
    if (isFlushInProgress.current) return;
    isFlushInProgress.current = true;

    try {
      const pending = readPendingEvents();
      if (pending.length === 0) return;

      for (const payload of pending) {
        const payloadKey = getPendingEventKey(payload);
        if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) continue;

        const retryCount = payload.retryCount ?? 0;
        if (retryCount >= MAX_RETRY_COUNT) {
          emitDebug('discarded', payload, { retryCount });
          removePendingEvent(payload);
          continue;
        }

        inFlight.current.add(payloadKey);

        try {
          await sendEvent(payload);
          logged.current.add(payloadKey);
          emitDebug('sent', payload);
          removePendingEvent(payload);
        } catch (error: unknown) {
          const nextRetry = retryCount + 1;
          const errorMessage = error instanceof Error ? error.message : String(error);
          updatePendingRetryCount(payload, nextRetry);
          emitDebug('retry', payload, { retryCount: nextRetry, errorMessage });
          scheduleFlush(getRetryDelayMs(nextRetry));
        } finally {
          inFlight.current.delete(payloadKey);
        }
      }
    } finally {
      isFlushInProgress.current = false;
    }
  }, [scheduleFlush, sendEvent]);

  useEffect(() => {
    const state = readStoredState();
    if (!state) {
      mergeStoredState({
        anonymous_id: getVisitorId(),
        company_id: companyId,
        company_slug: companySlug,
      });
    } else if (state.company_id !== companyId || state.company_slug !== companySlug) {
      mergeStoredState({
        ...state,
        company_id: companyId,
        company_slug: companySlug,
        journey_id: null,
      });
    }
  }, [companyId, companySlug]);

  useEffect(() => {
    void flushPendingEvents();

    const handleOnline = () => void flushPendingEvents();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void flushPendingEvents();
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    };
  }, [flushPendingEvents]);

  const ensureSession = useCallback(async () => {
    const state = readStoredState() ?? mergeStoredState({
      anonymous_id: getVisitorId(),
      company_id: companyId,
      company_slug: companySlug,
    });

    if (state.session_id) return state;

    const payload = buildPayload(state, companyId, companySlug, 'session_ping');
    await sendEvent(payload);

    return readStoredState() ?? mergeStoredState({
      ...state,
      company_id: companyId,
      company_slug: companySlug,
    });
  }, [companyId, companySlug, sendEvent]);

  const startJourney = useCallback(async () => {
    if (!companyId && !companySlug) return null;

    const sessionState = await ensureSession();
    if (sessionState.journey_id) {
      return buildSnapshot(sessionState, companyId, companySlug);
    }

    const journeyId = crypto.randomUUID();
    const nextState = mergeStoredState({
      ...sessionState,
      journey_id: journeyId,
      company_id: companyId,
      company_slug: companySlug,
    });

    const payload = buildPayload(nextState, companyId, companySlug, 'booking_started', {
      journey_id: journeyId,
      metadata: {
        tracking_source: 'public_web',
        source: 'reservation_modal',
      },
    });

    queuePendingEvent(payload);
    await flushPendingEvents();

    return buildSnapshot(readStoredState() ?? nextState, companyId, companySlug);
  }, [companyId, companySlug, ensureSession, flushPendingEvents]);

  const clearJourney = useCallback(() => {
    const state = readStoredState();
    if (!state) return;

    mergeStoredState({
      ...state,
      journey_id: null,
      company_id: companyId,
      company_slug: companySlug,
    });
  }, [companyId, companySlug]);

  const getTrackingSnapshot = useCallback(async (): Promise<TrackingSnapshot> => {
    const state = await ensureSession();
    return buildSnapshot(state, companyId, companySlug);
  }, [companyId, companySlug, ensureSession]);

  const trackLeadCapture = useCallback(async (userData: TrackingUserData) => {
    if (!companyId && !companySlug) return;

    const sessionState = await ensureSession();
    const state = readStoredState()?.journey_id
      ? (readStoredState() as StoredTrackingState)
      : (await startJourney(), readStoredState() ?? sessionState);

    const payload = buildPayload(state, companyId, companySlug, 'lead_captured', {
      journey_id: state.journey_id ?? null,
      metadata: {
        tracking_source: 'public_web',
        source: 'reservation_form_submit',
      },
      user_data: userData,
    });

    queuePendingEvent(payload);
    await flushPendingEvents();
  }, [companyId, companySlug, ensureSession, flushPendingEvents, startJourney]);

  const trackStep = useCallback(async (step: FunnelStep) => {
    if (!companyId && !companySlug) return;
    if (step === 'completed') return;

    const sessionState = await ensureSession();
    const state = step === 'page_view'
      ? sessionState
      : readStoredState()?.journey_id
        ? (readStoredState() as StoredTrackingState)
        : (await startJourney(), readStoredState() ?? sessionState);

    const eventName = step;
    const payload = buildPayload(state, companyId, companySlug, eventName, {
      step,
      journey_id: step === 'page_view' ? null : state.journey_id ?? null,
      metadata: {
        tracking_source: 'public_web',
      },
    });

    const payloadKey = getPendingEventKey(payload);
    if (logged.current.has(payloadKey) || inFlight.current.has(payloadKey)) return;

    queuePendingEvent(payload);
    emitDebug('queued', payload);
    await flushPendingEvents();
  }, [companyId, companySlug, ensureSession, flushPendingEvents, startJourney]);

  return {
    trackStep,
    startJourney,
    getTrackingSnapshot,
    trackLeadCapture,
    clearJourney,
  };
}
