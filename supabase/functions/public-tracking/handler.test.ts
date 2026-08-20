import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row extends Record<string, unknown> {
  id?: string;
}

class FakeQuery implements PromiseLike<{ data: any; error: any }> {
  private operation: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private readonly filters = new Map<string, unknown>();

  constructor(
    private readonly database: FakeTrackingDatabase,
    private readonly table: string,
  ) {}

  select() { return this; }
  insert(payload: Row) { this.operation = "insert"; this.payload = payload; return this; }
  update(payload: Row) { this.operation = "update"; this.payload = payload; return this; }
  eq(column: string, value: unknown) { this.filters.set(column, value); return this; }
  lte(column: string, value: unknown) { this.filters.set(`__lte__${column}`, value); return this; }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  single() { return Promise.resolve(this.execute(true)); }

  then<TResult1 = { data: any; error: any }, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute(false)).then(onfulfilled, onrejected);
  }

  private execute(_single: boolean) {
    return this.database.execute(this.table, this.operation, this.payload, this.filters);
  }
}

class FakeTrackingDatabase {
  readonly sessions = new Map<string, Row>();
  readonly journeys = new Map<string, Row>();
  readonly events = new Map<string, Row>();
  readonly adsCalls: Array<Record<string, unknown>> = [];
  trackingEventInsertCount = 0;
  metaTriggerCount = 0;
  forceDuplicateOnNextTrackingInsert = false;
  beforeNextSessionTimestampUpdate: (() => void) | null = null;

  from = (table: string) => new FakeQuery(this, table);
  rpc = async (_name: string, args: Record<string, unknown>) => {
    this.adsCalls.push(args);
    return { error: null };
  };

  execute(
    table: string,
    operation: "select" | "insert" | "update",
    payload: Row | null,
    filters: Map<string, unknown>,
  ) {
    const store = table === "tracking_sessions"
      ? this.sessions
      : table === "tracking_journeys"
        ? this.journeys
        : table === "tracking_events"
          ? this.events
          : null;
    if (!store) return { data: null, error: null };
    const matches = (candidate: Row) => [...filters].every(([column, value]) => {
      if (column.startsWith("__lte__")) {
        const candidateValue = candidate[column.slice("__lte__".length)];
        return typeof candidateValue === "string"
          && typeof value === "string"
          && candidateValue <= value;
      }
      return candidate[column] === value;
    });

    if (operation === "select") {
      const row = [...store.values()].find(matches);
      return { data: row ?? null, error: null };
    }

    if (operation === "update") {
      if (
        table === "tracking_sessions"
        && payload
        && typeof payload.last_seen_at === "string"
        && this.beforeNextSessionTimestampUpdate
      ) {
        const callback = this.beforeNextSessionTimestampUpdate;
        this.beforeNextSessionTimestampUpdate = null;
        callback();
      }
      for (const [id, row] of store) {
        if (matches(row)) {
          store.set(id, { ...row, ...payload });
        }
      }
      return { data: null, error: null };
    }

    const row = { ...payload } as Row;
    if (table === "tracking_journeys" && row.status === undefined) {
      row.status = "active";
    }
    const key = table === "tracking_events"
      ? String(row.event_id)
      : String(row.id);
    if (store.has(key)) {
      return {
        data: null,
        error: { code: "23505", message: "duplicate key" },
      };
    }
    if (table === "tracking_events") {
      row.id = `tracking-row-${this.trackingEventInsertCount + 1}`;
      row.created_at = "2026-08-20T12:00:00.000Z";
      this.trackingEventInsertCount += 1;
      // The real database trigger runs only for a successful INSERT. This
      // counter makes duplicate/replay expectations explicit without changing
      // the trigger or Meta queue implementation.
      this.metaTriggerCount += 1;
      if (this.forceDuplicateOnNextTrackingInsert) {
        this.forceDuplicateOnNextTrackingInsert = false;
        store.set(key, row);
        return {
          data: null,
          error: { code: "23505", message: "duplicate key" },
        };
      }
    }
    store.set(key, row);
    return { data: row, error: null };
  }
}

const mocks = vi.hoisted(() => ({
  database: null as FakeTrackingDatabase | null,
}));

vi.mock("../_shared/internal-auth.ts", () => ({
  createSupabaseAdminClient: () => mocks.database,
  getClientIpAddress: () => null,
}));

import { handlePublicTrackingRequest } from "./index.ts";

function trackingRequest(overrides: Record<string, unknown> = {}) {
  return new Request("https://edge.test/public-tracking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_name: "page_view",
      event_id: "event-1",
      company_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      anonymous_id: "anonymous-1",
      session_id: "10000000-0000-4000-8000-000000000001",
      journey_id: null,
      step: "page_view",
      page_url: "https://example.com/book?utm_medium=paid",
      path: "/book?utm_medium=paid",
      event_source_url: "https://example.com/book?utm_medium=paid",
      utm_source: "instagram",
      utm_medium: "paid",
      utm_campaign: "original-campaign",
      pr_ad: "original-marker",
      occurred_at: "2026-08-20T11:59:00.000Z",
      ...overrides,
    }),
  });
}

