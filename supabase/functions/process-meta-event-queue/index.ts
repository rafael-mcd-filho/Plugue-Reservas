import {
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

function normalizeText(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHashInput(value: string | null | undefined) {
  if (!value) return null;
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

function normalizePhone(value: string | null | undefined) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function normalizeLocation(value: string | null | undefined) {
  const normalized = normalizeHashInput(value);
  return normalized ? normalized.replace(/[^a-z0-9]/g, "") : null;
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, any>;
  }

  return value as Record<string, any>;
}

async function sha256(value: string | null) {
  if (!value) return null;

  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildGraphUrl(pixelId: string) {
  const graphVersion = Deno.env.get("META_GRAPH_API_VERSION") ?? "v22.0";
  return `https://graph.facebook.com/${graphVersion}/${pixelId}/events`;
}

function getRetryDelayMinutes(attempt: number) {
  return Math.min(5 * 2 ** Math.max(attempt - 1, 0), 360);
}

function isEventTypeEnabled(metaEventName: string, settings: Record<string, any>) {
  if (metaEventName === "PageView") return !!settings.send_page_view;
  if (metaEventName === "InitiateCheckout") return settings.send_initiate_checkout !== false;
  if (metaEventName === "Lead") return !!settings.send_lead;
  if (metaEventName === "Schedule") return settings.send_schedule !== false;
  return true;
}

async function buildUserDataPayload(params: {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  externalId?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}) {
  return {
    em: await sha256(normalizeHashInput(params.email ?? null)),
    ph: await sha256(normalizePhone(params.phone ?? null)),
    fn: await sha256(normalizeHashInput(params.firstName ?? null)),
    ln: await sha256(normalizeHashInput(params.lastName ?? null)),
    ct: await sha256(normalizeLocation(params.city ?? null)),
    st: await sha256(normalizeLocation(params.state ?? null)),
    zp: await sha256(normalizeLocation(params.zip ?? null)),
    country: await sha256(normalizeLocation(params.country ?? null)),
    external_id: await sha256(normalizeHashInput(params.externalId ?? null)),
    client_ip_address: normalizeText(params.clientIpAddress ?? null),
    client_user_agent: normalizeText(params.clientUserAgent ?? null),
    fbp: normalizeText(params.fbp ?? null),
    fbc: normalizeText(params.fbc ?? null),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const requestedCompanyId = normalizeText(body.company_id);
    const internalJob = isAuthorizedInternalJob(req);

    if (!internalJob) {
      if (!requestedCompanyId) {
        return new Response(JSON.stringify({ error: "company_id e obrigatorio" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await assertUserCanAccessCompany(req, requestedCompanyId, ["superadmin", "admin"]);
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const processingQuery = supabaseAdmin
      .from("meta_event_queue")
      .select("id")
      .eq("status", "processing")
      .gte("last_attempt_at", threeMinAgo)
      .limit(1);

    const { data: processingRows, error: processingError } = requestedCompanyId
      ? await processingQuery.eq("company_id", requestedCompanyId)
      : await processingQuery;

    if (processingError) {
      throw new Error(processingError.message);
    }

    if (processingRows && processingRows.length > 0) {
      return new Response(JSON.stringify({ skipped: true, reason: "another_process_running" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const queueQuery = supabaseAdmin
      .from("meta_event_queue")
      .select("*")
      .in("status", ["pending", "processing"])
      .lte("next_retry_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(20);

    const { data: queueRows, error: queueError } = requestedCompanyId
      ? await queueQuery.eq("company_id", requestedCompanyId)
      : await queueQuery;

    if (queueError) {
      throw new Error(queueError.message);
    }

    if (!queueRows || queueRows.length === 0) {
      return new Response(JSON.stringify({ processed: 0, sent: 0, failed: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;

    for (const queueRow of queueRows as any[]) {
      const attemptNumber = Number(queueRow.attempts || 0) + 1;

      await supabaseAdmin
        .from("meta_event_queue")
        .update({
          status: "processing",
          attempts: attemptNumber,
          last_attempt_at: new Date().toISOString(),
        })
        .eq("id", queueRow.id);

      const { data: settings, error: settingsError } = await supabaseAdmin
        .from("company_tracking_settings")
        .select("*")
        .eq("company_id", queueRow.company_id)
        .maybeSingle();

      if (settingsError) {
        throw new Error(settingsError.message);
      }

      const settingsRecord = asRecord(settings);
      const pixelId = normalizeText(settingsRecord.pixel_id);
      const accessToken = normalizeText(settingsRecord.access_token);
      const capiEnabled = !!settingsRecord.capi_enabled;
      const eventTypeEnabled = isEventTypeEnabled(queueRow.meta_event_name, settingsRecord);

      if (!capiEnabled || !pixelId || !accessToken || !eventTypeEnabled) {
        const disabledReason = !eventTypeEnabled
          ? `Envio do evento ${queueRow.meta_event_name} esta desabilitado`
          : "Meta CAPI nao configurada para esta empresa";

        await supabaseAdmin
          .from("meta_event_queue")
          .update({
            status: "failed",
            last_error: disabledReason,
            last_response_status: null,
          })
          .eq("id", queueRow.id);

        await supabaseAdmin
          .from("meta_event_attempts")
          .insert({
            queue_id: queueRow.id,
            company_id: queueRow.company_id,
            reservation_id: queueRow.reservation_id,
            status: "failed",
            request_payload: {},
            error_message: disabledReason,
          });

        failed++;
        continue;
      }

      const payloadContext = asRecord(queueRow.payload);
      const { data: reservation, error: reservationError } = queueRow.reservation_id
        ? await supabaseAdmin
          .from("reservations")
          .select("*")
          .eq("id", queueRow.reservation_id)
          .maybeSingle()
        : { data: null, error: null };

      if (reservationError) {
        throw new Error(reservationError.message);
      }

      const { data: trackingEvent, error: trackingEventError } = queueRow.tracking_event_id
        ? await supabaseAdmin
          .from("tracking_events")
          .select("*")
          .eq("id", queueRow.tracking_event_id)
          .maybeSingle()
        : { data: null, error: null };

      if (trackingEventError) {
        throw new Error(trackingEventError.message);
      }

      if (queueRow.reservation_id && !reservation) {
        await supabaseAdmin
          .from("meta_event_queue")
          .update({
            status: "failed",
            last_error: "Reserva de origem nao encontrada",
          })
          .eq("id", queueRow.id);

        failed++;
        continue;
      }

      if (!reservation && !trackingEvent) {
        await supabaseAdmin
          .from("meta_event_queue")
          .update({
            status: "failed",
            last_error: "Evento de origem nao encontrado",
          })
          .eq("id", queueRow.id);

        failed++;
        continue;
      }

      const sessionId = reservation?.origin_tracking_session_id
        ?? trackingEvent?.session_id
        ?? payloadContext.session_id
        ?? null;

      const { data: session, error: sessionError } = sessionId
        ? await supabaseAdmin
          .from("tracking_sessions")
          .select("*")
          .eq("id", sessionId)
          .maybeSingle()
        : { data: null, error: null };

      if (sessionError) {
        throw new Error(sessionError.message);
      }

      const requestPayload = trackingEvent
        ? await (async () => {
          const eventRecord = asRecord(trackingEvent);
          const userDataSnapshot = asRecord(payloadContext.user_data);
          const trackingUserData = Object.keys(userDataSnapshot).length > 0
            ? userDataSnapshot
            : asRecord(eventRecord.user_data_snapshot);
          const reservationAttribution = asRecord(reservation?.attribution_snapshot);
          const reservationUserData = asRecord(reservationAttribution.user_data);
          const reservationGuestName = normalizeText(reservation?.guest_name);
          const reservationGuestNameParts = reservationGuestName ? reservationGuestName.split(/\s+/) : [];

          return {
            data: [
              {
                event_name: queueRow.meta_event_name,
                event_time: Math.floor(new Date(eventRecord.occurred_at ?? queueRow.created_at).getTime() / 1000),
                event_id: normalizeText(eventRecord.event_id) ?? `${queueRow.event_name}:${queueRow.tracking_event_id ?? queueRow.id}`,
                action_source: "website",
                event_source_url: payloadContext.event_source_url
                  ?? eventRecord.event_source_url
                  ?? eventRecord.page_url
                  ?? session?.last_page_url
                  ?? session?.first_page_url
                  ?? null,
                user_data: await buildUserDataPayload({
                  email: trackingUserData.email ?? reservation?.guest_email ?? null,
                  phone: trackingUserData.phone ?? reservation?.guest_phone ?? null,
                  firstName: trackingUserData.first_name
                    ?? reservationUserData.first_name
                    ?? reservationGuestNameParts[0]
                    ?? null,
                  lastName: trackingUserData.last_name
                    ?? reservationUserData.last_name
                    ?? (reservationGuestNameParts.length > 1 ? reservationGuestNameParts.slice(1).join(" ") : null),
                  city: trackingUserData.city ?? reservationUserData.city ?? null,
                  state: trackingUserData.state ?? reservationUserData.state ?? null,
                  zip: trackingUserData.zip ?? reservationUserData.zip ?? null,
                  country: trackingUserData.country ?? reservationUserData.country ?? null,
                  externalId: trackingUserData.external_id
                    ?? payloadContext.anonymous_id
                    ?? reservation?.origin_anonymous_id
                    ?? eventRecord.anonymous_id
                    ?? eventRecord.id,
                  clientIpAddress: session?.ip_address ?? null,
                  clientUserAgent: session?.user_agent ?? null,
                  fbp: payloadContext.fbp ?? reservation?.origin_fbp ?? session?.fbp ?? null,
                  fbc: payloadContext.fbc ?? reservation?.origin_fbc ?? session?.fbc ?? null,
                }),
                custom_data: {
                  tracking_event_id: eventRecord.id,
                  step: eventRecord.step ?? null,
                  path: eventRecord.path ?? null,
                  reservation_id: eventRecord.reservation_id ?? null,
                },
              },
            ],
            test_event_code: normalizeText(settingsRecord.test_event_code),
          };
        })()
        : await (async () => {
          const attributionSnapshot = asRecord(reservation?.attribution_snapshot);
          const userDataSnapshot = asRecord(attributionSnapshot.user_data);
          const guestName = normalizeText(reservation?.guest_name);
          const guestNameParts = guestName ? guestName.split(/\s+/) : [];

          return {
            data: [
              {
                event_name: queueRow.meta_event_name,
                event_time: Math.floor(new Date(reservation.created_at ?? queueRow.created_at).getTime() / 1000),
                event_id: `${queueRow.event_name}:${queueRow.reservation_id ?? queueRow.id}`,
                action_source: "website",
                event_source_url: payloadContext.event_source_url
                  ?? attributionSnapshot.event_source_url
                  ?? session?.last_page_url
                  ?? session?.first_page_url
                  ?? null,
                user_data: await buildUserDataPayload({
                  email: reservation.guest_email,
                  phone: reservation.guest_phone,
                  firstName: userDataSnapshot.first_name ?? guestNameParts[0] ?? null,
                  lastName: userDataSnapshot.last_name
                    ?? (guestNameParts.length > 1 ? guestNameParts.slice(1).join(" ") : null),
                  city: userDataSnapshot.city ?? null,
                  state: userDataSnapshot.state ?? null,
                  zip: userDataSnapshot.zip ?? null,
                  country: userDataSnapshot.country ?? null,
                  externalId: userDataSnapshot.external_id
                    ?? payloadContext.anonymous_id
                    ?? reservation.origin_anonymous_id
                    ?? reservation.visitor_id
                    ?? reservation.id,
                  clientIpAddress: session?.ip_address ?? null,
                  clientUserAgent: session?.user_agent ?? null,
                  fbp: payloadContext.fbp ?? reservation.origin_fbp ?? session?.fbp ?? null,
                  fbc: payloadContext.fbc ?? reservation.origin_fbc ?? session?.fbc ?? null,
                }),
                custom_data: {
                  reservation_id: reservation.id,
                  reservation_date: reservation.date,
                  reservation_time: reservation.time,
                  party_size: reservation.party_size,
                  status: reservation.status,
                },
              },
            ],
            test_event_code: normalizeText(settingsRecord.test_event_code),
          };
        })();

      try {
        const graphUrl = new URL(buildGraphUrl(pixelId));
        graphUrl.searchParams.set("access_token", accessToken);

        const graphResponse = await fetch(graphUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        });

        const responseText = await graphResponse.text();
        const attemptStatus = graphResponse.ok ? "sent" : "failed";

        await supabaseAdmin
          .from("meta_event_attempts")
          .insert({
            queue_id: queueRow.id,
            company_id: queueRow.company_id,
            reservation_id: queueRow.reservation_id ?? trackingEvent?.reservation_id ?? null,
            status: attemptStatus,
            request_payload: requestPayload,
            response_status: graphResponse.status,
            response_body: responseText,
            error_message: graphResponse.ok ? null : responseText,
          });

        if (graphResponse.ok) {
          await supabaseAdmin
            .from("meta_event_queue")
            .update({
              status: "sent",
              last_response_status: graphResponse.status,
              last_error: null,
              sent_at: new Date().toISOString(),
            })
            .eq("id", queueRow.id);

          sent++;
        } else {
          const nextRetryMinutes = getRetryDelayMinutes(attemptNumber);
          const nextStatus = attemptNumber >= Number(queueRow.max_attempts || 5) ? "failed" : "pending";

          await supabaseAdmin
            .from("meta_event_queue")
            .update({
              status: nextStatus,
              last_response_status: graphResponse.status,
              last_error: responseText,
              next_retry_at: new Date(Date.now() + nextRetryMinutes * 60 * 1000).toISOString(),
            })
            .eq("id", queueRow.id);

          failed++;
        }
      } catch (error) {
        const nextRetryMinutes = getRetryDelayMinutes(attemptNumber);
        const nextStatus = attemptNumber >= Number(queueRow.max_attempts || 5) ? "failed" : "pending";
        const errorMessage = error instanceof Error ? error.message : String(error);

        await supabaseAdmin
          .from("meta_event_attempts")
          .insert({
            queue_id: queueRow.id,
            company_id: queueRow.company_id,
            reservation_id: queueRow.reservation_id ?? trackingEvent?.reservation_id ?? null,
            status: "failed",
            request_payload: requestPayload,
            error_message: errorMessage,
          });

        await supabaseAdmin
          .from("meta_event_queue")
          .update({
            status: nextStatus,
            last_error: errorMessage,
            next_retry_at: new Date(Date.now() + nextRetryMinutes * 60 * 1000).toISOString(),
          })
          .eq("id", queueRow.id);

        failed++;
      }
    }

    return new Response(JSON.stringify({
      processed: queueRows.length,
      sent,
      failed,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Erro interno" }), {
      status: error.message === "Nao autorizado"
        ? 401
        : error.message === "Sem permissao para esta empresa"
          ? 403
          : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
