export interface TrackingReplayRequest {
  companyId: string;
  eventId: string;
  eventName: string;
  anonymousId: string;
  requestedSessionId: string | null;
  requestedJourneyId: string | null;
  reservationId: string | null;
  step: string | null;
}

export interface StoredTrackingEventContext {
  company_id: string;
  event_id: string;
  event_name: string;
  anonymous_id: string;
  session_id: string | null;
  journey_id: string | null;
  reservation_id: string | null;
  step: string | null;
  page_url: string | null;
  path: string | null;
  referrer: string | null;
  event_source_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface TrackingReplayResponse {
  ok: true;
  company_id: string;
  anonymous_id: string;
  session_id: string;
  journey_id: string | null;
}

function sameNullable(left: string | null, right: string | null) {
  return left === right;
}

function nullableStoredText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Validates that an event_id replay belongs to the original logical event.
 * Server-created session context is allowed when the original request supplied
 * null (notably session_ping), but a supplied client context may never point to
 * another stored session/journey.
 */
export function validateTrackingEventReplay(
  request: TrackingReplayRequest,
  stored: StoredTrackingEventContext,
): string | null {
  if (stored.company_id !== request.companyId) return "company_mismatch";
  if (stored.event_id !== request.eventId) return "event_id_mismatch";
  if (stored.event_name !== request.eventName) return "event_name_mismatch";
  if (stored.anonymous_id !== request.anonymousId) return "anonymous_id_mismatch";
  const metadata = stored.metadata ?? {};
  const expectedRequestedSessionId = nullableStoredText(
    metadata.tracking_requested_session_id,
  );
  const expectedRequestedJourneyId = nullableStoredText(
    metadata.tracking_requested_journey_id,
  );
  if (
    hasOwn(metadata, "tracking_requested_session_id")
    && !sameNullable(expectedRequestedSessionId, request.requestedSessionId)
  ) {
    return "session_id_mismatch";
  }
  if (
    hasOwn(metadata, "tracking_requested_journey_id")
    && !sameNullable(expectedRequestedJourneyId, request.requestedJourneyId)
  ) {
    return "journey_id_mismatch";
  }
  if (!sameNullable(stored.reservation_id, request.reservationId)) {
    return "reservation_id_mismatch";
  }
  if (!sameNullable(stored.step, request.step)) return "step_mismatch";
  if (!stored.session_id) return "missing_session_context";
  if (!stored.created_at) return "missing_created_at";
  return null;
}

export function buildStoredAdsReplayInput(stored: StoredTrackingEventContext) {
  const metadata = stored.metadata ?? {};
  return {
    event_name: stored.event_name,
    event_id: stored.event_id,
    page_url: stored.page_url,
    path: stored.path,
    referrer: stored.referrer,
    event_source_url: stored.event_source_url,
    utm_source: nullableStoredText(metadata.utm_source),
    utm_medium: nullableStoredText(metadata.utm_medium),
    utm_campaign: nullableStoredText(metadata.utm_campaign),
    pr_ad: nullableStoredText(metadata.pr_ad),
  };
}

export async function deterministicTrackingUuid(
  eventId: string,
  kind: "session" | "session-rotation" | "journey",
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`public-tracking:${kind}:${eventId}`),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function buildTrackingReplayResponse(
  stored: StoredTrackingEventContext,
): TrackingReplayResponse {
  if (!stored.session_id) {
    throw new Error("Evento de tracking sem contexto de sessao");
  }
  return {
    ok: true,
    company_id: stored.company_id,
    anonymous_id: stored.anonymous_id,
    session_id: stored.session_id,
    journey_id: stored.journey_id,
  };
}
