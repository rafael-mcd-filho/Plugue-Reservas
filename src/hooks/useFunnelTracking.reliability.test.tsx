/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

import { useFunnelTracking, type TrackingEventPayload } from '@/hooks/useFunnelTracking';
import {
  enqueueFunnelEvent,
  getFunnelTrackingScope,
  getPersistedVisitorId,
  MAX_TRACKING_COMPANY_SCOPES,
  mergeTrackingState,
  migrateLegacyTrackingStorage,
  readFunnelDeadLetters,
  readPendingFunnelEvents,
  readTrackingState,
  recordFunnelEventFailure,
  resetFunnelTrackingPersistenceForTests,
  TRACKING_DEAD_LETTER_TTL_MS,
  TRACKING_PENDING_EVENT_TTL_MS,
  type FunnelQueuePayload,
} from '@/lib/funnelTrackingPersistence';

if (!window.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } satisfies Storage,
  });
}

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successfulResponse(body: TrackingEventPayload) {
  return {
    data: {
      ok: true,
      company_id: body.company_id ?? `id-${body.slug}`,
      anonymous_id: body.anonymous_id,
      session_id: `session-${body.slug ?? body.company_id}`,
      journey_id: body.journey_id ?? null,
    },
    error: null,
  };
}

function invokedPayloads(): TrackingEventPayload[] {
  return mocks.invoke.mock.calls.map(([, options]) => options.body as TrackingEventPayload);
}

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useFunnelTracking reliability', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    resetFunnelTrackingPersistenceForTests();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => (
      Promise.resolve(successfulResponse(body))
    ));
    window.history.replaceState(null, '', '/company-a');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
    resetFunnelTrackingPersistenceForTests();
  });

  it('shares one concurrent session creation and one concurrent journey creation', async () => {
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let snapshots!: Awaited<ReturnType<typeof result.current.getTrackingSnapshot>>[];
    await act(async () => {
      snapshots = await Promise.all([
        result.current.getTrackingSnapshot(),
        result.current.getTrackingSnapshot(),
        result.current.getTrackingSnapshot(),
      ]);
    });

    expect(snapshots.every((snapshot) => snapshot.session_id === 'session-company-a')).toBe(true);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'session_ping')).toHaveLength(1);

    let journeys!: Awaited<ReturnType<typeof result.current.startJourney>>[];
    await act(async () => {
      journeys = await Promise.all([
        result.current.startJourney(),
        result.current.startJourney(),
        result.current.startJourney(),
      ]);
    });

    expect(new Set(journeys.map((snapshot) => snapshot?.journey_id)).size).toBe(1);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'booking_started')).toHaveLength(1);
  });

  it('shares one durable session claim across independent hook instances', async () => {
    const pendingPings: Array<{
      body: TrackingEventPayload;
      request: ReturnType<typeof deferred<ReturnType<typeof successfulResponse>>>;
    }> = [];
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      const request = deferred<ReturnType<typeof successfulResponse>>();
      pendingPings.push({ body, request });
      return request.promise;
    });
    const firstHook = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    const secondHook = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let firstSnapshotPromise!: ReturnType<typeof firstHook.result.current.getTrackingSnapshot>;
    let secondSnapshotPromise!: ReturnType<typeof secondHook.result.current.getTrackingSnapshot>;
    act(() => {
      firstSnapshotPromise = firstHook.result.current.getTrackingSnapshot();
      secondSnapshotPromise = secondHook.result.current.getTrackingSnapshot();
    });
    await settleEffects();

    expect(pendingPings.length).toBeGreaterThan(0);
    expect(new Set(pendingPings.map(({ body }) => body.event_id)).size).toBe(1);
    expect(new Set(pendingPings.map(({ body }) => body.session_id)).size).toBe(1);
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    expect(readPendingFunnelEvents(scope)
      .filter((item) => item.payload.event_name === 'session_ping')).toHaveLength(1);

    for (const { body, request } of pendingPings) {
      request.resolve({
        data: {
          ...successfulResponse(body).data,
          session_id: body.session_id,
        },
        error: null,
      });
    }
    let snapshots!: Awaited<typeof firstSnapshotPromise>[];
    await act(async () => {
      snapshots = await Promise.all([firstSnapshotPromise, secondSnapshotPromise]);
    });
    expect(new Set(snapshots.map((snapshot) => snapshot.session_id)).size).toBe(1);
    expect(snapshots[0].session_id).toBe(pendingPings[0].body.session_id);
  });

  it('creates the cold session and page_view in one Edge request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.trackStep('page_view');
    });

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    expect(readPendingFunnelEvents(scope)).toHaveLength(0);
    expect(invokedPayloads()).toHaveLength(1);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'session_ping')).toHaveLength(0);
    const pageViewPayload = invokedPayloads()[0];
    expect(pageViewPayload.event_name).toBe('page_view');
    expect(pageViewPayload.session_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(pageViewPayload?.occurred_at).toBe(new Date(NOW).toISOString());
    expect(readTrackingState(scope)?.session_id).toBe('session-company-a');
  });

  it('retries a response-lost bootstrap page_view with stable event and session IDs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let pageViewAttempts = 0;
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'page_view') {
        pageViewAttempts += 1;
        if (pageViewAttempts === 1) {
          return Promise.resolve({ data: null, error: new Error('response lost') });
        }
        return Promise.resolve({
          data: {
            ok: true,
            company_id: body.company_id,
            anonymous_id: body.anonymous_id,
            session_id: body.session_id,
            journey_id: null,
          },
          error: null,
        });
      }
      return Promise.resolve(successfulResponse(body));
    });

    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.trackStep('page_view');
    });
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    const retryAt = Math.min(...readPendingFunnelEvents(scope).map((item) => item.nextAttemptAt));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() + 1);
    });

    const pageViews = invokedPayloads().filter((payload) => payload.event_name === 'page_view');
    expect(pageViews).toHaveLength(2);
    expect(new Set(pageViews.map((payload) => payload.event_id)).size).toBe(1);
    expect(new Set(pageViews.map((payload) => payload.session_id)).size).toBe(1);
    expect(pageViews[0].session_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'session_ping')).toHaveLength(0);
  });

  it('reuses the pending bootstrap page_view when session consumers run during backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('offline') });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.trackStep('page_view');
    });

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    const firstPageView = readPendingFunnelEvents<TrackingEventPayload>(scope)
      .find((item) => item.payload.event_name === 'page_view')!;
    await act(async () => {
      await Promise.all([
        result.current.getTrackingSnapshot(),
        result.current.getTrackingSnapshot(),
        result.current.startJourney(),
      ]);
    });

    const pendingPageViews = readPendingFunnelEvents<TrackingEventPayload>(scope)
      .filter((item) => item.payload.event_name === 'page_view');
    expect(pendingPageViews).toHaveLength(1);
    expect(pendingPageViews[0].payload.event_id).toBe(firstPageView.payload.event_id);
    expect(pendingPageViews[0].payload.session_id).toBe(firstPageView.payload.session_id);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'page_view'))
      .toHaveLength(1);
  });

  it('does not acknowledge a 200 response with a missing tracking context', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    await act(async () => {
      await result.current.trackStep('page_view');
    });

    const pending = readPendingFunnelEvents<TrackingEventPayload>(
      getFunnelTrackingScope('company-a', 'company-a')!,
    );
    expect(pending.map((item) => item.payload.event_name)).toEqual(['page_view']);
    expect(pending[0]?.retryCount).toBe(1);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'page_view')).toHaveLength(1);
  });

  it('dead-letters a permanent bootstrap failure without a recovery loop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('unauthorized'), { status: 401 }),
    });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    await act(async () => {
      await result.current.trackStep('page_view');
    });
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    expect(readPendingFunnelEvents(scope)).toHaveLength(0);
    expect(readFunnelDeadLetters(scope).map((item) => item.eventName).sort())
      .toEqual(['page_view']);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('drains an event queued while the active flush is waiting for the network', async () => {
    const firstRequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => (
        Promise.resolve(successfulResponse(body))
      ));

    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let snapshotPromise!: ReturnType<typeof result.current.getTrackingSnapshot>;
    act(() => {
      snapshotPromise = result.current.getTrackingSnapshot();
    });
    await settleEffects();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    let pageViewPromise!: ReturnType<typeof result.current.trackStep>;
    act(() => {
      pageViewPromise = result.current.trackStep('page_view');
    });
    firstRequest.resolve(successfulResponse(invokedPayloads()[0]));

    await act(async () => {
      await Promise.all([snapshotPromise, pageViewPromise]);
    });

    expect(invokedPayloads().map((payload) => payload.event_name)).toEqual([
      'session_ping',
      'page_view',
    ]);
    expect(readPendingFunnelEvents(getFunnelTrackingScope('company-a', 'company-a')!))
      .toHaveLength(0);
  });

  it('shares the in-flight journey and hydrates a server-rotated journey before later steps', async () => {
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.getTrackingSnapshot();
    });

    const bookingRequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'booking_started') return bookingRequest.promise;
      return Promise.resolve(successfulResponse(body));
    });

    let firstJourney!: ReturnType<typeof result.current.startJourney>;
    act(() => {
      firstJourney = result.current.startJourney();
    });
    await settleEffects();
    const bookingPayload = invokedPayloads().find((payload) => payload.event_name === 'booking_started')!;

    let secondJourney!: ReturnType<typeof result.current.startJourney>;
    let dateStep!: ReturnType<typeof result.current.trackStep>;
    let snapshot!: ReturnType<typeof result.current.getTrackingSnapshot>;
    act(() => {
      secondJourney = result.current.startJourney();
      dateStep = result.current.trackStep('date_select');
      snapshot = result.current.getTrackingSnapshot();
    });
    await settleEffects();
    expect(invokedPayloads().some((payload) => payload.event_name === 'date_select')).toBe(false);

    bookingRequest.resolve({
      data: {
        ok: true,
        company_id: bookingPayload.company_id,
        anonymous_id: bookingPayload.anonymous_id,
        session_id: bookingPayload.session_id,
        journey_id: 'journey-from-server',
      },
      error: null,
    });

    let resolved!: [
      Awaited<typeof firstJourney>,
      Awaited<typeof secondJourney>,
      void,
      Awaited<typeof snapshot>,
    ];
    await act(async () => {
      resolved = await Promise.all([firstJourney, secondJourney, dateStep, snapshot]);
    });
    expect(resolved[0]?.journey_id).toBe('journey-from-server');
    expect(resolved[1]?.journey_id).toBe('journey-from-server');
    expect(resolved[3].journey_id).toBe('journey-from-server');
    expect(invokedPayloads().find((payload) => payload.event_name === 'date_select')?.journey_id)
      .toBe('journey-from-server');
  });

  it('does not restore or use a journey cleared while booking_started is in flight', async () => {
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.getTrackingSnapshot();
    });

    const bookingRequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'booking_started') return bookingRequest.promise;
      return Promise.resolve(successfulResponse(body));
    });
    let journey!: ReturnType<typeof result.current.startJourney>;
    let dateStep!: ReturnType<typeof result.current.trackStep>;
    let snapshot!: ReturnType<typeof result.current.getTrackingSnapshot>;
    act(() => {
      journey = result.current.startJourney();
      dateStep = result.current.trackStep('date_select');
      snapshot = result.current.getTrackingSnapshot();
    });
    await settleEffects();
    const bookingPayload = invokedPayloads().find((payload) => payload.event_name === 'booking_started')!;

    act(() => {
      result.current.clearJourney();
    });
    bookingRequest.resolve(successfulResponse({
      ...bookingPayload,
      journey_id: 'late-server-journey',
    }));

    let resolvedJourney!: Awaited<typeof journey>;
    let resolvedSnapshot!: Awaited<typeof snapshot>;
    await act(async () => {
      [resolvedJourney, , resolvedSnapshot] = await Promise.all([journey, dateStep, snapshot]);
    });
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    expect(resolvedJourney).toBeNull();
    expect(resolvedSnapshot.journey_id).toBeNull();
    expect(readTrackingState(scope)?.journey_id).toBeNull();
    expect(invokedPayloads().some((payload) => payload.event_name === 'date_select')).toBe(false);
  });

  it('never reassigns queued events from a cleared journey to a new journey', async () => {
    let failBooking = true;
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'booking_started' && failBooking) {
        return Promise.resolve({ data: null, error: new Error('offline') });
      }
      return Promise.resolve(successfulResponse(body));
    });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.getTrackingSnapshot();
    });

    let oldJourney!: Awaited<ReturnType<typeof result.current.startJourney>>;
    await act(async () => {
      oldJourney = await result.current.startJourney();
      await result.current.trackStep('date_select');
    });
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    const oldJourneyId = readTrackingState(scope)!.journey_id!;
    expect(oldJourney).toBeNull();
    act(() => {
      result.current.clearJourney();
    });
    const callsAfterClear = mocks.invoke.mock.calls.length;
    failBooking = false;

    let newJourney!: Awaited<ReturnType<typeof result.current.startJourney>>;
    await act(async () => {
      newJourney = await result.current.startJourney();
    });
    expect(newJourney?.journey_id).not.toBe(oldJourneyId);
    expect(invokedPayloads().slice(callsAfterClear).some((payload) => (
      payload.journey_id === oldJourneyId
    ))).toBe(false);
    expect(readPendingFunnelEvents(scope)
      .some((item) => item.payload.journey_id === oldJourneyId)).toBe(false);
  });

  it('uses a stable in-memory fallback when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    let first!: Awaited<ReturnType<typeof result.current.getTrackingSnapshot>>;
    let second!: Awaited<ReturnType<typeof result.current.getTrackingSnapshot>>;
    await act(async () => {
      first = await result.current.getTrackingSnapshot();
      second = await result.current.getTrackingSnapshot();
    });

    expect(second.anonymous_id).toBe(first.anonymous_id);
    expect(second.session_id).toBe(first.session_id);
    expect(invokedPayloads().filter((payload) => payload.event_name === 'session_ping')).toHaveLength(1);
  });

  it('partitions companies and prevents an old response from mutating the active company', async () => {
    const companyARequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.slug === 'company-a') return companyARequest.promise;
      return Promise.resolve(successfulResponse(body));
    });

    const { result, rerender } = renderHook(
      ({ companyId, slug }) => useFunnelTracking(companyId, slug),
      { initialProps: { companyId: 'company-a', slug: 'company-a' } },
    );
    await settleEffects();
    let companyAPromise!: ReturnType<typeof result.current.getTrackingSnapshot>;
    act(() => {
      companyAPromise = result.current.getTrackingSnapshot();
    });
    await settleEffects();

    rerender({ companyId: 'company-b', slug: 'company-b' });
    let companyBSnapshot!: Awaited<ReturnType<typeof result.current.getTrackingSnapshot>>;
    await act(async () => {
      companyBSnapshot = await result.current.getTrackingSnapshot();
    });
    expect(companyBSnapshot.session_id).toBe('session-company-b');

    const companyAPayload = invokedPayloads().find((payload) => payload.slug === 'company-a')!;
    companyARequest.resolve(successfulResponse(companyAPayload));
    await act(async () => {
      await companyAPromise;
    });

    const scopeA = getFunnelTrackingScope('company-a', 'company-a')!;
    const scopeB = getFunnelTrackingScope('company-b', 'company-b')!;
    expect(readTrackingState(scopeA)?.session_id).toBe('session-company-a');
    expect(readTrackingState(scopeB)?.session_id).toBe('session-company-b');
    expect(readPendingFunnelEvents(scopeA)).toHaveLength(0);
    expect(readPendingFunnelEvents(scopeB)).toHaveLength(0);
  });

  it('does not let a stale normal-event response overwrite a newer session', async () => {
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.getTrackingSnapshot();
    });

    const pageRequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'page_view') return pageRequest.promise;
      return Promise.resolve(successfulResponse(body));
    });
    let pagePromise!: ReturnType<typeof result.current.trackStep>;
    act(() => {
      pagePromise = result.current.trackStep('page_view');
    });
    await settleEffects();
    const pagePayload = invokedPayloads().find((payload) => payload.event_name === 'page_view')!;
    expect(pagePayload.session_id).toBe('session-company-a');

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    mergeTrackingState(scope, {
      anonymous_id: pagePayload.anonymous_id,
      session_id: 'session-newer-tab',
      pending_session_id: null,
      pending_session_event_id: null,
    });
    pageRequest.resolve({
      data: {
        ...successfulResponse(pagePayload).data,
        session_id: 'session-rotated-old-event',
      },
      error: null,
    });
    await act(async () => {
      await pagePromise;
    });

    expect(readTrackingState(scope)?.session_id).toBe('session-newer-tab');
  });

  it('keeps the session already bound to a delayed queued event', async () => {
    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    mergeTrackingState(scope, {
      anonymous_id: 'anonymous-delayed',
      company_id: 'company-a',
      company_slug: 'company-a',
      session_id: 'session-current',
      journey_id: null,
    });
    enqueueFunnelEvent<TrackingEventPayload>(scope, {
      event_name: 'page_view',
      event_id: 'event-from-old-session',
      company_id: 'company-a',
      slug: 'company-a',
      anonymous_id: 'anonymous-delayed',
      session_id: 'session-original',
      journey_id: null,
      step: 'page_view',
      occurred_at: '2026-08-20T11:00:00.000Z',
    }, 'delayed-page-view');

    renderHook(() => useFunnelTracking('company-a', 'company-a'));

    await vi.waitFor(() => {
      expect(invokedPayloads().some((payload) => payload.event_id === 'event-from-old-session'))
        .toBe(true);
    });
    const delayedPayload = invokedPayloads()
      .find((payload) => payload.event_id === 'event-from-old-session')!;
    expect(delayedPayload.session_id).toBe('session-original');
  });

  it('does not expose a provisional journey when its bootstrap is pending retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'booking_started') {
        return Promise.resolve({ data: null, error: new Error('offline') });
      }
      return Promise.resolve(successfulResponse(body));
    });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let startedJourney!: Awaited<ReturnType<typeof result.current.startJourney>>;
    await act(async () => {
      startedJourney = await result.current.startJourney();
    });
    let snapshot!: Awaited<ReturnType<typeof result.current.getTrackingSnapshot>>;
    await act(async () => {
      snapshot = await result.current.getTrackingSnapshot();
    });

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    expect(startedJourney).toBeNull();
    expect(snapshot.journey_id).toBeNull();
    expect(snapshot.attribution_snapshot.journey_id).toBeNull();
    expect(readTrackingState(scope)).toMatchObject({
      journey_id: expect.any(String),
      journey_confirmed: false,
    });
  });

  it('times out a hung Edge request so the durable queue can retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let trackingPromise!: ReturnType<typeof result.current.trackStep>;
    act(() => {
      trackingPromise = result.current.trackStep('page_view');
    });
    await settleEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_001);
      await trackingPromise;
    });

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    const pending = readPendingFunnelEvents<TrackingEventPayload>(scope);
    expect(pending.map((item) => item.payload.event_name)).toEqual(['page_view']);
    expect(pending[0]?.retryCount).toBe(1);
    expect(mocks.invoke.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it('sends the unchanged public-tracking payload without queue bookkeeping', async () => {
    window.history.replaceState(
      null,
      '',
      '/company-a?utm_source=instagram&utm_medium=social&fbclid=click-1',
    );
    const { result } = renderHook(() => useFunnelTracking('company-a-id', 'company-a'));
    await settleEffects();

    const userData = {
      email: 'lead@example.com',
      phone: '+5583999999999',
      first_name: 'Lead',
    };
    await act(async () => {
      await result.current.trackLeadCapture(userData);
    });

    const payload = invokedPayloads().find((item) => item.event_name === 'lead_captured')!;
    expect(payload).toMatchObject({
      event_name: 'lead_captured',
      company_id: 'company-a-id',
      slug: 'company-a',
      journey_id: expect.any(String),
      occurred_at: expect.any(String),
      utm_source: 'instagram',
      utm_medium: 'social',
      fbclid: 'click-1',
      metadata: {
        tracking_source: 'public_web',
        source: 'reservation_form_submit',
      },
      user_data: userData,
    });
    expect(payload.event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload).not.toHaveProperty('retryCount');
    expect(payload).not.toHaveProperty('nextAttemptAt');
    expect(payload).not.toHaveProperty('queuedAt');
    expect(payload).not.toHaveProperty('dedupeKey');
  });

  it('keeps lead PII in memory only while preserving the original Edge payload', async () => {
    const { result } = renderHook(() => useFunnelTracking('company-a-id', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.startJourney();
    });

    const leadRequest = deferred<ReturnType<typeof successfulResponse>>();
    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => {
      if (body.event_name === 'lead_captured') return leadRequest.promise;
      return Promise.resolve(successfulResponse(body));
    });
    const userData = {
      email: 'private@example.com',
      phone: '+5583999999999',
      birthdate: '1990-01-01',
    };
    let trackingPromise!: ReturnType<typeof result.current.trackLeadCapture>;
    act(() => {
      trackingPromise = result.current.trackLeadCapture(userData);
    });
    await settleEffects();

    const leadPayload = invokedPayloads().find((payload) => payload.event_name === 'lead_captured')!;
    expect(leadPayload.user_data).toEqual(userData);
    const durableBrowserState = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? ''
    ))
      .join('|');
    expect(durableBrowserState).not.toContain('private@example.com');
    expect(durableBrowserState).not.toContain('+5583999999999');
    expect(durableBrowserState).not.toContain('1990-01-01');

    leadRequest.resolve(successfulResponse(leadPayload));
    await act(async () => {
      await trackingPromise;
    });
  });

  it('sanitizes arbitrary URL query data before writing a retry payload', () => {
    const scope = 'slug:company-a';
    enqueueFunnelEvent(scope, {
      event_id: 'safe-url-event',
      event_name: 'page_view',
      anonymous_id: 'anonymous-1',
      page_url: 'https://example.com/book?utm_source=instagram&email=private%40example.com&token=secret#private-fragment',
      event_source_url: 'https://example.com/book?fbclid=click-1&auth=private-auth',
      referrer: 'https://instagram.com/story?utm_campaign=august&phone=5583999999999',
      path: '/book?pr_ad=campaign-code&custom=private-custom#secret',
    }, 'safe-url');

    expect(readPendingFunnelEvents<FunnelQueuePayload>(scope)[0].payload).toMatchObject({
      page_url: 'https://example.com/book?utm_source=instagram',
      event_source_url: 'https://example.com/book?fbclid=click-1',
      referrer: 'https://instagram.com/story?utm_campaign=august',
      path: '/book?pr_ad=campaign-code',
    });
    const durableBrowserState = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? ''
    )).join('|');
    expect(durableBrowserState).toContain('utm_source');
    expect(durableBrowserState).toContain('fbclid');
    expect(durableBrowserState).toContain('pr_ad');
    expect(durableBrowserState).not.toContain('private@example.com');
    expect(durableBrowserState).not.toContain('private%40example.com');
    expect(durableBrowserState).not.toContain('secret');
    expect(durableBrowserState).not.toContain('private-auth');
    expect(durableBrowserState).not.toContain('5583999999999');
    expect(durableBrowserState).not.toContain('private-custom');
  });

  it('keeps dead-letter logs free of lead PII', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('invalid request'), { status: 422 }),
    });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    await act(async () => {
      await result.current.trackLeadCapture({
        email: 'private@example.com',
        phone: '+5583999999999',
        external_id: 'customer-private',
      });
    });
    expect(consoleError).toHaveBeenCalled();
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain('private@example.com');
    expect(logged).not.toContain('+5583999999999');
    expect(logged).not.toContain('customer-private');
  });

  it('cancels scheduled retries on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('offline') });
    const { result, unmount } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    await act(async () => {
      await result.current.trackStep('page_view');
    });
    const callsBeforeUnmount = mocks.invoke.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('does not schedule a retry when an in-flight request settles after unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const inFlightRequest = deferred<{ data: null; error: Error }>();
    mocks.invoke
      .mockImplementationOnce(() => inFlightRequest.promise)
      .mockResolvedValue({ data: null, error: new Error('offline') });
    const { result, unmount } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();

    let trackingPromise!: ReturnType<typeof result.current.trackStep>;
    act(() => {
      trackingPromise = result.current.trackStep('page_view');
    });
    await settleEffects();
    unmount();
    inFlightRequest.resolve({ data: null, error: new Error('offline') });
    await act(async () => {
      await trackingPromise;
    });
    const callsAfterSettlement = mocks.invoke.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(callsAfterSettlement);
  });

  it('keeps transient failures past five attempts and sends immediately when online', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.invoke.mockResolvedValue({ data: null, error: new Error('offline') });
    const { result } = renderHook(() => useFunnelTracking('company-a', 'company-a'));
    await settleEffects();
    await act(async () => {
      await result.current.trackStep('page_view');
    });

    const scope = getFunnelTrackingScope('company-a', 'company-a')!;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const nextAttemptAt = Math.min(
        ...readPendingFunnelEvents(scope).map((item) => item.nextAttemptAt),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.max(1, nextAttemptAt - Date.now() + 1));
      });
    }

    const pending = readPendingFunnelEvents<TrackingEventPayload>(scope);
    expect(pending).toHaveLength(1);
    expect(readFunnelDeadLetters(scope)).toHaveLength(0);
    const bootstrapEventId = pending[0].payload.event_id;

    mocks.invoke.mockImplementation((_: string, { body }: { body: TrackingEventPayload }) => (
      Promise.resolve(successfulResponse(body))
    ));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(readPendingFunnelEvents(scope)).toHaveLength(0);
    const pageViewAttempts = invokedPayloads().filter((payload) => payload.event_name === 'page_view');
    expect(new Set(pageViewAttempts.map((payload) => payload.event_id))).toEqual(new Set([bootstrapEventId]));
    expect(readTrackingState(scope)?.session_id).toBe('session-company-a');
  });
});