describe("public-tracking handler idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    mocks.database = new FakeTrackingDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays a response-lost event with its original context and attribution", async () => {
    const firstResponse = await handlePublicTrackingRequest(trackingRequest());
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();

    const replayResponse = await handlePublicTrackingRequest(trackingRequest({
      page_url: "https://example.com/changed?utm_medium=organic",
      path: "/changed?utm_medium=organic",
      event_source_url: "https://example.com/changed?utm_medium=organic",
      utm_source: "direct",
      utm_medium: "organic",
      utm_campaign: "changed-campaign",
      pr_ad: null,
    }));
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json();

    expect(replay).toEqual(first);
    expect(mocks.database!.sessions.size).toBe(1);
    expect(mocks.database!.trackingEventInsertCount).toBe(1);
    expect(mocks.database!.metaTriggerCount).toBe(1);
    expect(mocks.database!.adsCalls).toHaveLength(2);
    expect(mocks.database!.adsCalls[1]).toMatchObject({
      _session_id: first.session_id,
      _utm_source: "instagram",
      _utm_medium: "paid",
      _utm_campaign: "original-campaign",
      _pr_ad: "original-marker",
      _event_id: "event-1",
    });
  });

  it("rejects the same event_id in another logical context before creating state", async () => {
    expect((await handlePublicTrackingRequest(trackingRequest())).status).toBe(200);
    const collision = await handlePublicTrackingRequest(trackingRequest({
      anonymous_id: "anonymous-other",
    }));

    expect(collision.status).toBe(409);
    expect(mocks.database!.sessions.size).toBe(1);
    expect(mocks.database!.trackingEventInsertCount).toBe(1);
    expect(mocks.database!.metaTriggerCount).toBe(1);
  });

  it("recovers the winner context from a duplicate-23505 race without a second Meta effect", async () => {
    mocks.database!.forceDuplicateOnNextTrackingInsert = true;
    const requestedJourneyId = "20000000-0000-4000-8000-000000000001";
    const response = await handlePublicTrackingRequest(trackingRequest({
      event_name: "booking_started",
      step: null,
      journey_id: requestedJourneyId,
    }));
    expect(response.status).toBe(200);
    const result = await response.json();

    expect(result).toMatchObject({
      session_id: "10000000-0000-4000-8000-000000000001",
      journey_id: requestedJourneyId,
    });
    expect(mocks.database!.sessions.size).toBe(1);
    expect(mocks.database!.journeys.size).toBe(1);
    expect(mocks.database!.events.size).toBe(1);
    expect(mocks.database!.trackingEventInsertCount).toBe(1);
    expect(mocks.database!.metaTriggerCount).toBe(1);
    expect(mocks.database!.adsCalls).toHaveLength(1);
    expect(mocks.database!.adsCalls[0]).toMatchObject({
      _session_id: result.session_id,
      _journey_id: result.journey_id,
      _event_id: "event-1",
    });
  });

  it("replays the deterministic context after expired session and inactive journey rotation", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    const requestedJourneyId = "20000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      last_seen_at: "2020-01-01T00:00:00.000Z",
    });
    mocks.database!.journeys.set(requestedJourneyId, {
      id: requestedJourneyId,
      company_id: companyId,
      session_id: requestedSessionId,
      anonymous_id: "anonymous-1",
      reservation_id: null,
      status: "converted",
    });

    const requestOverrides = {
      event_name: "booking_started",
      step: null,
      session_id: requestedSessionId,
      journey_id: requestedJourneyId,
    };
    const firstResponse = await handlePublicTrackingRequest(trackingRequest(requestOverrides));
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.session_id).not.toBe(requestedSessionId);
    expect(first.journey_id).not.toBe(requestedJourneyId);

    const replayResponse = await handlePublicTrackingRequest(trackingRequest(requestOverrides));
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(first);
    expect(mocks.database!.trackingEventInsertCount).toBe(1);
    expect(mocks.database!.metaTriggerCount).toBe(1);
    expect(mocks.database!.sessions.size).toBe(2);
    expect(mocks.database!.journeys.size).toBe(2);
  });

  it("converges distinct events from the same expired session on one rotation", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T09:00:00.000Z",
      last_seen_at: "2026-08-20T09:05:00.000Z",
    });

    const first = await (await handlePublicTrackingRequest(trackingRequest({
      event_id: "event-expired-a",
      session_id: requestedSessionId,
      occurred_at: "2026-08-20T12:00:00.000Z",
    }))).json();
    const second = await (await handlePublicTrackingRequest(trackingRequest({
      event_id: "event-expired-b",
      session_id: requestedSessionId,
      occurred_at: "2026-08-20T12:00:00.000Z",
    }))).json();

    expect(first.session_id).not.toBe(requestedSessionId);
    expect(second.session_id).toBe(first.session_id);
    expect(mocks.database!.sessions.size).toBe(2);
    expect(mocks.database!.events.size).toBe(2);
    expect(mocks.database!.metaTriggerCount).toBe(2);
  });

  it("converges distinct booking events from one inactive journey on one rotation", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    const requestedJourneyId = "20000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T11:00:00.000Z",
      last_seen_at: "2026-08-20T11:55:00.000Z",
    });
    mocks.database!.journeys.set(requestedJourneyId, {
      id: requestedJourneyId,
      company_id: companyId,
      session_id: requestedSessionId,
      anonymous_id: "anonymous-1",
      reservation_id: null,
      status: "completed",
    });

    const first = await (await handlePublicTrackingRequest(trackingRequest({
      event_id: "booking-rotation-a",
      event_name: "booking_started",
      step: null,
      journey_id: requestedJourneyId,
    }))).json();
    const second = await (await handlePublicTrackingRequest(trackingRequest({
      event_id: "booking-rotation-b",
      event_name: "booking_started",
      step: null,
      journey_id: requestedJourneyId,
    }))).json();

    expect(first.journey_id).not.toBe(requestedJourneyId);
    expect(second.journey_id).toBe(first.journey_id);
    expect(mocks.database!.journeys.size).toBe(2);
    expect(mocks.database!.events.size).toBe(2);
  });

  it("keeps a delayed step in its completed journey and original session", async () => {
    vi.setSystemTime("2026-08-20T13:00:00.000Z");
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    const requestedJourneyId = "20000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T11:00:00.000Z",
      last_seen_at: "2026-08-20T11:10:00.000Z",
    });
    mocks.database!.journeys.set(requestedJourneyId, {
      id: requestedJourneyId,
      company_id: companyId,
      session_id: requestedSessionId,
      anonymous_id: "anonymous-1",
      reservation_id: null,
      status: "completed",
    });

    const response = await handlePublicTrackingRequest(trackingRequest({
      event_id: "delayed-date",
      event_name: "date_select",
      step: "date_select",
      session_id: requestedSessionId,
      journey_id: requestedJourneyId,
      occurred_at: "2026-08-20T11:20:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session_id: requestedSessionId,
      journey_id: requestedJourneyId,
    });
    expect(mocks.database!.sessions.get(requestedSessionId)?.last_seen_at)
      .toBe("2026-08-20T11:20:00.000Z");
    expect(mocks.database!.journeys.size).toBe(1);
    expect(mocks.database!.journeys.get(requestedJourneyId)?.status).toBe("completed");
    expect(mocks.database!.events.get("delayed-date")?.occurred_at)
      .toBe("2026-08-20T11:20:00.000Z");
  });

  it("does not regress an active journey timestamp when delayed steps arrive out of order", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    const requestedJourneyId = "20000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T11:00:00.000Z",
      last_seen_at: "2026-08-20T11:55:00.000Z",
    });
    mocks.database!.journeys.set(requestedJourneyId, {
      id: requestedJourneyId,
      company_id: companyId,
      session_id: requestedSessionId,
      anonymous_id: "anonymous-1",
      reservation_id: null,
      status: "active",
      last_event_at: "2026-08-20T11:30:00.000Z",
    });

    const response = await handlePublicTrackingRequest(trackingRequest({
      event_id: "out-of-order-date",
      event_name: "date_select",
      step: "date_select",
      journey_id: requestedJourneyId,
      occurred_at: "2026-08-20T11:20:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect(mocks.database!.journeys.get(requestedJourneyId)?.last_event_at)
      .toBe("2026-08-20T11:30:00.000Z");
  });

  it("does not regress a session timestamp when concurrent updates finish out of order", async () => {
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T11:00:00.000Z",
      last_seen_at: "2026-08-20T11:10:00.000Z",
    });
    mocks.database!.beforeNextSessionTimestampUpdate = () => {
      const current = mocks.database!.sessions.get(requestedSessionId)!;
      mocks.database!.sessions.set(requestedSessionId, {
        ...current,
        last_seen_at: "2026-08-20T11:30:00.000Z",
      });
    };

    const response = await handlePublicTrackingRequest(trackingRequest({
      event_id: "out-of-order-session",
      session_id: requestedSessionId,
      occurred_at: "2026-08-20T11:20:00.000Z",
    }));

    expect(response.status).toBe(200);
    expect(mocks.database!.sessions.get(requestedSessionId)?.last_seen_at)
      .toBe("2026-08-20T11:30:00.000Z");
  });

  it("rotates a genuinely current event after the requested session timed out", async () => {
    vi.setSystemTime("2026-08-20T13:00:00.000Z");
    const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestedSessionId = "10000000-0000-4000-8000-000000000001";
    mocks.database!.sessions.set(requestedSessionId, {
      id: requestedSessionId,
      company_id: companyId,
      anonymous_id: "anonymous-1",
      started_at: "2026-08-20T11:00:00.000Z",
      last_seen_at: "2026-08-20T11:10:00.000Z",
    });

    const response = await handlePublicTrackingRequest(trackingRequest({
      event_id: "current-after-timeout",
      session_id: requestedSessionId,
      occurred_at: "2026-08-20T13:00:00.000Z",
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).session_id).not.toBe(requestedSessionId);
    expect(mocks.database!.sessions.size).toBe(2);
  });
});
