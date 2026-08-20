import {
  createSupabaseAdminClient,
  getClientIpAddress,
} from "../_shared/internal-auth.ts";
import {
  buildAdsJourneyRpcArgs,
  recordAdsJourneyActivityBestEffort,
  resolvePrAd,
} from "./ads-journey.ts";
import {
  buildStoredAdsReplayInput,
  buildTrackingReplayResponse,
  deterministicTrackingUuid,
  validateTrackingEventReplay,
  type StoredTrackingEventContext,
  type TrackingReplayRequest,
} from "./idempotent-replay.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CLIENT_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface TrackingBody {
  event_name?: string;
  event_id?: string;
  company_id?: string;
  slug?: string;
  anonymous_id?: string;
  session_id?: string | null;
  journey_id?: string | null;
  reservation_id?: string | null;
  step?: string | null;
  page_url?: string | null;
  path?: string | null;
  referrer?: string | null;
  event_source_url?: string | null;
  occurred_at?: string | null;
  metadata?: Record<string, unknown> | null;
  fbp?: string | null;
  fbc?: string | null;
  fbclid?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  pr_ad?: string | null;
  user_data?: {
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
  } | null;
}

class TrackingContextCollisionError extends Error {
  readonly status = 409;
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown) {
  const text = asTrimmedString(value);
  return text.length > 0 ? text : null;
}

function asMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function deriveFbc(existingFbc: string | null, fbclid: string | null) {
  if (existingFbc) return existingFbc;
  if (!fbclid) return null;
  return `fb.1.${Date.now()}.${fbclid}`;
}

function resolveEffectiveOccurredAt(value: unknown, receivedAt: string) {
  const receivedTime = Date.parse(receivedAt);
  const occurredTime = Date.parse(nullableText(value) ?? "");
  if (!Number.isFinite(occurredTime)
    || occurredTime < receivedTime - MAX_CLIENT_EVENT_AGE_MS
    || occurredTime > receivedTime + MAX_CLIENT_CLOCK_SKEW_MS) {
    return receivedAt;
  }
  return new Date(occurredTime).toISOString();
}

function buildUserDataSnapshot(body: TrackingBody, anonymousId: string) {
  const userData = body.user_data ?? {};

  return {
    email: nullableText(userData.email),
    phone: nullableText(userData.phone)?.replace(/\D/g, "") || null,
    first_name: nullableText(userData.first_name),
    last_name: nullableText(userData.last_name),
    zip: nullableText(userData.zip),
    city: nullableText(userData.city),
    state: nullableText(userData.state),
    country: nullableText(userData.country),
    birthdate: nullableText(userData.birthdate),
    external_id: nullableText(userData.external_id) ?? anonymousId,
  };
}

const TRACKING_EVENT_CONTEXT_COLUMNS = [
  "company_id",
  "event_id",
  "event_name",
  "anonymous_id",
  "session_id",
  "journey_id",
  "reservation_id",
  "step",
  "page_url",
  "path",
  "referrer",
  "event_source_url",
  "metadata",
  "created_at",
].join(",");

async function findTrackingEventByEventId(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  eventId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("tracking_events")
    .select(TRACKING_EVENT_CONTEXT_COLUMNS)
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as StoredTrackingEventContext | null;
}

function replayRequestContext(
  body: TrackingBody,
  context: {
    companyId: string;
    eventId: string;
    eventName: string;
    anonymousId: string;
    requestedSessionId: string | null;
    requestedJourneyId: string | null;
    reservationId: string | null;
  },
): TrackingReplayRequest {
  return {
    ...context,
    step: nullableText(body.step),
  };
}

function assertReplayContext(
  request: TrackingReplayRequest,
  stored: StoredTrackingEventContext,
) {
  const mismatch = validateTrackingEventReplay(request, stored);
  if (mismatch) {
    throw new TrackingContextCollisionError(
      `event_id ja pertence a outro contexto de tracking (${mismatch})`,
    );
  }
}

