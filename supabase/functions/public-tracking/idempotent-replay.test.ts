import { describe, expect, it } from "vitest";
import {
  buildStoredAdsReplayInput,
  buildTrackingReplayResponse,
  deterministicTrackingUuid,
  validateTrackingEventReplay,
  type StoredTrackingEventContext,
  type TrackingReplayRequest,
} from "./idempotent-replay.ts";

const stored = {
  company_id: "company-a",
  event_id: "event-1",
  event_name: "page_view",
  anonymous_id: "anonymous-1",
  session_id: "session-original",
  journey_id: null,
  reservation_id: null,
  step: "page_view",
  page_url: "https://example.com/book?utm_medium=paid",
  path: "/book?utm_medium=paid",
  referrer: "https://instagram.com/",
  event_source_url: "https://example.com/book?utm_medium=paid",
  metadata: {
    tracking_requested_session_id: "session-original",
    tracking_requested_journey_id: null,
    utm_source: "instagram",
    utm_medium: "paid",
    utm_campaign: "original-campaign",
    pr_ad: "original-marker",
  },
  created_at: "2026-08-20T12:00:00.000Z",
} satisfies StoredTrackingEventContext;

const request = {
  companyId: "company-a",
  eventId: "event-1",
  eventName: "page_view",
  anonymousId: "anonymous-1",
  requestedSessionId: "session-original",
  requestedJourneyId: null,
  reservationId: null,
  step: "page_view",
} satisfies TrackingReplayRequest;

describe("public-tracking idempotent replay", () => {
  it("returns the original server context after a lost response", () => {
    expect(validateTrackingEventReplay(request, stored)).toBeNull();
    expect(buildTrackingReplayResponse(stored)).toEqual({
      ok: true,
      company_id: "company-a",
      anonymous_id: "anonymous-1",
      session_id: "session-original",
      journey_id: null,
    });
  });

  it("validates the originally requested context while returning rotated server IDs", () => {
    expect(validateTrackingEventReplay({
      ...request,
      requestedSessionId: "session-other",
    }, stored)).toBe("session_id_mismatch");

    const rotatedStored = {
      ...stored,
      session_id: "session-rotated-by-server",
    };
    expect(validateTrackingEventReplay(request, rotatedStored)).toBeNull();
    expect(buildTrackingReplayResponse(rotatedStored).session_id)
      .toBe("session-rotated-by-server");
  });

  it("rejects event_id reuse across event, visitor, company, journey or reservation contexts", () => {
    const journeyStored = {
      ...stored,
      event_name: "time_select",
      step: "time_select",
      journey_id: "journey-original",
      reservation_id: "reservation-original",
      metadata: {
        ...stored.metadata,
        tracking_requested_journey_id: "journey-original",
      },
    };
    const journeyRequest = {
      ...request,
      eventName: "time_select",
      step: "time_select",
      requestedJourneyId: "journey-original",
      reservationId: "reservation-original",
    };

    expect(validateTrackingEventReplay({
      ...journeyRequest,
      companyId: "company-other",
    }, journeyStored)).toBe("company_mismatch");
    expect(validateTrackingEventReplay({
      ...journeyRequest,
      eventName: "lead_captured",
    }, journeyStored)).toBe("event_name_mismatch");
    expect(validateTrackingEventReplay({
      ...journeyRequest,
      anonymousId: "anonymous-other",
    }, journeyStored)).toBe("anonymous_id_mismatch");
    expect(validateTrackingEventReplay({
      ...journeyRequest,
      requestedJourneyId: "journey-other",
    }, journeyStored)).toBe("journey_id_mismatch");
    expect(validateTrackingEventReplay({
      ...journeyRequest,
      reservationId: "reservation-other",
    }, journeyStored)).toBe("reservation_id_mismatch");
  });

  it("rebuilds Ads repair input from the stored event, not a mutable replay body", () => {
    expect(buildStoredAdsReplayInput(stored)).toEqual({
      event_name: "page_view",
      event_id: "event-1",
      page_url: "https://example.com/book?utm_medium=paid",
      path: "/book?utm_medium=paid",
      referrer: "https://instagram.com/",
      event_source_url: "https://example.com/book?utm_medium=paid",
      utm_source: "instagram",
      utm_medium: "paid",
      utm_campaign: "original-campaign",
      pr_ad: "original-marker",
    });
  });

  it("derives stable, distinct UUIDs for concurrent rotations", async () => {
    const firstSession = await deterministicTrackingUuid("event-1", "session");
    const replayedSession = await deterministicTrackingUuid("event-1", "session");
    const journey = await deterministicTrackingUuid("event-1", "journey");

    expect(firstSession).toBe(replayedSession);
    expect(firstSession).not.toBe(journey);
    expect(firstSession).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
