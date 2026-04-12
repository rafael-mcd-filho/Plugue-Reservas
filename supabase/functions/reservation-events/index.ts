import {
  createSupabaseAdminClient,
  getAuthenticatedUser,
  getUserRoleRows,
} from "../_shared/internal-auth.ts";
import {
  buildEvolutionNotConfiguredFailure,
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  formatPhoneForWhatsApp,
  getWhatsAppAcceptedLogStatus,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ReservationData {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  occasion: string | null;
  notes: string | null;
  created_at?: string | null;
  visitor_id?: string | null;
  public_tracking_code?: string | null;
}

interface WaitlistData {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  party_size: number;
  position: number | null;
  status: string;
  tracking_code?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

interface WhatsAppMessagePayload {
  company_id: string;
  reservation_id?: string | null;
  phone: string;
  message: string;
  type: string;
  status?: "sent" | "error";
  error_details?: string | null;
}

function replaceTemplateVars(
  template: string,
  reservation: ReservationData,
  trackingUrl: string | null = null,
) {
  const [hours, minutes] = (reservation.time || "").split(":");
  const timeFormatted = hours && minutes ? `${hours}:${minutes}` : reservation.time;
  const [year, month, day] = (reservation.date || "").split("-");
  const dateFormatted = day && month && year ? `${day}/${month}/${year}` : reservation.date;

  return template
    .replace(/\{nome\}/g, reservation.guest_name || "")
    .replace(/\{pessoas\}/g, String(reservation.party_size || 1))
    .replace(/\{data\}/g, dateFormatted)
    .replace(/\{hora\}/g, timeFormatted)
    .replace(/\{link_acompanhamento\}/g, trackingUrl || "")
    .replace(/\{telefone\}/g, reservation.guest_phone || "");
}

function sanitizeOrigin(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function getAppOrigin(req: Request) {
  const origin = sanitizeOrigin(req.headers.get("origin"));
  if (origin) return origin;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return sanitizeOrigin(new URL(referer).origin);
    } catch {
      // Ignore invalid referer and fall through to envs.
    }
  }

  return sanitizeOrigin(Deno.env.get("APP_URL"))
    ?? sanitizeOrigin(Deno.env.get("SITE_URL"));
}

function buildPublicTrackingUrl(
  appOrigin: string | null,
  slug: string | null,
  pathSegment: "reserva" | "fila",
  trackingCode: string | null | undefined,
) {
  if (!appOrigin || !slug || !trackingCode) {
    return null;
  }

  return `${appOrigin}/${slug}/${pathSegment}/${trackingCode}`;
}

async function resolveReservation(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  reservationId: string | null,
) {
  if (!reservationId) return null;

  const { data, error } = await supabaseAdmin
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as ReservationData | null) ?? null;
}

async function resolveWaitlist(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  waitlistId: string | null,
) {
  if (!waitlistId) return null;

  const { data, error } = await supabaseAdmin
    .from("waitlist")
    .select("*")
    .eq("id", waitlistId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as WaitlistData | null) ?? null;
}

async function resolveCompanySlug(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string | null,
) {
  if (!companyId) return null;

  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("slug")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return typeof data?.slug === "string" ? data.slug : null;
}

