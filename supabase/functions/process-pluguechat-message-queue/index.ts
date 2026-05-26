import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildPlugueChatPayload,
  getCompanyChannel,
  getPlugueChatCompanyConfig,
  sendPlugueChatMessage,
} from "../_shared/pluguechat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const BATCH_SIZE = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const now = new Date().toISOString();

    // Busca itens pendentes prontos para envio
    const { data: items, error: fetchError } = await supabaseAdmin
      .from("pluguechat_message_queue")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_for", now)
      .gt("expires_at", now)
      .lt("attempts", 3)
      .order("scheduled_for", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("process-pluguechat-queue fetch error", fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!items || items.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0, skipped: 0, total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of items) {
      // Marca como em processamento para evitar reprocessamento paralelo
      const { error: claimError } = await supabaseAdmin
        .from("pluguechat_message_queue")
        .update({ status: "processing", last_attempt_at: now, attempts: item.attempts + 1 })
        .eq("id", item.id)
        .eq("status", "pending");

      if (claimError) {
        skipped++;
        continue;
      }

      // Valida que o canal ainda é PlugueChat
      const channel = await getCompanyChannel(supabaseAdmin, item.company_id);
      if (channel !== "pluguechat_official") {
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("id", item.id);
        skipped++;
        continue;
      }

      // Busca configuração da empresa
      const config = await getPlugueChatCompanyConfig(supabaseAdmin, item.company_id);
      if (!config) {
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({
            status: item.attempts + 1 >= item.max_attempts ? "failed" : "pending",
            error_details: "Configuração PlugueChat não encontrada ou incompleta.",
            last_attempt_at: now,
          })
          .eq("id", item.id);
        failed++;
        continue;
      }

      const payload = buildPlugueChatPayload(
        config.fromNumber,
        item.phone,
        item.template_id,
        item.parameters ?? {},
      );

      const result = await sendPlugueChatMessage(config.apiUrl, config.apiToken, payload);

      if (result.ok) {
        // Atualiza item como enviado
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({
            status: "sent",
            provider_message_id: result.provider_message_id ?? null,
            error_details: null,
          })
          .eq("id", item.id);

        // Grava log
        await supabaseAdmin.from("pluguechat_message_logs").insert({
          company_id: item.company_id,
          reservation_id: item.reservation_id ?? null,
          waitlist_id: item.waitlist_id ?? null,
          phone: item.phone,
          type: item.type,
          template_id: item.template_id,
          template_name: item.template_name ?? null,
          parameters: item.parameters ?? {},
          status: "sent",
          provider_message_id: result.provider_message_id ?? null,
          provider_status: null,
          error_details: null,
        });

        sent++;
      } else {
        const isFinal = item.attempts + 1 >= item.max_attempts;
        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({
            status: isFinal ? "failed" : "pending",
            error_details: result.error,
            last_attempt_at: now,
          })
          .eq("id", item.id);

        if (isFinal) {
          await supabaseAdmin.from("pluguechat_message_logs").insert({
            company_id: item.company_id,
            reservation_id: item.reservation_id ?? null,
            waitlist_id: item.waitlist_id ?? null,
            phone: item.phone,
            type: item.type,
            template_id: item.template_id,
            template_name: item.template_name ?? null,
            parameters: item.parameters ?? {},
            status: "failed",
            provider_message_id: null,
            provider_status: null,
            error_details: result.error,
          });
        }

        failed++;
      }
    }

    return new Response(JSON.stringify({ sent, failed, skipped, total: items.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("process-pluguechat-queue error", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
