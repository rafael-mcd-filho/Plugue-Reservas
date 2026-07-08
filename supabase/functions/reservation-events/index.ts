import {
  createSupabaseAdminClient,
  getAuthenticatedUser,
  getUserRoleRows,
} from "../_shared/internal-auth.ts";
import {
  buildEvolutionNotConfiguredFailure,
  buildReservationDispatchKey,
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  buildWaitlistDispatchKey,
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
  formatPhoneForWhatsApp,
  getWhatsAppAcceptedLogStatus,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";
import {
  buildReservationParameters,
  buildWaitlistParameters,
  enqueuePlugueChatMessage,
  getCompanyChannel,
  normalizePhone,
} from "../_shared/pluguechat.ts";
import { getFirstName } from "../_shared/names.ts";

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

const RESERVATION_AUTOMATION_EVENTS = new Set(["reservation_created", "reservation_cancelled"]);
const PLUGUECHAT_TRANSACTIONAL_PRIORITY = 10;

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
    .replace(/\{nome\}/g, getFirstName(reservation.guest_name))
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

async function getInternalJobSecret(supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>) {
  const envSecret = Deno.env.get("INTERNAL_JOB_SECRET");
  if (envSecret) return envSecret;

  const { data, error } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "internal_job_secret")
    .maybeSingle();

  if (error) {
    console.error("reservation-events internal job secret load error", error);
    return null;
  }

  return typeof data?.value === "string" && data.value.trim() ? data.value.trim() : null;
}

async function processPlugueChatQueueNow(supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>) {
  const secret = await getInternalJobSecret(supabaseAdmin);
  if (!secret) {
    console.warn("reservation-events pluguechat queue process skipped: internal job secret not configured");
    return;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  if (!supabaseUrl) {
    console.warn("reservation-events pluguechat queue process skipped: SUPABASE_URL not configured");
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/process-pluguechat-message-queue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-job-secret": secret,
      },
      body: "{}",
    });

    if (!response.ok) {
      let details = "";
      try {
        details = await response.text();
      } catch {
        details = "";
      }
      console.warn("reservation-events pluguechat queue process failed", response.status, details);
    }
  } catch (error) {
    console.warn(
      "reservation-events pluguechat queue process error",
      error instanceof Error ? error.message : error,
    );
  }
}

function runInBackground(task: Promise<unknown>) {
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(task);
    return;
  }

  task.catch((error) => {
    console.warn("reservation-events background task error", error);
  });
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

async function noteWhatsAppDeliverySent(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
  instanceName: string,
) {
  const { error } = await supabaseAdmin.rpc("note_whatsapp_delivery_sent", {
    _company_id: companyId,
    _instance_name: instanceName,
    _min_delay_seconds: 40,
    _max_delay_seconds: 80,
  });

  if (error) {
    console.warn(`Nao foi possivel atualizar a cadencia do WhatsApp: ${error.message}`);
  }
}