async function assertCanTriggerEvent(
  req: Request,
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  reservation: ReservationData | null,
  waitlist: WaitlistData | null,
  publicVisitorId: string | null,
  publicReservationTrackingCode: string | null,
) {
  const companyId = reservation?.company_id || waitlist?.company_id || null;
  if (!companyId) {
    throw new Error("Empresa nao identificada");
  }

  const user = await getAuthenticatedUser(req);
  if (user) {
    const roleRows = await getUserRoleRows(supabaseAdmin, user.id);
    const isSuperadmin = roleRows.some((row) => row.role === "superadmin");
    const hasCompanyAccess = roleRows.some((row) =>
      row.company_id === companyId && ["admin", "operator"].includes(row.role)
    );

    if (!isSuperadmin && !hasCompanyAccess) {
      throw new Error("Sem permissao para disparar eventos desta empresa");
    }

    return;
  }

  if (event === "waitlist_added" && waitlist) {
      const createdAt = waitlist.created_at ? new Date(waitlist.created_at).getTime() : 0;
      if (!createdAt || createdAt < Date.now() - 10 * 60 * 1000) {
        throw new Error("Evento publico expirado");
      }

      return;
  }

  if (event === "reservation_cancelled" && reservation && publicReservationTrackingCode) {
    if (!reservation.public_tracking_code || reservation.public_tracking_code !== publicReservationTrackingCode) {
      throw new Error("Nao autorizado");
    }

    return;
  }

  if (event !== "reservation_created" || !reservation || !publicVisitorId) {
    throw new Error("Nao autorizado");
  }

  if (!reservation.visitor_id || reservation.visitor_id !== publicVisitorId) {
    throw new Error("Nao autorizado");
  }

  const createdAt = reservation.created_at ? new Date(reservation.created_at).getTime() : 0;
  if (!createdAt || createdAt < Date.now() - 10 * 60 * 1000) {
    throw new Error("Evento publico expirado");
  }
}

async function getEvolutionConfig(supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>) {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("key, value")
    .in("key", ["evolution_api_url", "evolution_api_token"]);

  return {
    evolutionUrl: settings?.find((setting: any) => setting.key === "evolution_api_url")?.value?.replace(/\/+$/, ""),
    evolutionToken: settings?.find((setting: any) => setting.key === "evolution_api_token")?.value,
  };
}

async function insertWhatsAppLog(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  payload: WhatsAppMessagePayload,
) {
  const { error } = await supabaseAdmin.from("whatsapp_message_logs").insert({
    company_id: payload.company_id,
    reservation_id: payload.reservation_id ?? null,
    phone: payload.phone,
    message: payload.message,
    type: payload.type,
    status: payload.status ?? "sent",
    error_details: payload.error_details ?? null,
  });

  if (error) {
    throw new Error(`Erro ao gravar log do WhatsApp: ${error.message}`);
  }
}

async function enqueueWhatsAppMessage(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  payload: Omit<WhatsAppMessagePayload, "status">,
) {
  const { error } = await supabaseAdmin.from("whatsapp_message_queue").insert({
    company_id: payload.company_id,
    reservation_id: payload.reservation_id ?? null,
    phone: payload.phone,
    message: payload.message,
    type: payload.type,
    error_details: payload.error_details ?? null,
  });

  if (error) {
    throw new Error(`Erro ao gravar fila do WhatsApp: ${error.message}`);
  }
}

async function recordQueuedFailure(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  payload: Omit<WhatsAppMessagePayload, "status">,
) {
  await insertWhatsAppLog(supabaseAdmin, {
    ...payload,
    status: "error",
  });

  await enqueueWhatsAppMessage(supabaseAdmin, payload);
}

