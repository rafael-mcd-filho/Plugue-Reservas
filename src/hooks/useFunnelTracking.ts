import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { normalizeTrackingTextValue } from '@/lib/trackingAttribution';
import {
  acknowledgeFunnelEvent,
  deadLetterJourneyDependentFunnelEvents,
  deadLetterSessionDependentFunnelEvents,
  deferFunnelEvent,
  enqueueFunnelEvent,
  getFunnelTrackingScope,
  getNextFunnelAttemptDelay,
  getPersistedVisitorId,
  mergeTrackingState,
  makeJourneyDependentFunnelEventsDue,
  makePendingFunnelEventsDue,
  makeSessionDependentFunnelEventsDue,
  migrateLegacyTrackingStorage,
  readPendingFunnelEvents,
  readTrackingState,
  recordFunnelEventFailure,
  remapPendingJourneyEvents,
  removePendingJourneyEvents,
  type FunnelQueuePayload,
  type PersistedTrackingState,
} from '@/lib/funnelTrackingPersistence';

export const FUNNEL_STEPS = [
  'page_view',
  'date_select',
  'time_select',
  'form_fill',
  'completed',
] as const;

const FUNNEL_TRACKING_REQUEST_TIMEOUT_MS = 12_000;

export type FunnelStep = typeof FUNNEL_STEPS[number];

export const STEP_LABELS: Record<FunnelStep, string> = {
  page_view: 'Página Pública',
  date_select: 'Seleção de Data',
  time_select: 'Seleção de Horário',
  form_fill: 'Dados Pessoais',
  completed: 'Reserva Finalizada',
};

export type FunnelDebugEventType = 'queued' | 'sent' | 'failed' | 'retry' | 'discarded';

export interface FunnelDebugEvent {
  type: FunnelDebugEventType;
  step: FunnelStep;
  date: string;
  retryCount?: number;
  errorMessage?: string;
  timestamp: string;
}

type StoredTrackingState = PersistedTrackingState;

export interface TrackingUserData {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  birthdate?: string | null;
  external_id?: string | null;
}

export interface TrackingEventPayload extends FunnelQueuePayload {
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
  pr_ad?: string | null;
  user_data?: TrackingUserData | null;
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
  pr_ad?: string | null;
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
  const rawValue = cookie.split('=').slice(1).join('=');
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue || null;
  }
}

function deriveFbc(fbc: string | null, fbclid: string | null): string | null {
  if (fbc) return fbc;
  if (!fbclid) return null;
  return `fb.1.${Date.now()}.${fbclid}`;
}

export function getCurrentAttribution() {
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
      pr_ad: null,
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
    pr_ad: normalizeTrackingTextValue(url.searchParams.get('pr_ad')),
  };
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

function getSensitiveOverlayKey(scope: string, eventId: string) {
  return `${scope}|${eventId}`;
}

export function getVisitorId(): string {
  return getPersistedVisitorId();
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
  const metadata = {
    ...(extra?.metadata ?? {}),
    ...(attribution.pr_ad ? { pr_ad: attribution.pr_ad } : {}),
  };

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
    pr_ad: attribution.pr_ad,
    ...extra,
    metadata,
  };
}

function buildSnapshot(state: StoredTrackingState, companyId: string | undefined, companySlug: string | undefined): TrackingSnapshot {
  const attribution = getCurrentAttribution();
  const location = safeGetLocation();
  const confirmedJourneyId = state.journey_id && state.journey_confirmed !== false
    ? state.journey_id
    : null;

  return {
    anonymous_id: state.anonymous_id,
    session_id: state.session_id ?? null,
    journey_id: confirmedJourneyId,
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
    pr_ad: attribution.pr_ad,
    page_url: location.pageUrl,
    path: location.path,
    referrer: location.referrer,
    event_source_url: location.eventSourceUrl,
    attribution_snapshot: {
      tracking_source: 'public_web',
      anonymous_id: state.anonymous_id,
      session_id: state.session_id ?? null,
      journey_id: confirmedJourneyId,
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
      pr_ad: attribution.pr_ad,
    },
  };
}

function isPermanentTrackingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    context?: { status?: unknown };
  };
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.context?.status === 'number'
      ? candidate.context.status
      : null;

  return status !== null
    && status >= 400
    && status < 500
    && ![408, 425, 429].includes(status);
}

function buildRecoverySessionPayload(payload: TrackingEventPayload): TrackingEventPayload {
  const recovery = { ...payload };
  delete recovery.reservation_id;
  delete recovery.step;
  delete recovery.user_data;
  return {
    ...recovery,
    event_name: 'session_ping',
    event_id: crypto.randomUUID(),
    // The Edge accepts this client UUID when the session does not exist. A
    // response-lost retry therefore resolves the same session without storing
    // session_ping as a tracking event.
    session_id: crypto.randomUUID(),
    journey_id: null,
    occurred_at: new Date().toISOString(),
  };
}

function buildRecoveryJourneyPayload(payload: TrackingEventPayload): TrackingEventPayload {
  const recovery = { ...payload };
  delete recovery.reservation_id;
  delete recovery.step;
  delete recovery.user_data;
  return {
    ...recovery,
    event_name: 'booking_started',
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    metadata: {
      tracking_source: 'public_web',
      source: 'reservation_modal_recovery',
    },
  };
}

export function useFunnelTracking(companyId: string | undefined, companySlug?: string) {
  const scope = getFunnelTrackingScope(companyId, companySlug);
  const isMounted = useRef(true);
  const logged = useRef<Set<string>>(new Set());
  const inFlight = useRef<Set<string>>(new Set());
  const flushPromises = useRef<Map<string, Promise<void>>>(new Map());
  const flushTimers = useRef<Map<string, {
    handle: ReturnType<typeof setTimeout>;
    dueAt: number;
  }>>(new Map());
  const flushFunction = useRef<(targetScope: string) => Promise<void>>(async () => undefined);
  const sessionPromises = useRef<Map<string, Promise<StoredTrackingState>>>(new Map());
  const journeyPromises = useRef<Map<string, Promise<TrackingSnapshot | null>>>(new Map());
  const journeyGenerations = useRef<Map<string, number>>(new Map());
  const sensitivePayloadOverlays = useRef<Map<string, TrackingUserData>>(new Map());

  const pruneSensitivePayloadOverlays = useCallback((targetScope: string) => {
    const pendingEventIds = new Set(
      readPendingFunnelEvents<TrackingEventPayload>(targetScope)
        .map((item) => item.payload.event_id),
    );
    const prefix = `${targetScope}|`;
    for (const key of sensitivePayloadOverlays.current.keys()) {
      if (key.startsWith(prefix) && !pendingEventIds.has(key.slice(prefix.length))) {
        sensitivePayloadOverlays.current.delete(key);
      }
    }
  }, []);

  const scheduleFlush = useCallback((targetScope: string, delayMs = 0) => {
    if (!isMounted.current) return;
    const dueAt = Date.now() + Math.max(0, delayMs);
    const existing = flushTimers.current.get(targetScope);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.handle);

    const handle = setTimeout(() => {
      flushTimers.current.delete(targetScope);
      void flushFunction.current(targetScope);
    }, Math.max(0, delayMs));

    flushTimers.current.set(targetScope, { handle, dueAt });
  }, []);

  const sendEvent = useCallback(async (
    targetScope: string,
    payload: TrackingEventPayload,
    journeyGeneration: number,
  ) => {
    // Queue bookkeeping never enters this body; the Edge/Meta contract stays unchanged.
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error('Tempo limite excedido ao enviar evento de tracking'));
      }, FUNNEL_TRACKING_REQUEST_TIMEOUT_MS);
    });

    let response: Awaited<ReturnType<typeof supabase.functions.invoke>>;
    try {
      response = await Promise.race([
        supabase.functions.invoke('public-tracking', {
          body: payload,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    const { data, error } = response;

    if (error) throw error;

    const result = (data ?? {}) as {
      ok?: boolean;
      company_id?: string;
      anonymous_id?: string;
      session_id?: string | null;
      journey_id?: string | null;
    };
    const responseIsValid = result.ok === true
      && typeof result.company_id === 'string'
      && result.company_id.length > 0
      && (!payload.company_id || result.company_id === payload.company_id)
      && result.anonymous_id === payload.anonymous_id
      && typeof result.session_id === 'string'
      && result.session_id.length > 0
      && (result.journey_id === null || typeof result.journey_id === 'string')
      && (
        typeof payload.journey_id !== 'string'
        || (typeof result.journey_id === 'string' && result.journey_id.length > 0)
      );
    if (!responseIsValid) {
      throw new Error('Resposta inválida do serviço de tracking');
    }

    const previous = readTrackingState(targetScope) ?? {
      anonymous_id: payload.anonymous_id,
    };

    const canApplyJourney = (journeyGenerations.current.get(targetScope) ?? 0) === journeyGeneration
      && typeof payload.journey_id === 'string'
      && payload.journey_id.length > 0
      && previous.journey_id === payload.journey_id
      && typeof result.journey_id === 'string'
      && result.journey_id.length > 0;
    const nextJourneyId = canApplyJourney
      ? result.journey_id as string
      : previous.journey_id ?? null;
    const isSessionBootstrap = payload.event_name === 'session_ping'
      || (
        !previous.session_id
        && previous.pending_session_event_id === payload.event_id
        && previous.pending_session_id === payload.session_id
      );
    const canApplySession = isSessionBootstrap
      ? previous.pending_session_event_id === payload.event_id
        || (!previous.pending_session_event_id && !previous.session_id)
      : previous.session_id === payload.session_id;
    mergeTrackingState(targetScope, {
      anonymous_id: result.anonymous_id ?? previous.anonymous_id ?? payload.anonymous_id,
      company_id: payload.company_id ?? previous.company_id,
      company_slug: payload.slug ?? previous.company_slug,
      session_id: canApplySession
        ? result.session_id ?? previous.session_id ?? payload.session_id ?? null
        : previous.session_id ?? null,
      pending_session_id: isSessionBootstrap && canApplySession
        ? null
        : previous.pending_session_id ?? null,
      pending_session_event_id: isSessionBootstrap && canApplySession
        ? null
        : previous.pending_session_event_id ?? null,
      // A delayed session/page response with journey_id=null cannot erase a newer journey.
      journey_id: nextJourneyId,
      journey_confirmed: canApplyJourney
        ? true
        : previous.journey_confirmed,
    });
    if (isSessionBootstrap && canApplySession) {
      makeSessionDependentFunnelEventsDue(targetScope);
    }
    if (canApplyJourney) {
      remapPendingJourneyEvents(targetScope, payload.journey_id as string, nextJourneyId as string);
      makeJourneyDependentFunnelEventsDue(targetScope);
    }
  }, []);

  const flushPendingEvents = useCallback((targetScope: string): Promise<void> => {
    const existing = flushPromises.current.get(targetScope);
    if (existing) return existing;

    const promise = Promise.resolve().then(async () => {
      while (true) {
        const now = Date.now();
        const due = readPendingFunnelEvents<TrackingEventPayload>(targetScope)
          .filter((item) => item.nextAttemptAt <= now)
          .filter((item) => !inFlight.current.has(`${targetScope}|${item.payload.event_id}`));

        if (due.length === 0) break;

        for (const dueItem of due) {
          // A prior item in this same batch may have hydrated/remapped this
          // payload. Always dispatch the latest per-event record.
          const item = readPendingFunnelEvents<TrackingEventPayload>(targetScope)
            .find((candidate) => candidate.payload.event_id === dueItem.payload.event_id);
          if (!item) continue;
          const flightKey = `${targetScope}|${item.payload.event_id}`;
          inFlight.current.add(flightKey);

          try {
            if (item.payload.event_name === 'session_ping') {
              const currentState = readTrackingState(targetScope);
              const superseded = !!currentState?.session_id
                || (
                  !!currentState?.pending_session_event_id
                  && currentState.pending_session_event_id !== item.payload.event_id
                );
              if (superseded) {
                acknowledgeFunnelEvent(targetScope, item.payload.event_id);
                emitDebug('discarded', item.payload);
                continue;
              }
            }

            let outboundPayload = item.payload;
            if (item.payload.event_name !== 'session_ping') {
              const state = readTrackingState(targetScope);
              const ownsPendingSession = !!state
                && state.pending_session_event_id === item.payload.event_id
                && state.pending_session_id === item.payload.session_id;
              if (!state?.session_id && !ownsPendingSession) {
                const pendingSession = readPendingFunnelEvents<TrackingEventPayload>(targetScope)
                  .find((pendingItem) => (
                    pendingItem.payload.event_id === state?.pending_session_event_id
                  ))
                  ?? readPendingFunnelEvents<TrackingEventPayload>(targetScope)
                    .find((pendingItem) => pendingItem.payload.event_name === 'session_ping');
                if (!pendingSession) {
                  const recoverySession = {
                    ...buildRecoverySessionPayload(item.payload),
                    event_id: state?.pending_session_event_id ?? crypto.randomUUID(),
                    session_id: state?.pending_session_id ?? crypto.randomUUID(),
                  };
                  mergeTrackingState(targetScope, {
                    ...(state ?? { anonymous_id: item.payload.anonymous_id }),
                    pending_session_id: recoverySession.session_id,
                    pending_session_event_id: recoverySession.event_id,
                  });
                  enqueueFunnelEvent(
                    targetScope,
                    recoverySession,
                    getPendingEventKey(recoverySession),
                  );
                }
                const resumeAt = pendingSession
                  ? Math.max(Date.now() + 1, pendingSession.nextAttemptAt)
                  : Date.now() + 1;
                deferFunnelEvent(targetScope, item.payload.event_id, resumeAt);
                continue;
              }
              if (!state) continue;

              const payloadJourneyId = typeof item.payload.journey_id === 'string'
                ? item.payload.journey_id
                : null;
              if (payloadJourneyId) {
                // A queued event belongs permanently to the journey in which it
                // happened. Never rewrite an old event into a journey opened
                // after clearJourney.
                if (state.journey_id !== payloadJourneyId) {
                  acknowledgeFunnelEvent(targetScope, item.payload.event_id);
                  emitDebug('discarded', item.payload);
                  continue;
                }

                const isJourneyBootstrap = item.payload.event_name === 'booking_started';
                if (!isJourneyBootstrap && state.journey_confirmed === false) {
                  const pendingJourney = readPendingFunnelEvents<TrackingEventPayload>(targetScope)
                    .find((pendingItem) => (
                      pendingItem.payload.event_name === 'booking_started'
                      && pendingItem.payload.journey_id === payloadJourneyId
                    ));
                  if (!pendingJourney) {
                    const recoveryJourney = buildRecoveryJourneyPayload(item.payload);
                    enqueueFunnelEvent(
                      targetScope,
                      recoveryJourney,
                      getPendingEventKey(recoveryJourney),
                    );
                  }
                  const resumeAt = pendingJourney
                    ? Math.max(Date.now() + 1, pendingJourney.nextAttemptAt)
                    : Date.now() + 1;
                  deferFunnelEvent(targetScope, item.payload.event_id, resumeAt);
                  continue;
                }
              }

              // event_id, occurred_at and an already-bound session remain untouched.
              // Only events queued before session creation are hydrated here.
              const queuedSessionId = typeof item.payload.session_id === 'string'
                && item.payload.session_id.length > 0
                ? item.payload.session_id
                : null;
              outboundPayload = {
                ...item.payload,
                session_id: queuedSessionId ?? state.session_id,
              };
            }

            const sensitiveUserData = sensitivePayloadOverlays.current.get(
              getSensitiveOverlayKey(targetScope, item.payload.event_id),
            );
            if (sensitiveUserData) {
              outboundPayload = { ...outboundPayload, user_data: sensitiveUserData };
            }

            const journeyGeneration = journeyGenerations.current.get(targetScope) ?? 0;
            await sendEvent(targetScope, outboundPayload, journeyGeneration);
            acknowledgeFunnelEvent(targetScope, item.payload.event_id);
            sensitivePayloadOverlays.current.delete(
              getSensitiveOverlayKey(targetScope, item.payload.event_id),
            );
            logged.current.add(`${targetScope}|${item.dedupeKey}`);
            emitDebug('sent', item.payload);
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const failure = recordFunnelEventFailure<TrackingEventPayload>(
              targetScope,
              item.payload.event_id,
              errorMessage,
              { permanent: isPermanentTrackingError(error) },
            );

            if (!failure.deadLetter) {
              emitDebug('retry', item.payload, {
                retryCount: failure.retryCount,
                errorMessage,
              });
            } else if (
              item.payload.event_name === 'session_ping'
              || readTrackingState(targetScope)?.pending_session_event_id === item.payload.event_id
            ) {
              const currentState = readTrackingState(targetScope);
              if (currentState?.pending_session_event_id === item.payload.event_id) {
                mergeTrackingState(targetScope, {
                  ...currentState,
                  pending_session_id: null,
                  pending_session_event_id: null,
                });
              }
              deadLetterSessionDependentFunnelEvents(
                targetScope,
                'permanent_session_dependency_failure',
              );
            } else if (
              item.payload.event_name === 'booking_started'
              && typeof item.payload.journey_id === 'string'
            ) {
              deadLetterJourneyDependentFunnelEvents(
                targetScope,
                item.payload.journey_id,
                'permanent_journey_dependency_failure',
              );
              const currentState = readTrackingState(targetScope);
              if (currentState?.journey_id === item.payload.journey_id) {
                journeyGenerations.current.set(
                  targetScope,
                  (journeyGenerations.current.get(targetScope) ?? 0) + 1,
                );
                mergeTrackingState(targetScope, {
                  ...currentState,
                  journey_id: null,
                  journey_confirmed: false,
                });
              }
            }
          } finally {
            inFlight.current.delete(flightKey);
            pruneSensitivePayloadOverlays(targetScope);
          }
        }
        // Re-read after every batch so events queued while a request was in flight
        // are drained by the same promise.
      }
    }).finally(() => {
      if (flushPromises.current.get(targetScope) === promise) {
        flushPromises.current.delete(targetScope);
      }

      const nextDelay = getNextFunnelAttemptDelay(targetScope);
      if (nextDelay !== null) scheduleFlush(targetScope, nextDelay);
    });

    flushPromises.current.set(targetScope, promise);
    return promise;
  }, [pruneSensitivePayloadOverlays, scheduleFlush, sendEvent]);

  flushFunction.current = flushPendingEvents;

  const queueEvent = useCallback((
    targetScope: string,
    payload: TrackingEventPayload,
  ): boolean => {
    const dedupeKey = getPendingEventKey(payload);
    const loggedKey = `${targetScope}|${dedupeKey}`;
    if (logged.current.has(loggedKey)) return false;

    const existingPending = readPendingFunnelEvents<TrackingEventPayload>(targetScope)
      .find((item) => item.dedupeKey === dedupeKey);
    if (payload.user_data) {
      sensitivePayloadOverlays.current.set(
        getSensitiveOverlayKey(
          targetScope,
          existingPending?.payload.event_id ?? payload.event_id,
        ),
        payload.user_data,
      );
    }

    const durablePayload = { ...payload };
    delete durablePayload.user_data;
    const result = enqueueFunnelEvent(targetScope, durablePayload, dedupeKey);
    for (const overflow of result.overflow) {
      sensitivePayloadOverlays.current.delete(
        getSensitiveOverlayKey(overflow.scope, overflow.eventId),
      );
    }

    if (result.queued) {
      emitDebug('queued', durablePayload);
      // This timer also closes the small race where an existing flush is resolving.
      scheduleFlush(targetScope, 0);
    }
    return result.queued;
  }, [scheduleFlush]);

  const getOrCreateState = useCallback((targetScope: string): StoredTrackingState => {
    const existing = readTrackingState(targetScope);
    const changedKnownCompany = !!companyId
      && !!existing?.company_id
      && existing.company_id !== companyId;

    return mergeTrackingState(targetScope, {
      anonymous_id: existing?.anonymous_id ?? getVisitorId(),
      company_id: companyId ?? existing?.company_id,
      company_slug: companySlug ?? existing?.company_slug,
      session_id: changedKnownCompany ? null : existing?.session_id ?? null,
      pending_session_id: changedKnownCompany ? null : existing?.pending_session_id ?? null,
      pending_session_event_id: changedKnownCompany
        ? null
        : existing?.pending_session_event_id ?? null,
      journey_id: changedKnownCompany ? null : existing?.journey_id ?? null,
      journey_confirmed: changedKnownCompany
        ? false
        : existing?.journey_id
          ? existing.journey_confirmed ?? true
          : false,
    });
  }, [companyId, companySlug]);

  useEffect(() => {
    if (!scope) return;

    migrateLegacyTrackingStorage(
      scope,
      companyId,
      companySlug,
      (payload) => getPendingEventKey(payload as TrackingEventPayload),
    );
    getOrCreateState(scope);
    void flushPendingEvents(scope);
  }, [companyId, companySlug, flushPendingEvents, getOrCreateState, scope]);

  useEffect(() => {
    if (!scope) return;

    const handleOnline = () => {
      makePendingFunnelEventsDue(scope);
      scheduleFlush(scope, 0);
      void flushPendingEvents(scope);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void flushPendingEvents(scope);
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushPendingEvents, scheduleFlush, scope]);

  useEffect(() => {
    isMounted.current = true;
    const timers = flushTimers.current;
    const sensitiveOverlays = sensitivePayloadOverlays.current;
    return () => {
      isMounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer.handle);
      timers.clear();
      sensitiveOverlays.clear();
    };
  }, []);

  const ensureSession = useCallback(async (): Promise<StoredTrackingState> => {
    if (!scope) {
      return {
        anonymous_id: getVisitorId(),
        company_id: companyId,
        company_slug: companySlug,
        session_id: null,
        journey_id: null,
      };
    }

    const state = getOrCreateState(scope);
    if (state.session_id) return state;

    const existingPromise = sessionPromises.current.get(scope);
    if (existingPromise) return existingPromise;

    const sessionPromise = (async () => {
      let latestState = getOrCreateState(scope);
      if (latestState.session_id) return latestState;

      const pendingEvents = readPendingFunnelEvents<TrackingEventPayload>(scope);
      const pendingSession = pendingEvents.find((item) => (
        item.payload.event_id === latestState.pending_session_event_id
      )) ?? pendingEvents.find((item) => item.payload.event_name === 'session_ping');
      if (pendingSession && latestState.pending_session_event_id !== pendingSession.payload.event_id) {
        latestState = mergeTrackingState(scope, {
          ...latestState,
          pending_session_id: typeof pendingSession.payload.session_id === 'string'
            ? pendingSession.payload.session_id
            : null,
          pending_session_event_id: pendingSession.payload.event_id,
        });
      }
      if (!pendingSession) {
        const pendingSessionId = latestState.pending_session_id ?? crypto.randomUUID();
        const pendingSessionEventId = latestState.pending_session_event_id ?? crypto.randomUUID();
        latestState = mergeTrackingState(scope, {
          ...latestState,
          pending_session_id: pendingSessionId,
          pending_session_event_id: pendingSessionEventId,
        });
        // session_ping is now as durable as every visible funnel step.
        const payload = buildPayload(
          latestState,
          companyId,
          companySlug,
          'session_ping',
          {
            event_id: pendingSessionEventId,
            session_id: pendingSessionId,
          },
        );
        queueEvent(scope, payload);
      }
      await flushPendingEvents(scope);
      return readTrackingState(scope) ?? latestState;
    })();

    sessionPromises.current.set(scope, sessionPromise);
    const clearSessionPromise = () => {
      if (sessionPromises.current.get(scope) === sessionPromise) {
        sessionPromises.current.delete(scope);
      }
    };
    void sessionPromise.then(clearSessionPromise, clearSessionPromise);
    return sessionPromise;
  }, [
    companyId,
    companySlug,
    flushPendingEvents,
    getOrCreateState,
    queueEvent,
    scope,
  ]);

  const startJourney = useCallback(async (): Promise<TrackingSnapshot | null> => {
    if (!scope) return null;

    // The promise check must come before the provisional state check. The first
    // caller stores a client UUID before the Edge response, and concurrent
    // callers must wait for that same request rather than consume it early.
    const existingPromise = journeyPromises.current.get(scope);
    if (existingPromise) return existingPromise;

    const current = getOrCreateState(scope);
    if (current.journey_id && current.journey_confirmed !== false) {
      return buildSnapshot(current, companyId, companySlug);
    }

    const generation = journeyGenerations.current.get(scope) ?? 0;
    const journeyPromise = (async () => {
      const sessionState = await ensureSession();
      const sessionRetryPending = readPendingFunnelEvents<TrackingEventPayload>(scope)
        .some((item) => item.payload.event_name === 'session_ping');
      if (!sessionState.session_id && !sessionRetryPending) return null;
      if ((journeyGenerations.current.get(scope) ?? 0) !== generation) return null;

      let latestState = readTrackingState(scope) ?? sessionState;
      if (latestState.journey_id && latestState.journey_confirmed !== false) {
        return buildSnapshot(latestState, companyId, companySlug);
      }

      const journeyId = latestState.journey_id ?? crypto.randomUUID();
      if (!latestState.journey_id) {
        latestState = mergeTrackingState(scope, {
          ...latestState,
          journey_id: journeyId,
          journey_confirmed: false,
          company_id: companyId,
          company_slug: companySlug,
        });
      }

      const pendingJourney = readPendingFunnelEvents<TrackingEventPayload>(scope)
        .some((item) => (
          item.payload.event_name === 'booking_started'
          && item.payload.journey_id === journeyId
        ));
      if (!pendingJourney) {
        const payload = buildPayload(latestState, companyId, companySlug, 'booking_started', {
          journey_id: journeyId,
          metadata: {
            tracking_source: 'public_web',
            source: 'reservation_modal',
          },
        });

        queueEvent(scope, payload);
      }
      await flushPendingEvents(scope);
      if ((journeyGenerations.current.get(scope) ?? 0) !== generation) return null;
      const resultState = readTrackingState(scope) ?? latestState;
      if (!resultState.journey_id || resultState.journey_confirmed === false) return null;
      return buildSnapshot(resultState, companyId, companySlug);
    })();

    journeyPromises.current.set(scope, journeyPromise);
    const clearJourneyPromise = () => {
      if (journeyPromises.current.get(scope) === journeyPromise) {
        journeyPromises.current.delete(scope);
      }
    };
    void journeyPromise.then(clearJourneyPromise, clearJourneyPromise);
    return journeyPromise;
  }, [
    companyId,
    companySlug,
    ensureSession,
    flushPendingEvents,
    getOrCreateState,
    queueEvent,
    scope,
  ]);

  const clearJourney = useCallback(() => {
    if (!scope) return;
    const state = readTrackingState(scope);

    journeyGenerations.current.set(scope, (journeyGenerations.current.get(scope) ?? 0) + 1);
    journeyPromises.current.delete(scope);
    if (!state) return;
    if (state.journey_id) {
      removePendingJourneyEvents(scope, state.journey_id);
      pruneSensitivePayloadOverlays(scope);
    }
    mergeTrackingState(scope, {
      ...state,
      journey_id: null,
      journey_confirmed: false,
      company_id: companyId,
      company_slug: companySlug,
    });
  }, [companyId, companySlug, pruneSensitivePayloadOverlays, scope]);

  const getTrackingSnapshot = useCallback(async (): Promise<TrackingSnapshot> => {
    const state = await ensureSession();
    if (scope) {
      const pendingJourney = journeyPromises.current.get(scope);
      if (pendingJourney) await pendingJourney;
    }
    return buildSnapshot(
      scope ? readTrackingState(scope) ?? state : state,
      companyId,
      companySlug,
    );
  }, [companyId, companySlug, ensureSession, scope]);

  const getOrStartConfirmedJourneyState = useCallback(async (
    sessionState: StoredTrackingState,
  ): Promise<StoredTrackingState | null> => {
    if (!scope) return sessionState;
    const sessionRetryPending = readPendingFunnelEvents<TrackingEventPayload>(scope)
      .some((item) => item.payload.event_name === 'session_ping');
    if (!sessionState.session_id && !sessionRetryPending) return null;
    const generation = journeyGenerations.current.get(scope) ?? 0;

    const pendingJourney = journeyPromises.current.get(scope);
    if (pendingJourney) await pendingJourney;
    if ((journeyGenerations.current.get(scope) ?? 0) !== generation) return null;

    let state = readTrackingState(scope) ?? sessionState;
    if (!state.journey_id) {
      await startJourney();
      if ((journeyGenerations.current.get(scope) ?? 0) !== generation) return null;
      state = readTrackingState(scope) ?? state;
    }
    return state;
  }, [scope, startJourney]);

  const trackLeadCapture = useCallback(async (userData: TrackingUserData) => {
    if (!scope) return;

    const sessionState = await ensureSession();
    const state = await getOrStartConfirmedJourneyState(sessionState);
    if (!state?.journey_id) return;

    const payload = buildPayload(state, companyId, companySlug, 'lead_captured', {
      journey_id: state.journey_id,
      metadata: {
        tracking_source: 'public_web',
        source: 'reservation_form_submit',
      },
      user_data: userData,
    });

    queueEvent(scope, payload);
    await flushPendingEvents(scope);
  }, [
    companyId,
    companySlug,
    ensureSession,
    flushPendingEvents,
    getOrStartConfirmedJourneyState,
    queueEvent,
    scope,
  ]);

  const trackStep = useCallback(async (step: FunnelStep) => {
    if (!scope || step === 'completed') return;

    if (step === 'page_view') {
      let state = getOrCreateState(scope);
      if (!state.session_id && !state.pending_session_event_id) {
        // public-tracking can create the provisional session and persist the
        // first page_view atomically. This removes a full serial Edge roundtrip
        // from the cold-load path while keeping event_id retries idempotent.
        const eventId = crypto.randomUUID();
        const pendingSessionId = state.pending_session_id ?? crypto.randomUUID();
        state = mergeTrackingState(scope, {
          ...state,
          pending_session_id: pendingSessionId,
          pending_session_event_id: eventId,
        });
        const bootstrapPayload = buildPayload(state, companyId, companySlug, 'page_view', {
          event_id: eventId,
          session_id: pendingSessionId,
          step,
          journey_id: null,
          metadata: {
            tracking_source: 'public_web',
          },
        });

        queueEvent(scope, bootstrapPayload);
        await flushPendingEvents(scope);
        return;
      }

      const sessionPromise = ensureSession();
      const payload = buildPayload(state, companyId, companySlug, 'page_view', {
        step,
        journey_id: null,
        metadata: {
          tracking_source: 'public_web',
        },
      });

      queueEvent(scope, payload);
      await Promise.all([sessionPromise, flushPendingEvents(scope)]);
      return;
    }

    const sessionState = await ensureSession();
    const state = await getOrStartConfirmedJourneyState(sessionState);
    if (!state?.journey_id) return;
    const payload = buildPayload(state, companyId, companySlug, step, {
      step,
      journey_id: state.journey_id ?? null,
      metadata: {
        tracking_source: 'public_web',
      },
    });

    queueEvent(scope, payload);
    await flushPendingEvents(scope);
  }, [
    companyId,
    companySlug,
    ensureSession,
    flushPendingEvents,
    getOrCreateState,
    getOrStartConfirmedJourneyState,
    queueEvent,
    scope,
  ]);

  return {
    trackStep,
    startJourney,
    getTrackingSnapshot,
    trackLeadCapture,
    clearJourney,
  };
}
