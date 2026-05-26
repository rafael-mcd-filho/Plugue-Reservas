import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type WhatsAppChannel = "evolution" | "pluguechat_official";

const VALID_CHANNELS: WhatsAppChannel[] = ["evolution", "pluguechat_official"];

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = body.action as string;
    const companyId = body.company_id as string;

    if (!companyId) {
      return json({ error: "company_id required" }, 400);
    }

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, [
      "superadmin",
      "admin",
    ]);

    if (action === "switch") {
      const targetChannel = body.channel as WhatsAppChannel;
      const expectedChannel = body.expected_channel as WhatsAppChannel;

      if (!VALID_CHANNELS.includes(targetChannel)) {
        return json({ error: "Canal invalido." }, 400);
      }

      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("whatsapp_automation_channel")
        .eq("id", companyId)
        .single();

      const currentChannel = company?.whatsapp_automation_channel as WhatsAppChannel ?? "evolution";

      if (currentChannel !== expectedChannel) {
        return json({ error: "channel_mismatch", current: currentChannel }, 409);
      }

      if (currentChannel === targetChannel) {
        return json({ ok: true, channel: currentChannel });
      }

      if (targetChannel === "pluguechat_official") {
        if (!Deno.env.get("PLUGUECHAT_API_URL")) {
          return json({ error: "PLUGUECHAT_API_URL not configured" }, 500);
        }

        const { data: config, error: configError } = await supabaseAdmin
          .from("pluguechat_official_configs")
          .select("from_number, api_token_encrypted, status")
          .eq("company_id", companyId)
          .maybeSingle();

        if (configError) {
          console.error("whatsapp-automation-channel config load error", configError);
          return json({ error: "Erro ao carregar configuracao PlugueChat." }, 500);
        }

        if (!config?.from_number || !config?.api_token_encrypted || config.status !== "configured") {
          return json({ error: "pluguechat_not_configured" }, 400);
        }
      }

      const { error: updateError } = await supabaseAdmin
        .from("companies")
        .update({ whatsapp_automation_channel: targetChannel })
        .eq("id", companyId);

      if (updateError) {
        console.error("whatsapp-automation-channel switch update error", updateError);
        return json({ error: "Erro ao trocar canal." }, 500);
      }

      const now = new Date().toISOString();

      if (currentChannel === "evolution") {
        await supabaseAdmin
          .from("whatsapp_message_queue" as any)
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["pending"]);

        await supabaseAdmin
          .from("whatsapp_broadcasts" as any)
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["draft", "scheduled", "processing", "running"]);
      }

      if (currentChannel === "pluguechat_official") {
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["pending"]);

        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["draft", "scheduled", "processing"]);
      }

      return json({ ok: true, channel: targetChannel });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const status = authErrorStatus(error);
    if (status === 500) {
      console.error("whatsapp-automation-channel unexpected error", error);
    }
    return json(
      { error: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Erro interno." },
      status,
    );
  }
});
