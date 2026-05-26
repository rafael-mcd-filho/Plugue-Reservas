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

      const templateId = nullableString(body.template_id);
      if (!templateId) {
        return json({ error: "template_id required" }, 400);
      }

      const scheduledFor = nullableString(body.scheduled_for);
      if (scheduledFor && Number.isNaN(Date.parse(scheduledFor))) {
        return json({ error: "scheduled_for invalid" }, 400);
      }

      const audienceFilter =
        body.audience_filter && typeof body.audience_filter === "object"
          ? body.audience_filter as Record<string, unknown>
          : {};

      const { data, error } = await supabaseAdmin
        .from("pluguechat_broadcasts")
        .insert({
          company_id: companyId,
          template_id: templateId,
          template_name: nullableString(body.template_name),
          audience_filter: audienceFilter,
          status: scheduledFor ? "scheduled" : "draft",
          scheduled_for: scheduledFor,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        console.error("pluguechat-api create_broadcast error", error);
        return json({ error: "Erro ao criar disparo." }, 500);
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
