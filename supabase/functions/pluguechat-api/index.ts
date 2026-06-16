import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import {
  encryptPlugueChatToken,
  getCompanyChannel,
  normalizePhone,
} from "../_shared/pluguechat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Nao autorizado") return 401;
  if (message.startsWith("Sem permissao")) return 403;
  return 500;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (normalized) seen.add(normalized);
  }

  return [...seen];
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function getInternalJobSecret(supabaseAdmin: any): Promise<string | null> {
  const envSecret = Deno.env.get("INTERNAL_JOB_SECRET");
  if (envSecret) return envSecret;

  const { data, error } = await supabaseAdmin
    .from("system_settings")
    .select("value")
    .eq("key", "internal_job_secret")
    .maybeSingle();

  if (error) {
    console.error("pluguechat-api internal job secret load error", error);
    return null;
  }

  return nullableString(data?.value);
}

async function processPlugueChatQueueNow(supabaseAdmin: any) {
  const secret = await getInternalJobSecret(supabaseAdmin);
  if (!secret) {
    return { ok: false, error: "internal_job_secret_not_configured" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  if (!supabaseUrl) {
    return { ok: false, error: "SUPABASE_URL not configured" };
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

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar fila.",
    };
  }
}

async function resetFailedQueueItems(
  supabaseAdmin: any,
  companyId: string,
  itemId: string | null = null,
) {
  const now = new Date();
  const resetPayload = {
    status: "pending",
    attempts: 0,
    scheduled_for: now.toISOString(),
    expires_at: addHours(now, 2).toISOString(),
    last_attempt_at: null,
    provider_message_id: null,
    provider_status: null,
    provider_status_url: null,
    provider_status_checked_at: null,
    error_details: null,
  };

  let query = supabaseAdmin
    .from("pluguechat_message_queue")
    .update(resetPayload)
    .eq("company_id", companyId)
    .eq("status", "failed");

  if (itemId) {
    query = query.eq("id", itemId);
  }

  const { data, error } = await query.select("id");
  if (error) {
    throw new Error(error.message);
  }

  const ids = (data ?? []).map((row: { id: string }) => row.id);

  if (ids.length > 0) {
    const { error: recipientError } = await supabaseAdmin
      .from("pluguechat_broadcast_recipients")
      .update({
        status: "queued",
        provider_message_id: null,
        error_details: null,
      })
      .in("queue_id", ids);

    if (recipientError) {
      console.error("pluguechat-api retry recipient update error", recipientError);
    }
  }

  return ids.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = nullableString(body.action);
    const companyId = nullableString(body.company_id);

    if (!companyId) {
      return json({ error: "company_id required" }, 400);
    }

    const { supabaseAdmin, user } = await assertUserCanAccessCompany(req, companyId, [
      "superadmin",
      "admin",
    ]);

    if (action === "save_config") {
      const fromNumber = normalizePhone(String(body.from_number ?? ""));
      const apiToken = nullableString(body.api_token);

      if (!fromNumber) {
        return json({ error: "from_number required" }, 400);
      }

      if (!Deno.env.get("PLUGUECHAT_API_URL")) {
        return json({ error: "PLUGUECHAT_API_URL not configured" }, 500);
      }

      const { data: existingConfig, error: existingError } = await supabaseAdmin
        .from("pluguechat_official_configs")
        .select("api_token_encrypted")
        .eq("company_id", companyId)
        .maybeSingle();

      if (existingError) {
        console.error("pluguechat-api existing config error", existingError);
        return json({ error: "Erro ao carregar configuracao." }, 500);
      }

      if (!apiToken && !existingConfig?.api_token_encrypted) {
        return json({ error: "api_token required" }, 400);
      }

      const upsertPayload: Record<string, unknown> = {
        company_id: companyId,
        from_number: fromNumber,
        status: "configured",
        updated_at: new Date().toISOString(),
      };

      if (apiToken) {
        try {
          upsertPayload.api_token_encrypted = await encryptPlugueChatToken(apiToken);
        } catch (error) {
          console.error("pluguechat-api token encryption error", error);
          return json({ error: "PLUGUECHAT_TOKEN_ENCRYPTION_KEY not configured" }, 500);
        }
      }

      const { error } = await supabaseAdmin
        .from("pluguechat_official_configs")
        .upsert(upsertPayload, { onConflict: "company_id" });

      if (error) {
        console.error("pluguechat-api save_config error", error);
        return json({ error: "Erro ao salvar configuracao." }, 500);
      }

      return json({ ok: true });
    }

    if (action === "create_broadcast") {
      const currentChannel = await getCompanyChannel(supabaseAdmin, companyId);
      if (currentChannel !== "pluguechat_official") {
        return json({ error: "channel_not_active", current: currentChannel }, 409);
      }

      const broadcastName = nullableString(body.name) ?? nullableString(body.broadcast_name);
      if (!broadcastName) {
        return json({ error: "name required" }, 400);
      }

      const templateId = nullableString(body.template_id);
      if (!templateId) {
        return json({ error: "template_id required" }, 400);
      }

      const scheduledFor = nullableString(body.scheduled_for);
      if (scheduledFor && Number.isNaN(Date.parse(scheduledFor))) {
        return json({ error: "scheduled_for invalid" }, 400);
      }

      const recipientReservationIds = uniqueStringArray(body.recipient_reservation_ids);
      if (recipientReservationIds.length === 0) {
        return json({ error: "recipient_reservation_ids required" }, 400);
      }

      if (recipientReservationIds.length > 500) {
        return json({ error: "recipient_limit_exceeded" }, 400);
      }

      const { data: reservationRows, error: reservationError } = await supabaseAdmin
        .from("reservations")
        .select("id, guest_phone")
        .eq("company_id", companyId)
        .in("id", recipientReservationIds)
        .not("guest_phone", "is", null);

      if (reservationError) {
        console.error("pluguechat-api broadcast recipients load error", reservationError);
        return json({ error: "Erro ao carregar destinatarios." }, 500);
      }

      const uniqueRecipients = new Map<string, { phone: string }>();
      for (const reservation of reservationRows ?? []) {
        const phone = normalizePhone(String(reservation.guest_phone ?? ""));
        if (!phone || uniqueRecipients.has(phone)) continue;

        uniqueRecipients.set(phone, {
          phone,
        });
      }

      if (uniqueRecipients.size === 0) {
        return json({ error: "Nenhum destinatario valido encontrado." }, 400);
      }

      const audienceFilter =
        body.audience_filter && typeof body.audience_filter === "object"
          ? body.audience_filter as Record<string, unknown>
          : {};

      const now = new Date().toISOString();
      const effectiveScheduledFor = scheduledFor ?? now;

      const { data, error } = await supabaseAdmin
        .from("pluguechat_broadcasts")
        .insert({
          company_id: companyId,
          name: broadcastName,
          template_id: templateId,
          template_name: nullableString(body.template_name),
          audience_filter: {
            ...audienceFilter,
            recipient_count: uniqueRecipients.size,
          },
          status: "scheduled",
          scheduled_for: effectiveScheduledFor,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        console.error("pluguechat-api create_broadcast error", error);
        return json({ error: "Erro ao criar disparo." }, 500);
      }

      const recipientRows = [...uniqueRecipients.values()].map((recipient) => ({
        broadcast_id: data.id,
        company_id: companyId,
        customer_id: null,
        phone: recipient.phone,
        parameters: {},
        status: "pending",
      }));

      const { error: recipientInsertError } = await supabaseAdmin
        .from("pluguechat_broadcast_recipients")
        .insert(recipientRows);

      if (recipientInsertError) {
        console.error("pluguechat-api broadcast recipients insert error", recipientInsertError);
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .delete()
          .eq("id", data.id)
          .eq("company_id", companyId);

        return json({ error: "Erro ao salvar destinatarios do disparo." }, 500);
      }

      return json({ ok: true, broadcast: data as Record<string, unknown> });
    }

    if (action === "cancel_broadcast") {
      const broadcastId = nullableString(body.broadcast_id) ?? nullableString(body.id);
      if (!broadcastId) {
        return json({ error: "broadcast_id required" }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("pluguechat_broadcasts")
        .update({
          status: "cancelled",
          cancel_reason: "manual",
          cancelled_at: new Date().toISOString(),
        })
        .eq("id", broadcastId)
        .eq("company_id", companyId)
        .in("status", ["draft", "scheduled"])
        .select("id")
        .maybeSingle();

      if (error) {
        console.error("pluguechat-api cancel_broadcast error", error);
        return json({ error: "Erro ao cancelar disparo." }, 500);
      }

      if (!data) {
        return json({ error: "broadcast_not_found_or_locked" }, 409);
      }

      return json({ ok: true });
    }

    if (action === "retry_queue_item") {
      const itemId = nullableString(body.item_id) ?? nullableString(body.queue_id);
      if (!itemId) {
        return json({ error: "item_id required" }, 400);
      }

      const retried = await resetFailedQueueItems(supabaseAdmin, companyId, itemId);
      if (retried === 0) {
        return json({ error: "queue_item_not_found_or_not_failed" }, 409);
      }

      const process = body.process_now === false
        ? null
        : await processPlugueChatQueueNow(supabaseAdmin);

      return json({ ok: true, retried, process });
    }

    if (action === "retry_failed_queue") {
      const retried = await resetFailedQueueItems(supabaseAdmin, companyId);
      const process = retried > 0 && body.process_now !== false
        ? await processPlugueChatQueueNow(supabaseAdmin)
        : null;

      return json({ ok: true, retried, process });
    }

    if (action === "process_queue") {
      const process = await processPlugueChatQueueNow(supabaseAdmin);
      return json({ ok: process.ok, process }, process.ok ? 200 : 502);
    }

    if (action === "clear_logs") {
      const { error } = await supabaseAdmin
        .from("pluguechat_message_logs")
        .delete()
        .eq("company_id", companyId);

      if (error) {
        console.error("pluguechat-api clear_logs error", error);
        return json({ error: error.message }, 500);
      }

      return json({ ok: true });
    }

    if (action === "clear_queue") {
      const { error } = await supabaseAdmin
        .from("pluguechat_message_queue")
        .delete()
        .eq("company_id", companyId);

      if (error) {
        console.error("pluguechat-api clear_queue error", error);
        return json({ error: error.message }, 500);
      }

      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action ?? ""}` }, 400);
  } catch (error) {
    const status = authErrorStatus(error);
    if (status === 500) {
      console.error("pluguechat-api unexpected error", error);
    }
    return json(
      { error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Erro interno." },
      status,
    );
  }
});