describe('funnel tracking persistence safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    window.localStorage.clear();
    resetFunnelTrackingPersistenceForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();
    resetFunnelTrackingPersistenceForTests();
  });

  it('moves a permanent error to a redacted, expiring dead letter', () => {
    const scope = 'slug:company-a';
    const payload = {
      event_id: 'event-private',
      event_name: 'lead_captured',
      anonymous_id: 'anonymous-private',
      slug: 'company-a',
      user_data: {
        email: 'private@example.com',
        phone: '+5583999999999',
      },
    } as FunnelQueuePayload;
    enqueueFunnelEvent(scope, payload, 'lead-captured');

    recordFunnelEventFailure(
      scope,
      payload.event_id,
      'request failed for private@example.com at https://example.com?token=secret',
      { now: NOW, permanent: true },
    );

    expect(readPendingFunnelEvents(scope)).toHaveLength(0);
    const deadLetters = readFunnelDeadLetters(scope);
    expect(deadLetters).toEqual([
      expect.objectContaining({
        eventId: 'event-private',
        eventName: 'lead_captured',
        scope,
        retryCount: 1,
        reason: 'permanent_error',
      }),
    ]);
    const stored = window.localStorage.getItem('pg_tracking_dead_letters_v1') ?? '';
    expect(stored).not.toContain('anonymous-private');
    expect(stored).not.toContain('private@example.com');
    expect(stored).not.toContain('+5583999999999');
    expect(stored).not.toContain('token=secret');

    vi.setSystemTime(NOW + TRACKING_DEAD_LETTER_TTL_MS + 1);
    expect(readFunnelDeadLetters(scope)).toHaveLength(0);
    expect(window.localStorage.getItem('pg_tracking_dead_letters_v1')).not.toContain('event-private');
  });

  it('expires a pending payload by age during read without retaining its PII', () => {
    const scope = 'slug:company-a';
    enqueueFunnelEvent(scope, {
      event_id: 'expired-event',
      event_name: 'lead_captured',
      anonymous_id: 'expired-anonymous',
      slug: 'company-a',
      user_data: { email: 'expired@example.com' },
    } as FunnelQueuePayload, 'expired-lead');

    expect(readPendingFunnelEvents(scope, NOW + TRACKING_PENDING_EVENT_TTL_MS + 1))
      .toHaveLength(0);
    expect(readFunnelDeadLetters(scope)).toEqual([
      expect.objectContaining({ eventId: 'expired-event', reason: 'expired' }),
    ]);
    const stored = window.localStorage.getItem('pg_tracking_dead_letters_v1') ?? '';
    expect(stored).not.toContain('expired-anonymous');
    expect(stored).not.toContain('expired@example.com');
  });

  it('telemeters queue overflow instead of silently dropping the oldest event', () => {
    const scope = 'slug:company-a';
    let overflowCount = 0;
    for (let index = 0; index < 81; index += 1) {
      const result = enqueueFunnelEvent(scope, {
        event_id: `event-${index}`,
        event_name: 'page_view',
        anonymous_id: 'anonymous-private',
        slug: 'company-a',
      }, `page-${index}`);
      overflowCount += result.overflow.length;
    }

    expect(readPendingFunnelEvents(scope)).toHaveLength(80);
    expect(overflowCount).toBe(1);
    expect(readFunnelDeadLetters(scope)).toEqual([
      expect.objectContaining({
        eventId: 'event-0',
        reason: 'queue_capacity',
      }),
    ]);
  });

  it('never reuses an unscoped or different-company legacy session', () => {
    window.localStorage.setItem('pg_tracking_state_v1', JSON.stringify({
      anonymous_id: 'legacy-anonymous',
      session_id: 'session-company-a',
      journey_id: 'journey-company-a',
    }));

    const scopeB = getFunnelTrackingScope('company-b', 'company-b')!;
    migrateLegacyTrackingStorage(scopeB, 'company-b', 'company-b');

    expect(readTrackingState(scopeB)).toBeNull();
    expect(getPersistedVisitorId()).toBe('legacy-anonymous');

    resetFunnelTrackingPersistenceForTests();
    window.localStorage.setItem('pg_tracking_state_v1', JSON.stringify({
      anonymous_id: 'legacy-company-a',
      company_id: 'company-a',
      company_slug: 'company-a',
      session_id: 'session-company-a',
      journey_id: 'journey-company-a',
    }));
    migrateLegacyTrackingStorage(scopeB, 'company-b', 'company-b');
    expect(readTrackingState(scopeB)).toBeNull();
  });

  it('keeps the legacy queue when the partitioned write cannot be persisted', () => {
    const legacyPayload = {
      event_id: 'legacy-event',
      event_name: 'page_view',
      anonymous_id: 'legacy-anonymous',
      slug: 'company-a',
      step: 'page_view',
    };
    window.localStorage.setItem('pg_tracking_pending_events', JSON.stringify([legacyPayload]));
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(function setItem(key, value) {
      if (key.startsWith('pg_tracking_pending_event_v3:')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    });

    const scope = getFunnelTrackingScope(undefined, 'company-a')!;
    migrateLegacyTrackingStorage(scope, undefined, 'company-a');

    expect(readPendingFunnelEvents(scope)).toHaveLength(1);
    expect(window.localStorage.getItem('pg_tracking_pending_events')).toContain('legacy-event');
    migrateLegacyTrackingStorage(scope, undefined, 'company-a');
    expect(window.localStorage.getItem('pg_tracking_pending_events')).toContain('legacy-event');

    setItemSpy.mockRestore();
    migrateLegacyTrackingStorage(scope, undefined, 'company-a');
    expect(window.localStorage.getItem('pg_tracking_pending_events')).toBeNull();
    expect(readPendingFunnelEvents(scope)).toHaveLength(1);
  });

  it('does not resurrect a state removed by another browser context', () => {
    const scope = 'slug:company-a';
    mergeTrackingState(scope, {
      anonymous_id: 'anonymous-a',
      session_id: 'session-a',
    });
    expect(readTrackingState(scope)?.session_id).toBe('session-a');

    const stateKey = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.key(index)
    )).find((key) => key?.startsWith('pg_tracking_state_v3:'))!;
    window.localStorage.removeItem(stateKey);
    expect(readTrackingState(scope)).toBeNull();
  });

  it('purges invalid pending timestamps and malformed dead-letter entries on read', () => {
    const scope = 'slug:company-a';
    enqueueFunnelEvent(scope, {
      event_id: 'invalid-time-event',
      event_name: 'lead_captured',
      anonymous_id: 'private-anonymous',
      user_data: { email: 'private@example.com' },
    } as FunnelQueuePayload, 'invalid-time');
    const pendingKey = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.key(index)
    )).find((key) => key?.startsWith('pg_tracking_pending_event_v3:'))!;
    const queueEnvelope = JSON.parse(
      window.localStorage.getItem(pendingKey) ?? '{}',
    ) as { item: Record<string, unknown> };
    queueEnvelope.item.queuedAt = 'not-a-date';
    window.localStorage.setItem(pendingKey, JSON.stringify(queueEnvelope));
    window.localStorage.setItem('pg_tracking_dead_letters_v1', JSON.stringify({
      [scope]: [null, {}, { deadLetteredAt: 'not-a-date' }],
    }));

    expect(readPendingFunnelEvents(scope)).toHaveLength(0);
    expect(() => readFunnelDeadLetters(scope)).not.toThrow();
    const persistedQueue = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? ''
    )).join('|');
    expect(persistedQueue).not.toContain('private@example.com');
    expect(persistedQueue).not.toContain('private-anonymous');
  });

  it('bounds pending payload retention across company scopes and redacts evictions', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let index = 0; index <= MAX_TRACKING_COMPANY_SCOPES; index += 1) {
      enqueueFunnelEvent(`slug:company-${index}`, {
        event_id: `event-${index}`,
        event_name: 'lead_captured',
        anonymous_id: `private-anonymous-${index}`,
        user_data: { email: `private-${index}@example.com` },
      } as FunnelQueuePayload, `lead-${index}`);
    }

    const storedQueueKeys = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.key(index)
    )).filter((key) => key?.startsWith('pg_tracking_pending_event_v3:'));
    expect(storedQueueKeys).toHaveLength(MAX_TRACKING_COMPANY_SCOPES);
    expect(readFunnelDeadLetters('slug:company-0')).toEqual([
      expect.objectContaining({ eventId: 'event-0', reason: 'scope_capacity' }),
    ]);
    const diagnostics = JSON.stringify(consoleError.mock.calls);
    expect(diagnostics).not.toContain('private-0@example.com');
    expect(diagnostics).not.toContain('private-anonymous-0');
  });

  it('keeps independent event keys isolated across concurrent browser contexts', () => {
    const scopeA = 'slug:company-a';
    const scopeB = 'slug:company-b';
    enqueueFunnelEvent(scopeA, {
      event_id: 'tab-a-event',
      event_name: 'page_view',
      anonymous_id: 'anonymous-a',
    }, 'tab-a');
    enqueueFunnelEvent(scopeB, {
      event_id: 'tab-b-event',
      event_name: 'page_view',
      anonymous_id: 'anonymous-b',
    }, 'tab-b');

    const eventKeys = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.key(index)
    )).filter((key) => key?.startsWith('pg_tracking_pending_event_v3:'));
    expect(eventKeys).toHaveLength(2);

    recordFunnelEventFailure(scopeA, 'tab-a-event', 'offline');
    expect(readPendingFunnelEvents(scopeB).map((item) => item.payload.event_id))
      .toEqual(['tab-b-event']);
    const eventA = readPendingFunnelEvents(scopeA)[0];
    expect(eventA.retryCount).toBe(1);
  });

  it('migrates the v2 queue fail-safe into per-event keys', () => {
    const scope = 'slug:company-a';
    window.localStorage.setItem('pg_tracking_pending_events_v2', JSON.stringify({
      [scope]: [{
        payload: {
          event_id: 'v2-event',
          event_name: 'lead_captured',
          anonymous_id: 'anonymous-private',
          user_data: { email: 'private@example.com' },
        },
        dedupeKey: 'v2-lead',
        retryCount: 2,
        nextAttemptAt: NOW + 1_000,
        queuedAt: new Date(NOW).toISOString(),
      }],
    }));

    expect(readPendingFunnelEvents(scope)).toEqual([
      expect.objectContaining({
        retryCount: 2,
        payload: expect.not.objectContaining({ user_data: expect.anything() }),
      }),
    ]);
    expect(window.localStorage.getItem('pg_tracking_pending_events_v2')).toBeNull();
    const stored = Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.getItem(window.localStorage.key(index) ?? '') ?? ''
    )).join('|');
    expect(stored).not.toContain('private@example.com');
  });
});