async function sendReservationAutomation(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  reservation: ReservationData,
  trackingUrl: string | null,
  results: { whatsapp?: string },
) {
  if (!["reservation_created", "reservation_cancelled"].includes(event)) return;

  const automationType = event === "reservation_created" ? "confirmation_message" : "cancellation_message";
  const logType = event === "reservation_created" ? "confirmation" : "cancellation";

  const { data: automation } = await supabaseAdmin
    .from("automation_settings")
    .select("*")
    .eq("company_id", reservation.company_id)
    .eq("type", automationType)
    .eq("enabled", true)
    .maybeSingle();

  if (!automation?.message_template || !reservation.guest_phone) return;

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recentDup } = await supabaseAdmin
    .from("whatsapp_message_logs")
    .select("id")
    .eq("company_id", reservation.company_id)
    .eq("reservation_id", reservation.id)
    .eq("type", logType)
    .gte("created_at", fiveMinAgo)
    .limit(1);

  if (recentDup && recentDup.length > 0) {
    results.whatsapp = "skipped_duplicate";
    return;
  }

  const { evolutionUrl, evolutionToken } = await getEvolutionConfig(supabaseAdmin);
  let message = replaceTemplateVars(automation.message_template, reservation, trackingUrl);
  if (
    event === "reservation_created" &&
    trackingUrl &&
    !automation.message_template.includes("{link_acompanhamento}")
  ) {
    message = `${message}\n\nAcompanhe sua reserva:\n${trackingUrl}`;
  }
  const phone = formatPhoneForWhatsApp(reservation.guest_phone);

  if (!evolutionUrl || !evolutionToken) {
    const failure = buildEvolutionNotConfiguredFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: reservation.company_id,
      reservation_id: reservation.id,
      phone,
      message,
      type: logType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  const { data: instance } = await supabaseAdmin
    .from("company_whatsapp_instances")
    .select("instance_name, status")
    .eq("company_id", reservation.company_id)
    .maybeSingle();

  if (!instance) {
    const failure = buildInstanceNotConfiguredFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: reservation.company_id,
      reservation_id: reservation.id,
      phone,
      message,
      type: logType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  if (instance.status !== "connected") {
    const failure = buildInstanceDisconnectedFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: reservation.company_id,
      reservation_id: reservation.id,
      phone,
      message,
      type: logType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  const sendResult = await sendWhatsAppText(
    evolutionUrl,
    evolutionToken,
    instance.instance_name,
    phone,
    message,
  );

  if (sendResult.ok) {
    const logStatus = getWhatsAppAcceptedLogStatus(sendResult);
    results.whatsapp = "sent";
    await insertWhatsAppLog(supabaseAdmin, {
      company_id: reservation.company_id,
      reservation_id: reservation.id,
      phone,
      message,
      type: logType,
      status: logStatus,
      error_details: null,
    });
    return;
  }

  results.whatsapp = sendResult.error.code;
  const serializedError = serializeWhatsAppFailure(sendResult.error);

  await insertWhatsAppLog(supabaseAdmin, {
    company_id: reservation.company_id,
    reservation_id: reservation.id,
    phone,
    message,
    type: logType,
    status: "error",
    error_details: serializedError,
  });

  await enqueueWhatsAppMessage(supabaseAdmin, {
    company_id: reservation.company_id,
    reservation_id: reservation.id,
    phone,
    message,
    type: logType,
    error_details: serializedError,
  });
}

async function sendWaitlistAutomation(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  waitlist: WaitlistData,
  trackingUrl: string | null,
  results: { whatsapp?: string },
) {
  if (!["waitlist_added", "waitlist_called"].includes(event) || !waitlist?.guest_phone) return;

  const automationType = event === "waitlist_added" ? "waitlist_entry" : "waitlist_called";
  const messageType = event === "waitlist_added" ? "waitlist_entry" : "waitlist_called";

  const { data: automation } = await supabaseAdmin
    .from("automation_settings")
    .select("*")
    .eq("company_id", waitlist.company_id)
    .eq("type", automationType)
    .eq("enabled", true)
    .maybeSingle();

  if (!automation?.message_template) return;

  const message = automation.message_template
    .replace(/\{nome\}/g, waitlist.guest_name || "")
    .replace(/\{pessoas\}/g, String(waitlist.party_size || 1))
    .replace(/\{posicao\}/g, String(waitlist.position || ""))
    .replace(/\{link_acompanhamento\}/g, trackingUrl || "")
    .replace(/\{telefone\}/g, waitlist.guest_phone || "");

  const phone = formatPhoneForWhatsApp(waitlist.guest_phone);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recentDup } = await supabaseAdmin
    .from("whatsapp_message_logs")
    .select("id")
    .eq("company_id", waitlist.company_id)
    .eq("phone", phone)
    .eq("type", messageType)
    .eq("message", message)
    .gte("created_at", fiveMinAgo)
    .limit(1);

  if (recentDup && recentDup.length > 0) {
    results.whatsapp = "skipped_duplicate";
    return;
  }

  const { evolutionUrl, evolutionToken } = await getEvolutionConfig(supabaseAdmin);
  if (!evolutionUrl || !evolutionToken) {
    const failure = buildEvolutionNotConfiguredFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: waitlist.company_id,
      phone,
      message,
      type: messageType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  const { data: instance } = await supabaseAdmin
    .from("company_whatsapp_instances")
    .select("instance_name, status")
    .eq("company_id", waitlist.company_id)
    .maybeSingle();

  if (!instance) {
    const failure = buildInstanceNotConfiguredFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: waitlist.company_id,
      phone,
      message,
      type: messageType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  if (instance.status !== "connected") {
    const failure = buildInstanceDisconnectedFailure();
    results.whatsapp = failure.error.code;
    await recordQueuedFailure(supabaseAdmin, {
      company_id: waitlist.company_id,
      phone,
      message,
      type: messageType,
      error_details: serializeWhatsAppFailure(failure.error),
    });
    return;
  }

  const sendResult = await sendWhatsAppText(
    evolutionUrl,
    evolutionToken,
    instance.instance_name,
    phone,
    message,
  );

  if (sendResult.ok) {
    const logStatus = getWhatsAppAcceptedLogStatus(sendResult);
    results.whatsapp = "sent";
    await insertWhatsAppLog(supabaseAdmin, {
      company_id: waitlist.company_id,
      phone,
      message,
      type: messageType,
      status: logStatus,
      error_details: null,
    });
    return;
  }

  results.whatsapp = sendResult.error.code;
  const serializedError = serializeWhatsAppFailure(sendResult.error);

  await insertWhatsAppLog(supabaseAdmin, {
    company_id: waitlist.company_id,
    phone,
    message,
    type: messageType,
    status: "error",
    error_details: serializedError,
  });

  await enqueueWhatsAppMessage(supabaseAdmin, {
    company_id: waitlist.company_id,
    phone,
    message,
    type: messageType,
    error_details: serializedError,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createSupabaseAdminClient();
    const body = await req.json();
    const event = typeof body.event === "string" ? body.event : null;
    const reservationId = typeof body.reservation?.id === "string" ? body.reservation.id : null;
    const publicVisitorId = typeof body.reservation?.visitor_id === "string" ? body.reservation.visitor_id : null;
    const publicReservationTrackingCode = typeof body.reservation?.tracking_code === "string"
      ? body.reservation.tracking_code
      : null;
    const waitlistId = typeof body.waitlist?.id === "string" ? body.waitlist.id : null;

    if (!event) {
      return new Response(JSON.stringify({ error: "Missing event" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const reservation = await resolveReservation(supabaseAdmin, reservationId);
    const waitlist = await resolveWaitlist(supabaseAdmin, waitlistId);
    const companySlug = await resolveCompanySlug(
      supabaseAdmin,
      reservation?.company_id ?? waitlist?.company_id ?? null,
    );
    const appOrigin = getAppOrigin(req);
    const reservationTrackingUrl = buildPublicTrackingUrl(
      appOrigin,
      companySlug,
      "reserva",
      reservation?.public_tracking_code ?? null,
    );
    const waitlistTrackingUrl = buildPublicTrackingUrl(
      appOrigin,
      companySlug,
      "fila",
      waitlist?.tracking_code ?? null,
    );

    if (!reservation && !waitlist) {
      return new Response(JSON.stringify({ error: "Missing event data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await assertCanTriggerEvent(
      req,
      supabaseAdmin,
      event,
      reservation,
      waitlist,
      publicVisitorId,
      publicReservationTrackingCode,
    );

    const results: { whatsapp?: string } = {};

    if (reservation) {
      await sendReservationAutomation(supabaseAdmin, event, reservation, reservationTrackingUrl, results);
    }

    if (waitlist) {
      await sendWaitlistAutomation(supabaseAdmin, event, waitlist, waitlistTrackingUrl, results);
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Erro interno" }), {
      status: error.message === "Nao autorizado"
        ? 401
        : error.message === "Sem permissao para disparar eventos desta empresa" || error.message === "Evento publico expirado"
          ? 403
          : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