async function resolveCompanyId(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  body: TrackingBody,
) {
  const directCompanyId = nullableText(body.company_id);
  if (directCompanyId) {
    return directCompanyId;
  }

  const slug = nullableText(body.slug);
  if (!slug) {
    throw new Error("company_id ou slug sao obrigatorios");
  }

  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data?.id) {
    throw new Error("Empresa nao encontrada");
  }

  return data.id as string;
}

async function findSessionById(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  sessionId: string | null,
) {
  if (!sessionId) return null;

  const { data, error } = await supabaseAdmin
    .from("tracking_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as Record<string, unknown> | null;
}

function belongsToTrackingVisitor(
  session: Record<string, unknown> | null,
  companyId: string,
  anonymousId: string,
) {
  return !!session
    && session.company_id === companyId
    && session.anonymous_id === anonymousId;
}

function canReuseSession(
  session: Record<string, unknown> | null,
  companyId: string,
  anonymousId: string,
  eventName: string,
  effectiveOccurredAt: string,
  receivedAt: string,
) {
  if (!belongsToTrackingVisitor(session, companyId, anonymousId)) return false;

  const lastSeenAt = session.last_seen_at ? Date.parse(String(session.last_seen_at)) : NaN;
  const receivedTime = Date.parse(receivedAt);
  if (!Number.isFinite(lastSeenAt) || !Number.isFinite(receivedTime)) return false;

  // Normal online traffic keeps the original 30-minute inactivity contract.
  if (receivedTime - lastSeenAt <= SESSION_TIMEOUT_MS) return true;

  // A durable event can arrive much later than it happened. Its bounded
  // occurred_at recovers the original context and is also eligible for the
  // funnel report's guarded effective_at calculation. The projection cursor
  // remains authoritative on tracking_events.created_at.
  if (eventName === "session_ping") return false;
  const startedAt = session.started_at ? Date.parse(String(session.started_at)) : NaN;
  const occurredAt = Date.parse(effectiveOccurredAt);
  return Number.isFinite(startedAt)
    && Number.isFinite(occurredAt)
    && occurredAt >= startedAt
    && occurredAt <= lastSeenAt + SESSION_TIMEOUT_MS;
}

function nextSessionLastSeenAt(
  session: Record<string, unknown>,
  eventName: string,
  effectiveOccurredAt: string,
  receivedAt: string,
) {
  if (eventName === "session_ping") return receivedAt;
  const previous = Date.parse(String(session.last_seen_at ?? ""));
  const occurred = Date.parse(effectiveOccurredAt);
  if (!Number.isFinite(previous) || !Number.isFinite(occurred)) return receivedAt;
  return new Date(Math.max(previous, occurred)).toISOString();
}

async function findValidSession(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
  anonymousId: string,
  sessionId: string | null,
  eventName: string,
  effectiveOccurredAt: string,
  receivedAt: string,
) {
  const session = await findSessionById(supabaseAdmin, sessionId);
  if (!canReuseSession(
    session,
    companyId,
    anonymousId,
    eventName,
    effectiveOccurredAt,
    receivedAt,
  )) return null;

  return session;
}

function buildSessionPatch(
  body: TrackingBody,
  ipAddress: string | null,
  userAgent: string | null,
  acceptLanguage: string | null,
  lastSeenAt: string,
) {
  return {
    last_page_url: nullableText(body.page_url),
    referrer: nullableText(body.referrer),
    utm_source: nullableText(body.utm_source),
    utm_medium: nullableText(body.utm_medium),
    utm_campaign: nullableText(body.utm_campaign),
    utm_content: nullableText(body.utm_content),
    utm_term: nullableText(body.utm_term),
    pr_ad: resolvePrAd(body),
    fbclid: nullableText(body.fbclid),
    fbp: nullableText(body.fbp),
    fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
    ip_address: ipAddress,
    user_agent: userAgent,
    accept_language: acceptLanguage,
    last_seen_at: lastSeenAt,
  };
}

function mergeAttributionSnapshot(
  body: TrackingBody,
  anonymousId: string,
  sessionId: string,
  journeyId: string | null,
  session: Record<string, unknown> | null,
) {
  const getSessionText = (key: string) => nullableText(session?.[key]);

  return {
    tracking_source: "public_web",
    anonymous_id: anonymousId,
    session_id: sessionId,
    journey_id: journeyId,
    page_url: nullableText(body.page_url),
    path: nullableText(body.path),
    referrer: nullableText(body.referrer) ?? getSessionText("referrer"),
    event_source_url: nullableText(body.event_source_url) ?? nullableText(body.page_url),
    utm_source: nullableText(body.utm_source) ?? getSessionText("utm_source"),
    utm_medium: nullableText(body.utm_medium) ?? getSessionText("utm_medium"),
    utm_campaign: nullableText(body.utm_campaign) ?? getSessionText("utm_campaign"),
    utm_content: nullableText(body.utm_content) ?? getSessionText("utm_content"),
    utm_term: nullableText(body.utm_term) ?? getSessionText("utm_term"),
    pr_ad: resolvePrAd(body) ?? getSessionText("pr_ad"),
    fbclid: nullableText(body.fbclid) ?? getSessionText("fbclid"),
    fbp: nullableText(body.fbp) ?? getSessionText("fbp"),
    fbc: deriveFbc(nullableText(body.fbc) ?? getSessionText("fbc"), nullableText(body.fbclid) ?? getSessionText("fbclid")),
    user_data: buildUserDataSnapshot(body, anonymousId),
  };
}

export async function handlePublicTrackingRequest(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as TrackingBody;
    const eventName = nullableText(body.event_name) ?? "session_ping";
    const anonymousId = nullableText(body.anonymous_id) ?? crypto.randomUUID();
    const requestedSessionId = nullableText(body.session_id);
    const requestedJourneyId = nullableText(body.journey_id);
    const reservationId = nullableText(body.reservation_id);
    const eventId = nullableText(body.event_id) ?? crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const effectiveOccurredAt = resolveEffectiveOccurredAt(body.occurred_at, receivedAt);
    const supabaseAdmin = createSupabaseAdminClient();
    const companyId = await resolveCompanyId(supabaseAdmin, body);
    const replayRequest = replayRequestContext(body, {
      companyId,
      eventId,
      eventName,
      anonymousId,
      requestedSessionId,
      requestedJourneyId,
      reservationId,
    });

    // Idempotency is checked before touching sessions, journeys or reservations.
    // session_ping deliberately remains ephemeral. Its client-supplied session
    // UUID makes a response-lost retry idempotent without adding raw tracking
    // rows or touching the Meta queue.
    if (eventName !== "session_ping") {
      const replayedEvent = await findTrackingEventByEventId(supabaseAdmin, eventId);
      if (replayedEvent) {
        assertReplayContext(replayRequest, replayedEvent);
        const replayResponse = buildTrackingReplayResponse(replayedEvent);
        const adsJourneyRecorded = await recordAdsJourneyActivityBestEffort(
          supabaseAdmin,
          buildAdsJourneyRpcArgs(buildStoredAdsReplayInput(replayedEvent), {
            companyId: replayResponse.company_id,
            anonymousId: replayResponse.anonymous_id,
            sessionId: replayResponse.session_id,
            journeyId: replayResponse.journey_id,
            reservationId: replayedEvent.reservation_id,
            eventName: replayedEvent.event_name,
            eventId: replayedEvent.event_id,
            receivedAt: replayedEvent.created_at,
          }),
        );

        if (!adsJourneyRecorded) {
          throw new Error("Falha temporaria ao registrar a jornada de Ads");
        }

        return new Response(JSON.stringify(replayResponse), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const ipAddress = getClientIpAddress(req);
    const userAgent = nullableText(req.headers.get("user-agent"));
    const acceptLanguage = nullableText(req.headers.get("accept-language"));
    let session = await findValidSession(
      supabaseAdmin,
      companyId,
      anonymousId,
      requestedSessionId,
      eventName,
      effectiveOccurredAt,
      receivedAt,
    );
    const sessionPatch = buildSessionPatch(
      body,
      ipAddress,
      userAgent,
      acceptLanguage,
      session
        ? nextSessionLastSeenAt(session, eventName, effectiveOccurredAt, receivedAt)
        : receivedAt,
    );

    if (!session) {
      const preferredSessionId = requestedSessionId
        ?? await deterministicTrackingUuid(eventId, "session");
      const sessionInsert = {
        id: preferredSessionId,
        company_id: companyId,
        anonymous_id: anonymousId,
        first_page_url: nullableText(body.page_url),
        last_page_url: nullableText(body.page_url),
        landing_path: nullableText(body.path),
        referrer: nullableText(body.referrer),
        utm_source: nullableText(body.utm_source),
        utm_medium: nullableText(body.utm_medium),
        utm_campaign: nullableText(body.utm_campaign),
        utm_content: nullableText(body.utm_content),
        utm_term: nullableText(body.utm_term),
        pr_ad: resolvePrAd(body),
        fbclid: nullableText(body.fbclid),
        fbp: nullableText(body.fbp),
        fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
        ip_address: ipAddress,
        user_agent: userAgent,
        accept_language: acceptLanguage,
        started_at: receivedAt,
        last_seen_at: receivedAt,
      };
      let { data, error } = await supabaseAdmin
        .from("tracking_sessions")
        .insert(sessionInsert)
        .select("*")
        .single();

      if (error) {
        const isDuplicate = error.code === "23505"
          || error.message.includes("duplicate key");
        if (!isDuplicate) throw new Error(error.message);

        // Two identical pings may race after both miss the lookup. The UUID
        // supplied by the browser makes the winner reusable by the loser.
        const concurrentSession = await findSessionById(supabaseAdmin, preferredSessionId);
        if (canReuseSession(
          concurrentSession,
          companyId,
          anonymousId,
          eventName,
          effectiveOccurredAt,
          receivedAt,
        )) {
          session = concurrentSession;
        } else if (concurrentSession
          && concurrentSession.company_id === companyId
          && concurrentSession.anonymous_id === anonymousId) {
          // A genuinely expired session is rotated; it is not an idempotent
          // replay and must not be revived merely because its UUID still exists.
          const rotatedSessionId = await deterministicTrackingUuid(
            requestedSessionId ?? eventId,
            "session-rotation",
          );
          const rotatedSessionInsert = { ...sessionInsert, id: rotatedSessionId };
          ({ data, error } = await supabaseAdmin
            .from("tracking_sessions")
            .insert(rotatedSessionInsert)
            .select("*")
            .single());
          if (error) {
            const rotationDuplicate = error.code === "23505"
              || error.message.includes("duplicate key");
            if (!rotationDuplicate) throw new Error(error.message);
            const concurrentRotation = await findSessionById(supabaseAdmin, rotatedSessionId);
            if (!concurrentRotation
              || concurrentRotation.company_id !== companyId
              || concurrentRotation.anonymous_id !== anonymousId) {
              throw new TrackingContextCollisionError(
                "session_id rotacionado pertence a outro contexto de tracking",
              );
            }
            session = concurrentRotation;
          } else {
            session = data as Record<string, unknown>;
          }
        } else {
          throw new TrackingContextCollisionError(
            "session_id ja pertence a outro contexto de tracking",
          );
        }
      }

      if (!session) session = data as Record<string, unknown>;
    } else {
      const patch = {
        ...Object.fromEntries(
          Object.entries(sessionPatch).filter(([, value]) => value !== null),
        ),
      };

      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin
          .from("tracking_sessions")
          .update(patch)
          .eq("id", session.id as string)
          .lte("last_seen_at", sessionPatch.last_seen_at);

        if (error) {
          throw new Error(error.message);
        }
      }
    }

    const sessionId = session.id as string;
    let journeyId = requestedJourneyId;

    if (journeyId) {
      const { data: existingJourney, error: journeyLookupError } = await supabaseAdmin
        .from("tracking_journeys")
        .select("id, company_id, session_id, anonymous_id, reservation_id, status, last_event_at")
        .eq("id", journeyId)
        .maybeSingle();

      if (journeyLookupError) {
        throw new Error(journeyLookupError.message);
      }

      const ownerMatches = !existingJourney || (
        existingJourney.company_id === companyId
        && existingJourney.anonymous_id === anonymousId
      );
      const reservationMatches = !existingJourney
        || !existingJourney.reservation_id
        || !reservationId
        || existingJourney.reservation_id === reservationId;
      if (!ownerMatches || !reservationMatches) {
        throw new TrackingContextCollisionError(
          "journey_id já pertence a outro contexto de tracking",
        );
      }

      const shouldRotateJourney = !existingJourney
        || (eventName === "booking_started" && existingJourney.status !== "active");

      if (shouldRotateJourney) {
        // A new journey keeps the browser UUID. It is therefore stable across
        // retries even if the first response is lost. Existing but invalid
        // journeys rotate because their primary key cannot be reused.
        const isNewRequestedJourney = !existingJourney;
        journeyId = isNewRequestedJourney
          ? journeyId
          : await deterministicTrackingUuid(
            `${requestedJourneyId}:${reservationId ?? ""}`,
            "journey",
          );

        const { error: journeyInsertError } = await supabaseAdmin
          .from("tracking_journeys")
          .insert({
            id: journeyId,
            company_id: companyId,
            session_id: sessionId,
            anonymous_id: anonymousId,
            reservation_id: reservationId,
            metadata: {
              started_from_path: nullableText(body.path),
            },
          });

        if (journeyInsertError) {
          const isDuplicate = journeyInsertError.code === "23505"
            || journeyInsertError.message.includes("duplicate key");
          if (!isDuplicate) throw new Error(journeyInsertError.message);

          const { data: concurrentJourney, error: concurrentJourneyError } = await supabaseAdmin
            .from("tracking_journeys")
            .select("id, company_id, session_id, anonymous_id, reservation_id, status, last_event_at")
            .eq("id", journeyId)
            .maybeSingle();
          if (concurrentJourneyError) throw new Error(concurrentJourneyError.message);

          const sameContext = concurrentJourney
            && concurrentJourney.company_id === companyId
            && concurrentJourney.anonymous_id === anonymousId
            && concurrentJourney.session_id === sessionId
            && concurrentJourney.status === "active"
            && (
              !concurrentJourney.reservation_id
              || concurrentJourney.reservation_id === reservationId
            );
          if (!sameContext) {
            throw new TrackingContextCollisionError(
              "journey_id ja pertence a outro contexto de tracking",
            );
          }
        }
      } else if (existingJourney.status === "active") {
        const patch = {
          session_id: sessionId,
          reservation_id: reservationId ?? existingJourney.reservation_id,
        };

        const { error: journeyUpdateError } = await supabaseAdmin
          .from("tracking_journeys")
          .update(patch)
          .eq("id", journeyId);

        if (journeyUpdateError) {
          throw new Error(journeyUpdateError.message);
        }

        // The predicate makes the timestamp monotonic even when two delayed
        // events are processed concurrently and complete out of order.
        const { error: journeyTimestampError } = await supabaseAdmin
          .from("tracking_journeys")
          .update({ last_event_at: effectiveOccurredAt })
          .eq("id", journeyId)
          .lte("last_event_at", effectiveOccurredAt);

        if (journeyTimestampError) {
          throw new Error(journeyTimestampError.message);
        }
      }
    }

    if (reservationId) {
      const attributionSnapshot = mergeAttributionSnapshot(body, anonymousId, sessionId, journeyId, session);
      const { error: reservationUpdateError } = await supabaseAdmin
        .from("reservations")
        .update({
          origin_tracking_session_id: sessionId,
          origin_tracking_journey_id: journeyId,
          origin_anonymous_id: anonymousId,
          origin_fbp: attributionSnapshot.fbp,
          origin_fbc: attributionSnapshot.fbc,
          attribution_snapshot: attributionSnapshot,
        })
        .eq("id", reservationId)
        .eq("company_id", companyId);

      if (reservationUpdateError) {
        throw new Error(reservationUpdateError.message);
      }
    }

    let adsJourneyActivityAt = receivedAt;
    let requireAdsJourneyWrite = false;
    let effectiveSessionId = sessionId;
    let effectiveJourneyId = journeyId;
    let effectiveReservationId = reservationId;
    let adsJourneyInput: TrackingBody = body;

    if (eventName !== "session_ping") {
      const eventSourceUrl = nullableText(body.event_source_url) ?? nullableText(body.page_url);
      const { data: insertedEvent, error: eventInsertError } = await supabaseAdmin
        .from("tracking_events")
        .insert({
          company_id: companyId,
          session_id: sessionId,
          journey_id: journeyId,
          reservation_id: reservationId,
          anonymous_id: anonymousId,
          event_id: eventId,
          event_name: eventName,
          tracking_source: "public",
          step: nullableText(body.step),
          page_url: nullableText(body.page_url),
          path: nullableText(body.path),
          referrer: nullableText(body.referrer),
          event_source_url: eventSourceUrl,
          occurred_at: effectiveOccurredAt,
          metadata: {
            ...asMetadata(body.metadata),
            tracking_source: "public_web",
            fbp: nullableText(body.fbp),
            fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
            fbclid: nullableText(body.fbclid),
            utm_source: nullableText(body.utm_source)
              ?? nullableText(session.utm_source),
            utm_medium: nullableText(body.utm_medium)
              ?? nullableText(session.utm_medium),
            utm_campaign: nullableText(body.utm_campaign)
              ?? nullableText(session.utm_campaign),
            utm_content: nullableText(body.utm_content)
              ?? nullableText(session.utm_content),
            utm_term: nullableText(body.utm_term)
              ?? nullableText(session.utm_term),
            pr_ad: resolvePrAd(body) ?? nullableText(session.pr_ad),
            tracking_requested_session_id: requestedSessionId,
            tracking_requested_journey_id: requestedJourneyId,
          },
          user_data_snapshot: buildUserDataSnapshot(body, anonymousId),
        })
        .select(TRACKING_EVENT_CONTEXT_COLUMNS)
        .single();

      if (eventInsertError) {
        const isDuplicate = eventInsertError.code === "23505"
          || eventInsertError.message.includes("duplicate key");

        if (!isDuplicate) {
          throw new Error(eventInsertError.message);
        }

        const existingEvent = await findTrackingEventByEventId(supabaseAdmin, eventId);
        if (!existingEvent) throw new Error("Evento duplicado sem contexto persistido");
        assertReplayContext(replayRequest, existingEvent);
        const replayResponse = buildTrackingReplayResponse(existingEvent);
        effectiveSessionId = replayResponse.session_id;
        effectiveJourneyId = replayResponse.journey_id;
        effectiveReservationId = existingEvent.reservation_id;
        adsJourneyActivityAt = existingEvent.created_at;
        adsJourneyInput = buildStoredAdsReplayInput(existingEvent);
      } else if (insertedEvent?.created_at) {
        adsJourneyActivityAt = insertedEvent.created_at as string;
      }

      // If the V2 write fails, the browser keeps this event in its existing
      // retry queue. The tracking_events row supplies a stable server time on
      // replay, so retries cannot keep extending the attribution window.
      requireAdsJourneyWrite = true;
    }

    const adsJourneyRecorded = await recordAdsJourneyActivityBestEffort(
      supabaseAdmin,
      buildAdsJourneyRpcArgs(adsJourneyInput, {
        companyId,
        anonymousId,
        sessionId: effectiveSessionId,
        journeyId: effectiveJourneyId,
        reservationId: effectiveReservationId,
        eventName,
        eventId,
        receivedAt: adsJourneyActivityAt,
      }),
    );

    if (requireAdsJourneyWrite && !adsJourneyRecorded) {
      throw new Error("Falha temporaria ao registrar a jornada de Ads");
    }

    return new Response(JSON.stringify({
      ok: true,
      company_id: companyId,
      anonymous_id: anonymousId,
      session_id: effectiveSessionId,
      journey_id: effectiveJourneyId,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Erro interno" }), {
      status: error instanceof TrackingContextCollisionError ? error.status : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

if (typeof Deno !== "undefined") {
  Deno.serve(handlePublicTrackingRequest);
}
