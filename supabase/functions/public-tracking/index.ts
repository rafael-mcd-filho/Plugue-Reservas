import {
  createSupabaseAdminClient,
  getClientIpAddress,
} from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

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
  user_data?: {
    email?: string | null;
    phone?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    zip?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    external_id?: string | null;
  } | null;
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
  return `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}`;
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
    external_id: nullableText(userData.external_id) ?? anonymousId,
  };
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

async function findValidSession(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
  anonymousId: string,
  sessionId: string | null,
) {
  if (!sessionId) return null;

  const { data, error } = await supabaseAdmin
    .from("tracking_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data || data.anonymous_id !== anonymousId) {
    return null;
  }

  const lastSeenAt = data.last_seen_at ? Date.parse(data.last_seen_at) : NaN;
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > SESSION_TIMEOUT_MS) {
    return null;
  }

  return data as Record<string, unknown>;
}

function buildSessionPatch(
  body: TrackingBody,
  ipAddress: string | null,
  userAgent: string | null,
  acceptLanguage: string | null,
) {
  return {
    last_page_url: nullableText(body.page_url),
    referrer: nullableText(body.referrer),
    utm_source: nullableText(body.utm_source),
    utm_medium: nullableText(body.utm_medium),
    utm_campaign: nullableText(body.utm_campaign),
    utm_content: nullableText(body.utm_content),
    utm_term: nullableText(body.utm_term),
    fbclid: nullableText(body.fbclid),
    fbp: nullableText(body.fbp),
    fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
    ip_address: ipAddress,
    user_agent: userAgent,
    accept_language: acceptLanguage,
    last_seen_at: new Date().toISOString(),
  };
}

function mergeAttributionSnapshot(
  body: TrackingBody,
  anonymousId: string,
  sessionId: string,
  journeyId: string | null,
) {
  return {
    tracking_source: "public_web",
    anonymous_id: anonymousId,
    session_id: sessionId,
    journey_id: journeyId,
    page_url: nullableText(body.page_url),
    path: nullableText(body.path),
    referrer: nullableText(body.referrer),
    event_source_url: nullableText(body.event_source_url) ?? nullableText(body.page_url),
    utm_source: nullableText(body.utm_source),
    utm_medium: nullableText(body.utm_medium),
    utm_campaign: nullableText(body.utm_campaign),
    utm_content: nullableText(body.utm_content),
    utm_term: nullableText(body.utm_term),
    fbclid: nullableText(body.fbclid),
    fbp: nullableText(body.fbp),
    fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
    user_data: buildUserDataSnapshot(body, anonymousId),
  };
}

Deno.serve(async (req) => {
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
    const supabaseAdmin = createSupabaseAdminClient();
    const companyId = await resolveCompanyId(supabaseAdmin, body);

    const ipAddress = getClientIpAddress(req);
    const userAgent = nullableText(req.headers.get("user-agent"));
    const acceptLanguage = nullableText(req.headers.get("accept-language"));
    const sessionPatch = buildSessionPatch(body, ipAddress, userAgent, acceptLanguage);

    let session = await findValidSession(supabaseAdmin, companyId, anonymousId, requestedSessionId);

    if (!session) {
      const { data, error } = await supabaseAdmin
        .from("tracking_sessions")
        .insert({
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
          fbclid: nullableText(body.fbclid),
          fbp: nullableText(body.fbp),
          fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
          ip_address: ipAddress,
          user_agent: userAgent,
          accept_language: acceptLanguage,
          started_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (error) {
        throw new Error(error.message);
      }

      session = data as Record<string, unknown>;
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
          .eq("id", session.id as string);

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
        .select("id, reservation_id, status")
        .eq("id", journeyId)
        .eq("company_id", companyId)
        .maybeSingle();

      if (journeyLookupError) {
        throw new Error(journeyLookupError.message);
      }

      const shouldRotateJourney = !existingJourney
        || existingJourney.status !== "active"
        || (
          !!existingJourney.reservation_id
          && existingJourney.reservation_id !== reservationId
        );

      if (shouldRotateJourney) {
        journeyId = crypto.randomUUID();

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
          throw new Error(journeyInsertError.message);
        }
      } else {
        const patch = {
          session_id: sessionId,
          reservation_id: reservationId ?? existingJourney.reservation_id,
          last_event_at: new Date().toISOString(),
        };

        const { error: journeyUpdateError } = await supabaseAdmin
          .from("tracking_journeys")
          .update(patch)
          .eq("id", journeyId);

        if (journeyUpdateError) {
          throw new Error(journeyUpdateError.message);
        }
      }
    }

    if (reservationId) {
      const attributionSnapshot = mergeAttributionSnapshot(body, anonymousId, sessionId, journeyId);
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

    if (eventName !== "session_ping") {
      const eventSourceUrl = nullableText(body.event_source_url) ?? nullableText(body.page_url);
      const occurredAt = nullableText(body.occurred_at) ?? new Date().toISOString();

      const { error: eventInsertError } = await supabaseAdmin
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
          occurred_at: occurredAt,
          metadata: {
            ...asMetadata(body.metadata),
            tracking_source: "public_web",
            fbp: nullableText(body.fbp),
            fbc: deriveFbc(nullableText(body.fbc), nullableText(body.fbclid)),
            fbclid: nullableText(body.fbclid),
          },
          user_data_snapshot: buildUserDataSnapshot(body, anonymousId),
        });

      if (eventInsertError && !eventInsertError.message.includes("duplicate key")) {
        throw new Error(eventInsertError.message);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      company_id: companyId,
      anonymous_id: anonymousId,
      session_id: sessionId,
      journey_id: journeyId,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Erro interno" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
