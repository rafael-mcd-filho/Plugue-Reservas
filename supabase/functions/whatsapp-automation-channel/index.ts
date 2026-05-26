import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type WhatsAppChannel = "evolution" | "pluguechat_official";

const VALID_CHANNELS: WhatsAppChannel[] = ["evolution", "pluguechat_official"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json() as Record<string, unknown>;
    const action = body.action as string;
    const companyId = body.company_id as string;

    if (!companyId) {
      return new Response(JSON.stringify({ error: "company_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verifica se o usuário tem acesso à empresa (admin ou operator)
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("company_id", companyId)
      .in("role", ["admin", "operator"])
      .maybeSingle();

    const { data: isSuperAdmin } = await supabaseAdmin.rpc("has_role", {
      _user_id: user.id,
      _role: "superadmin",
    });

    if (!roleData && !isSuperAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ----------------------------------------------------------------
    // action: switch — troca o canal ativo e cancela filas do canal anterior
    // ----------------------------------------------------------------
    if (action === "switch") {
      const targetChannel = body.channel as WhatsAppChannel;
      const expectedChannel = body.expected_channel as WhatsAppChannel;

      if (!VALID_CHANNELS.includes(targetChannel)) {
        return new Response(JSON.stringify({ error: "Canal inválido." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Lê canal atual para validar expected_channel (proteção contra aba antiga)
      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("whatsapp_automation_channel")
        .eq("id", companyId)
        .single();

      const currentChannel = company?.whatsapp_automation_channel as WhatsAppChannel ?? "evolution";

      if (currentChannel !== expectedChannel) {
        return new Response(
          JSON.stringify({ error: "channel_mismatch", current: currentChannel }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (currentChannel === targetChannel) {
        return new Response(JSON.stringify({ ok: true, channel: currentChannel }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Atualiza canal ativo
      const { error: updateError } = await supabaseAdmin
        .from("companies")
        .update({ whatsapp_automation_channel: targetChannel })
        .eq("id", companyId);

      if (updateError) {
        console.error("whatsapp-automation-channel switch update error", updateError);
        return new Response(JSON.stringify({ error: "Erro ao trocar canal." }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cancela fila do canal anterior
      const now = new Date().toISOString();

      if (currentChannel === "evolution") {
        // Cancela fila do WhatsApp conectado
        await supabaseAdmin
          .from("whatsapp_message_queue" as any)
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["pending"]);

        // Cancela disparos do WhatsApp conectado
        await supabaseAdmin
          .from("whatsapp_broadcasts" as any)
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["draft", "scheduled", "processing", "running"]);
      }

      if (currentChannel === "pluguechat_official") {
        // Cancela fila do PlugueChat
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["pending"]);

        // Cancela disparos do PlugueChat
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("company_id", companyId)
          .in("status", ["draft", "scheduled", "processing"]);
      }

      return new Response(JSON.stringify({ ok: true, channel: targetChannel }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("whatsapp-automation-channel unexpected error", err);
    return new Response(JSON.stringify({ error: "Erro interno." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
