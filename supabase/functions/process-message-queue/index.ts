import {
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";
import {
  formatPhoneForWhatsApp,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const requestedCompanyId = typeof body.company_id === "string" ? body.company_id : null;
    const internalJob = await isAuthorizedInternalJob(req);

    if (!internalJob) {
      if (!requestedCompanyId) {
        return new Response(JSON.stringify({ error: "company_id e obrigatorio" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      await assertUserCanAccessCompany(req, requestedCompanyId, ["superadmin", "admin", "operator"]);
    }

    const supabaseAdmin = createSupabaseAdminClient();

    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const processingQuery = supabaseAdmin
      .from("whatsapp_message_queue")
      .select("id")
      .eq("status", "pending")
      .gte("last_attempt_at", threeMinAgo)
      .limit(1);

    const { data: processing } = requestedCompanyId
      ? await processingQuery.eq("company_id", requestedCompanyId)
      : await processingQuery;

    if (processing && processing.length > 0) {
      return new Response(JSON.stringify({ skipped: true, reason: "another_process_running" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("key, value")
      .in("key", ["evolution_api_url", "evolution_api_token"]);

    const evolutionUrl = settings?.find((setting: any) => setting.key === "evolution_api_url")?.value?.replace(/\/+$/, "");
    const evolutionToken = settings?.find((setting: any) => setting.key === "evolution_api_token")?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ skipped: true, reason: "Evolution API not configured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const instancesQuery = supabaseAdmin
      .from("company_whatsapp_instances")
      .select("company_id, instance_name, status")
      .eq("status", "connected");

    const { data: instances } = requestedCompanyId
      ? await instancesQuery.eq("company_id", requestedCompanyId)
      : await instancesQuery;

    if (!instances || instances.length === 0) {
      return new Response(JSON.stringify({ processed: 0, reason: "no_connected_instances" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const connectedCompanyIds = instances.map((instance) => instance.company_id);
    const instanceMap = new Map(instances.map((instance) => [instance.company_id, instance.instance_name]));

    await supabaseAdmin
      .from("whatsapp_message_queue")
      .update({
        status: "failed",
        error_details: serializeWhatsAppFailure({
          code: "unknown_error",
          title: "Mensagem expirada na fila",
          message: "A mensagem expirou na fila após 2 horas sem envio.",
        }),
      })
      .eq("status", "pending")
      .lt("expires_at", new Date().toISOString())
      .in("company_id", connectedCompanyIds);

    const queueQuery = supabaseAdmin
      .from("whatsapp_message_queue")
      .select("*")
      .in("company_id", connectedCompanyIds)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(10);

    const { data: pendingMessages } = await queueQuery;

    if (!pendingMessages || pendingMessages.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;

    for (const message of pendingMessages) {
      const instanceName = instanceMap.get(message.company_id);
      if (!instanceName) continue;

      await supabaseAdmin
        .from("whatsapp_message_queue")
        .update({ last_attempt_at: new Date().toISOString() })
        .eq("id", message.id);

      if (message.reservation_id) {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: alreadySent } = await supabaseAdmin
          .from("whatsapp_message_logs")
          .select("id")
          .eq("company_id", message.company_id)
          .eq("reservation_id", message.reservation_id)
          .eq("type", message.type)
          .eq("status", "sent")
          .gte("created_at", fiveMinAgo)
          .limit(1);

        if (alreadySent && alreadySent.length > 0) {
          await supabaseAdmin
            .from("whatsapp_message_queue")
            .update({
              status: "sent",
              error_details: serializeWhatsAppFailure({
                code: "unknown_error",
                title: "Mensagem ja enviada",
                message: "A fila identificou um envio recente e marcou esta mensagem como concluida sem reenviar.",
              }),
            })
            .eq("id", message.id);
          continue;
        }
      }

      try {
        const responseData = await sendWhatsAppText(
          evolutionUrl,
          evolutionToken,
          instanceName,
          formatPhoneForWhatsApp(message.phone),
          message.message,
        );

        if (responseData.ok) {
          await supabaseAdmin
            .from("whatsapp_message_queue")
            .update({
              status: "sent",
              last_attempt_at: new Date().toISOString(),
              attempts: message.attempts + 1,
            })
            .eq("id", message.id);

          await supabaseAdmin.from("whatsapp_message_logs").insert({
            company_id: message.company_id,
            reservation_id: message.reservation_id,
            phone: message.phone,
            message: message.message,
            type: message.type,
            status: "sent",
          });

          sent++;
        } else {
          const nextAttempts = message.attempts + 1;
          const serializedError = serializeWhatsAppFailure(responseData.error);
          await supabaseAdmin
            .from("whatsapp_message_queue")
            .update({
              attempts: nextAttempts,
              last_attempt_at: new Date().toISOString(),
              error_details: serializedError,
              status: nextAttempts >= message.max_attempts ? "failed" : "pending",
            })
            .eq("id", message.id);
          failed++;
        }
      } catch (error) {
        const nextAttempts = message.attempts + 1;
        await supabaseAdmin
          .from("whatsapp_message_queue")
          .update({
            attempts: nextAttempts,
            last_attempt_at: new Date().toISOString(),
            error_details: serializeWhatsAppFailure({
              code: "unknown_error",
              title: "Falha ao processar a fila",
              message: error instanceof Error ? error.message : "Erro desconhecido ao processar a fila.",
            }),
            status: nextAttempts >= message.max_attempts ? "failed" : "pending",
          })
          .eq("id", message.id);
        failed++;
      }
    }

    return new Response(JSON.stringify({ processed: pendingMessages.length, sent, failed }), {
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