async function enqueueWhatsAppMessage(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  payload: Omit<WhatsAppMessagePayload, "status">,
) {
  await enqueueWhatsAppMessageOnce(supabaseAdmin, {
    company_id: payload.company_id,
    reservation_id: payload.reservation_id ?? null,
    phone: payload.phone,
    message: payload.message,
    type: payload.type,
    error_details: payload.error_details ?? null,
  });
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

async function enqueuePlugueChatReservation(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  reservation: ReservationData,
  trackingUrl: string | null,
  results: { whatsapp?: string },
) {
  if (!RESERVATION_AUTOMATION_EVENTS.has(event)) return;

  if (event === "reservation_cancelled" && reservation.status !== "cancelled") {
    results.whatsapp = "skipped_reservation_not_cancelled";
    return;
  }

  const automationType = event === "reservation_created" ? "confirmation_message" : "cancellation_message";

  const { data: template } = await supabaseAdmin
    .from("pluguechat_automation_templates")
    .select("template_id, template_name")
    .eq("company_id", reservation.company_id)
    .eq("type", automationType)
    .eq("enabled", true)
    .maybeSingle();

  if (!template?.template_id || !reservation.guest_phone) {
    results.whatsapp = "pluguechat_template_not_configured";
    return;
  }

  const phone = normalizePhone(reservation.guest_phone);
  const idempotencyKey = `pluguechat:reservation:${reservation.id}:${automationType}`;
  const parameters = buildReservationParameters(automationType, reservation as any, trackingUrl);

  const result = await enqueuePlugueChatMessage(supabaseAdmin, {
    company_id: reservation.company_id,
    reservation_id: reservation.id,
    phone,
    type: automationType,
    template_id: template.template_id,
    template_name: template.template_name ?? null,
    parameters,
    priority: PLUGUECHAT_TRANSACTIONAL_PRIORITY,
    idempotency_key: idempotencyKey,
  });

  results.whatsapp = result === "inserted" ? "pluguechat_queued" : "skipped_duplicate";
}

async function enqueuePlugueChatWaitlist(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  waitlist: WaitlistData,
  trackingUrl: string | null,
  results: { whatsapp?: string },
) {
  const automationType = event === "waitlist_added" ? "waitlist_entry" : "waitlist_called";

  const { data: template } = await supabaseAdmin
    .from("pluguechat_automation_templates")
    .select("template_id, template_name")
    .eq("company_id", waitlist.company_id)
    .eq("type", automationType)
    .eq("enabled", true)
    .maybeSingle();

  if (!template?.template_id || !waitlist.guest_phone) {
    results.whatsapp = "pluguechat_template_not_configured";
    return;
  }

  const phone = normalizePhone(waitlist.guest_phone);
  const idempotencyKey = `pluguechat:waitlist:${waitlist.id}:${automationType}`;
  const parameters = buildWaitlistParameters(automationType, waitlist as any, trackingUrl);

  const result = await enqueuePlugueChatMessage(supabaseAdmin, {
    company_id: waitlist.company_id,
    waitlist_id: waitlist.id,
    phone,
    type: automationType,
    template_id: template.template_id,
    template_name: template.template_name ?? null,
    parameters,
    priority: PLUGUECHAT_TRANSACTIONAL_PRIORITY,
    idempotency_key: idempotencyKey,
  });

  results.whatsapp = result === "inserted" ? "pluguechat_queued" : "skipped_duplicate";
}

async function sendReservationAutomation(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  event: string,
  reservation: ReservationData,
  trackingUrl: string | null,
  results: { whatsapp?: string },
) {
  if (!RESERVATION_AUTOMATION_EVENTS.has(event)) return;

  if (event === "reservation_cancelled" && reservation.status !== "cancelled") {
    results.whatsapp = "skipped_reservation_not_cancelled";
    return;
  }

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

  const deliveryKey = buildReservationDispatchKey(logType, reservation.id);
  const [{ data: existingLogs }, { data: existingQueue }] = await Promise.all([
    supabaseAdmin
      .from("whatsapp_message_logs")
      .select("id")
      .eq("company_id", reservation.company_id)
      .eq("reservation_id", reservation.id)
      .eq("type", logType)
      .limit(1),
    supabaseAdmin
      .from("whatsapp_message_queue")
      .select("id")
      .eq("company_id", reservation.company_id)
      .eq("reservation_id", reservation.id)
      .eq("type", logType)
      .limit(1),
  ]);

  if ((existingLogs && existingLogs.length > 0) || (existingQueue && existingQueue.length > 0)) {
    results.whatsapp = "skipped_duplicate";
    return;
  }

  const phone = formatPhoneForWhatsApp(reservation.guest_phone);
  const claimed = await claimWhatsAppDispatch(supabaseAdmin, {
    deliveryKey,
    companyId: reservation.company_id,
    automationType: logType,
    reservationId: reservation.id,
    phone,
  });

  if (!claimed) {
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "accepted",
    });
    await noteWhatsAppDeliverySent(supabaseAdmin, reservation.company_id, instance.instance_name);
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
  await finalizeWhatsAppDispatch(supabaseAdmin, {
    deliveryKey,
    status: "queued",
    errorDetails: serializedError,
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
    .replace(/\{nome\}/g, getFirstName(waitlist.guest_name))
    .replace(/\{pessoas\}/g, String(waitlist.party_size || 1))
    .replace(/\{posicao\}/g, String(waitlist.position || ""))
    .replace(/\{link_acompanhamento\}/g, trackingUrl || "")
    .replace(/\{telefone\}/g, waitlist.guest_phone || "");

  const phone = formatPhoneForWhatsApp(waitlist.guest_phone);
  const deliveryKey = buildWaitlistDispatchKey(messageType, waitlist.id);
  const [{ data: existingLogs }, { data: existingQueue }] = await Promise.all([
    supabaseAdmin
      .from("whatsapp_message_logs")
      .select("id")
      .eq("company_id", waitlist.company_id)
      .eq("phone", phone)
      .eq("type", messageType)
      .eq("message", message)
      .limit(1),
    supabaseAdmin
      .from("whatsapp_message_queue")
      .select("id")
      .eq("company_id", waitlist.company_id)
      .eq("phone", phone)
      .eq("type", messageType)
      .eq("message", message)
      .limit(1),
  ]);

  if ((existingLogs && existingLogs.length > 0) || (existingQueue && existingQueue.length > 0)) {
    results.whatsapp = "skipped_duplicate";
    return;
  }

  const claimed = await claimWhatsAppDispatch(supabaseAdmin, {
    deliveryKey,
    companyId: waitlist.company_id,
    automationType: messageType,
    phone,
  });

  if (!claimed) {
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "queued",
      errorDetails: serializeWhatsAppFailure(failure.error),
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
    await finalizeWhatsAppDispatch(supabaseAdmin, {
      deliveryKey,
      status: "accepted",
    });
    await noteWhatsAppDeliverySent(supabaseAdmin, waitlist.company_id, instance.instance_name);
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
  await finalizeWhatsAppDispatch(supabaseAdmin, {
    deliveryKey,
    status: "queued",
    errorDetails: serializedError,
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

    const results: { whatsapp?: string; pluguechat_processing?: string } = {};
    const companyId = reservation?.company_id ?? waitlist?.company_id ?? null;
    const activeChannel = companyId ? await getCompanyChannel(supabaseAdmin, companyId) : "evolution";

    if (reservation) {
      if (activeChannel === "pluguechat_official") {
        await enqueuePlugueChatReservation(supabaseAdmin, event, reservation, reservationTrackingUrl, results);
      } else {
        await sendReservationAutomation(supabaseAdmin, event, reservation, reservationTrackingUrl, results);
      }
    }

    if (waitlist) {
      if (activeChannel === "pluguechat_official") {
        await enqueuePlugueChatWaitlist(supabaseAdmin, event, waitlist, waitlistTrackingUrl, results);
      } else {
        await sendWaitlistAutomation(supabaseAdmin, event, waitlist, waitlistTrackingUrl, results);
      }
    }

    if (activeChannel === "pluguechat_official" && results.whatsapp === "pluguechat_queued") {
      runInBackground(processPlugueChatQueueNow(supabaseAdmin));
      results.pluguechat_processing = "scheduled";
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
