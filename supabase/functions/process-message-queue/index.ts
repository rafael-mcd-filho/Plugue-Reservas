import {
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";
import {
  formatPhoneForWhatsApp,
  getWhatsAppAcceptedLogStatus,
  sendWhatsAppText,
  serializeWhatsAppFailure,
  sleep,
  WHATSAPP_ACCEPTED_LOG_STATUSES,
} from "../_shared/whatsapp.ts";
import {
  checkWhatsAppCircuit,
  recordWhatsAppFailure,
  recordWhatsAppSuccess,
} from "../_shared/whatsapp-circuit.ts";

const DELIVERY_JITTER_MIN_MS = 40_000;
const DELIVERY_JITTER_MAX_MS = 80_000;
const BATCH_SIZE = 3;
const CANDIDATE_LIMIT = 12;
const MAX_INVOCATION_SECONDS = 140;
const DEADLINE_BUFFER_MS = 10_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

async function reserveDeliverySlot(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
  instanceName: string,
): Promise<{ canSend: boolean; waitUntil: Date }> {
  const { data, error } = await supabaseAdmin.rpc("reserve_whatsapp_delivery_slot", {
    _company_id: companyId,
    _instance_name: instanceName,
    _min_delay_seconds: Math.round(DELIVERY_JITTER_MIN_MS / 1000),
    _max_delay_seconds: Math.round(DELIVERY_JITTER_MAX_MS / 1000),
  });

  if (error) {
    throw new Error(`Erro ao reservar janela de envio do WhatsApp: ${error.message}`);
  }

  const slot = Array.isArray(data) ? data[0] : data;
  return {
    canSend: slot?.can_send === true,
    waitUntil: slot?.wait_until ? new Date(slot.wait_until) : new Date(),
  };
}

async function waitForDeliverySlot(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  messageId: string,
  companyId: string,
  instanceName: string,
  invocationDeadline: number,
): Promise<boolean> {
  const slot = await reserveDeliverySlot(supabaseAdmin, companyId, instanceName);
  if (slot.canSend) return true;

  let deferUntil = slot.waitUntil;
  const waitMs = slot.waitUntil.getTime() - Date.now();
  if (
    waitMs > 0 &&
    waitMs <= DELIVERY_JITTER_MAX_MS + 5_000 &&
    Date.now() + waitMs + DEADLINE_BUFFER_MS < invocationDeadline
  ) {
    await sleep(waitMs);
    const nextSlot = await reserveDeliverySlot(supabaseAdmin, companyId, instanceName);
    if (nextSlot.canSend) return true;
    deferUntil = nextSlot.waitUntil;
  }

  await supabaseAdmin
    .from("whatsapp_message_queue")
    .update({
      status: "pending",
      scheduled_for: deferUntil.toISOString(),
      error_details: null,
    })
    .eq("id", messageId)
    .eq("status", "processing");

  return false;
}

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
    const invocationDeadline = Date.now() + MAX_INVOCATION_SECONDS * 1000;
    const nowIso = new Date().toISOString();
    let expireQuery = supabaseAdmin
      .from("whatsapp_message_queue")
      .update({
        status: "expired",
        error_details: serializeWhatsAppFailure({
          code: "unknown_error",
          title: "Mensagem expirada na fila",
          message: "A janela util de envio da mensagem expirou antes do processamento.",
        }),
      })
      .eq("status", "pending")
      .lt("expires_at", nowIso);

    if (requestedCompanyId) {
      expireQuery = expireQuery.eq("company_id", requestedCompanyId);
    }

    await expireQuery;

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

    const { data: evolutionCompanies } = await supabaseAdmin
      .from("companies")
      .select("id")
      .in("id", connectedCompanyIds)
      .eq("whatsapp_automation_channel", "evolution")
      // The async company-deletion pipeline drains this queue itself in
      // batches; skip companies it's actively working on.
      .is("deletion_requested_at", null);

    const activeEvolutionCompanyIds = new Set((evolutionCompanies ?? []).map((company) => company.id));
    const activeEvolutionInstances = instances.filter((instance) => activeEvolutionCompanyIds.has(instance.company_id));

    if (activeEvolutionInstances.length === 0) {
      return new Response(JSON.stringify({ processed: 0, reason: "no_active_evolution_channel" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const instanceMap = new Map(activeEvolutionInstances.map((instance) => [instance.company_id, instance.instance_name]));

    const pausedCompanyIds: string[] = [];
    const eligibleCompanyIds: string[] = [];

    for (const companyId of activeEvolutionCompanyIds) {
      const circuit = await checkWhatsAppCircuit(supabaseAdmin, companyId);
      if (circuit.open) {
        pausedCompanyIds.push(companyId);
      } else {
        eligibleCompanyIds.push(companyId);
      }
    }

    if (eligibleCompanyIds.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, reason: "circuit_breaker_open", paused_company_ids: pausedCompanyIds }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    await supabaseAdmin
      .from("whatsapp_message_queue")
      .update({
        status: "pending",
        error_details: null,
      })
      .in("company_id", eligibleCompanyIds)
      .eq("status", "processing")
      .lt("last_attempt_at", new Date(Date.now() - 3 * 60 * 1000).toISOString());

    const queueQuery = supabaseAdmin
      .from("whatsapp_message_queue")
      .select("*")
      .in("company_id", eligibleCompanyIds)
      .eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .gt("expires_at", new Date().toISOString())
      .order("priority", { ascending: true })
      .order("scheduled_for", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(CANDIDATE_LIMIT);

    const { data: pendingMessages } = await queueQuery;

    if (!pendingMessages || pendingMessages.length === 0) {
      return new Response(JSON.stringify({ processed: 0, paused_company_ids: pausedCompanyIds }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;
    let circuitTripped = false;
    let processed = 0;
    let deferred = 0;

    for (let index = 0; index < pendingMessages.length; index++) {
      if (processed >= BATCH_SIZE || Date.now() >= invocationDeadline) {
        break;
      }

      const message = pendingMessages[index];
      const instanceName = instanceMap.get(message.company_id);
      if (!instanceName) continue;

      const { data: claimedMessage } = await supabaseAdmin
        .from("whatsapp_message_queue")
        .update({
          status: "processing",
          last_attempt_at: new Date().toISOString(),
          error_details: null,
        })
        .eq("id", message.id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();

      if (!claimedMessage) {
        continue;
      }

      const activeMessage = claimedMessage as typeof message;
      const phone = formatPhoneForWhatsApp(activeMessage.phone);

      const runtimeCircuit = await checkWhatsAppCircuit(supabaseAdmin, activeMessage.company_id);
      if (runtimeCircuit.open) {
        circuitTripped = true;
        await supabaseAdmin
          .from("whatsapp_message_queue")
          .update({ status: "pending" })
          .eq("id", activeMessage.id)
          .eq("status", "processing");
        continue;
      }

      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const duplicateLogQuery = supabaseAdmin
        .from("whatsapp_message_logs")
        .select("id")
        .eq("company_id", activeMessage.company_id)
        .eq("type", activeMessage.type)
        .in("status", [...WHATSAPP_ACCEPTED_LOG_STATUSES])
        .gte("created_at", fiveMinAgo)
        .limit(1);

      const { data: alreadyAccepted } = activeMessage.reservation_id
        ? await duplicateLogQuery.eq("reservation_id", activeMessage.reservation_id)
        : await duplicateLogQuery
          .eq("phone", phone)
          .eq("message", activeMessage.message);

      if (alreadyAccepted && alreadyAccepted.length > 0) {
        await supabaseAdmin
          .from("whatsapp_message_queue")
          .update({
            status: "sent",
            error_details: serializeWhatsAppFailure({
              code: "unknown_error",
              title: "Mensagem ja aceita",
              message: "A fila identificou uma mensagem aceita recentemente pela Evolution e marcou esta entrada como concluida sem reenviar.",
            }),
          })
          .eq("id", activeMessage.id);
        processed++;
        continue;
      }

      const slotReady = await waitForDeliverySlot(
        supabaseAdmin,
        activeMessage.id,
        activeMessage.company_id,
        instanceName,
        invocationDeadline,
      );

      if (!slotReady) {
        deferred++;
        continue;
      }

      processed++;

      try {
        const responseData = await sendWhatsAppText(
          evolutionUrl,
          evolutionToken,
          instanceName,
          phone,
          activeMessage.message,
        );

        if (responseData.ok) {
          const logStatus = getWhatsAppAcceptedLogStatus(responseData);
          await supabaseAdmin
            .from("whatsapp_message_queue")
            .update({
              status: "sent",
              last_attempt_at: new Date().toISOString(),
              attempts: activeMessage.attempts + 1,
            })
            .eq("id", activeMessage.id);

          await supabaseAdmin.from("whatsapp_message_logs").insert({
            company_id: activeMessage.company_id,
            reservation_id: activeMessage.reservation_id,
            phone: activeMessage.phone,
            message: activeMessage.message,
            type: activeMessage.type,
            status: logStatus,
          });

          await recordWhatsAppSuccess(supabaseAdmin, activeMessage.company_id);
          sent++;
        } else {
          const nextAttempts = activeMessage.attempts + 1;
          const serializedError = serializeWhatsAppFailure(responseData.error);
          await supabaseAdmin
            .from("whatsapp_message_queue")
            .update({
              attempts: nextAttempts,
              last_attempt_at: new Date().toISOString(),
              error_details: serializedError,
              status: nextAttempts >= activeMessage.max_attempts ? "failed" : "pending",
            })
            .eq("id", activeMessage.id);
          const nextCircuit = await recordWhatsAppFailure(supabaseAdmin, activeMessage.company_id, responseData.error);
          if (nextCircuit.open) {
            circuitTripped = true;
          }
          failed++;
        }
      } catch (error) {
        const nextAttempts = activeMessage.attempts + 1;
        const failureDetails = {
          code: "unknown_error" as const,
          title: "Falha ao processar a fila",
          message: error instanceof Error ? error.message : "Erro desconhecido ao processar a fila.",
          provider_status: null,
          provider_message: null,
          raw: null,
        };
        await supabaseAdmin
          .from("whatsapp_message_queue")
          .update({
            attempts: nextAttempts,
            last_attempt_at: new Date().toISOString(),
            error_details: serializeWhatsAppFailure(failureDetails),
            status: nextAttempts >= activeMessage.max_attempts ? "failed" : "pending",
          })
          .eq("id", activeMessage.id);
        const nextCircuit = await recordWhatsAppFailure(supabaseAdmin, activeMessage.company_id, failureDetails);
        if (nextCircuit.open) {
          circuitTripped = true;
        }
        failed++;
      }

      if (circuitTripped) {
        break;
      }
    }

    return new Response(
      JSON.stringify({
        processed,
        sent,
        failed,
        deferred,
        circuit_tripped: circuitTripped,
        paused_company_ids: pausedCompanyIds,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
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
