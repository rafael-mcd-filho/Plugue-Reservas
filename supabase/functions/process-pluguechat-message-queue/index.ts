import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildPlugueChatPayload,
  checkPlugueChatMessageStatus,
  classifyPlugueChatProviderStatus,
  getCompanyChannel,
  getPlugueChatCompanyConfig,
  sendPlugueChatMessage,
} from "../_shared/pluguechat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const BATCH_SIZE = 20;
const STATUS_CHECK_BATCH_SIZE = 30;
const SENT_RECHECK_WINDOW_DAYS = 7;

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

async function upsertPlugueChatLog(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  status: "sent" | "failed",
  providerStatus: string | null,
  errorDetails: string | null,
) {
  const { error } = await supabaseAdmin.from("pluguechat_message_logs").upsert(
    {
      queue_id: item.id,
      company_id: item.company_id,
      reservation_id: item.reservation_id ?? null,
      waitlist_id: item.waitlist_id ?? null,
      phone: item.phone,
      type: item.type,
      template_id: item.template_id,
      template_name: item.template_name ?? null,
      parameters: item.parameters ?? {},
      status,
      provider_message_id: item.provider_message_id ?? null,
      provider_status: providerStatus,
      error_details: errorDetails,
    },
    { onConflict: "queue_id" },
  );

  if (error) {
    console.error("pluguechat log upsert error", error);
  }
}

async function updateBroadcastRecipient(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  status: string,
  errorDetails: string | null = null,
) {
  if (item.type !== "broadcast" || typeof item.idempotency_key !== "string") return;

  const match = item.idempotency_key.match(/^pluguechat:broadcast:([^:]+):/);
  const broadcastId = match?.[1];
  if (!broadcastId) return;

  const { error } = await supabaseAdmin
    .from("pluguechat_broadcast_recipients")
    .update({
      queue_id: item.id,
      status,
      provider_message_id: item.provider_message_id ?? null,
      error_details: errorDetails,
    })
    .eq("broadcast_id", broadcastId)
    .eq("phone", item.phone);

  if (error) {
    console.error("pluguechat broadcast recipient update error", error);
  }
}

async function finalizeProviderQueuedMessage(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  finalStatus: "sent" | "failed",
  providerStatus: string | null,
  errorDetails: string | null,
  checkedAt: string,
) {
  await upsertPlugueChatLog(supabaseAdmin, item, finalStatus, providerStatus, errorDetails);

  await supabaseAdmin
    .from("pluguechat_message_queue")
    .update({
      status: finalStatus,
      provider_message_id: item.provider_message_id ?? null,
      provider_status_url: item.provider_status_url ?? null,
      provider_status: providerStatus,
      provider_status_checked_at: checkedAt,
      error_details: errorDetails,
      last_attempt_at: checkedAt,
    })
    .eq("id", item.id);

  await updateBroadcastRecipient(supabaseAdmin, item, finalStatus, errorDetails);
}

async function reconcileProviderQueuedMessages(supabaseAdmin: SupabaseAdmin, now: string) {
  const { data: providerQueuedItems, error } = await supabaseAdmin
    .from("pluguechat_message_queue")
    .select("*")
    .eq("status", "provider_queued")
    .order("provider_status_checked_at", { ascending: true })
    .limit(STATUS_CHECK_BATCH_SIZE);

  if (error) {
    console.error("pluguechat provider status fetch error", error);
    return { checked: 0, confirmedSent: 0, confirmedFailed: 0, waiting: 0, checkFailed: 0 };
  }

  const recheckCutoff = new Date(Date.parse(now) - SENT_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const remainingLimit = Math.max(0, STATUS_CHECK_BATCH_SIZE - (providerQueuedItems?.length ?? 0));
  const { data: sentWithoutProviderStatus, error: sentFetchError } = remainingLimit > 0
    ? await supabaseAdmin
      .from("pluguechat_message_queue")
      .select("*")
      .eq("status", "sent")
      .is("provider_status", null)
      .not("provider_message_id", "is", null)
      .gte("created_at", recheckCutoff)
      .order("last_attempt_at", { ascending: false })
      .limit(remainingLimit)
    : { data: [], error: null };

  if (sentFetchError) {
    console.error("pluguechat sent status recheck fetch error", sentFetchError);
  }

  const items = [...(providerQueuedItems ?? []), ...(sentWithoutProviderStatus ?? [])];

  let checked = 0;
  let confirmedSent = 0;
  let confirmedFailed = 0;
  let waiting = 0;
  let checkFailed = 0;
  const configCache = new Map<string, Awaited<ReturnType<typeof getPlugueChatCompanyConfig>>>();

  for (const item of items ?? []) {
    const expiresAt = item.expires_at ? Date.parse(item.expires_at) : Number.NaN;
    if (item.status === "provider_queued" && !Number.isNaN(expiresAt) && expiresAt <= Date.parse(now)) {
      await finalizeProviderQueuedMessage(
        supabaseAdmin,
        item,
        "failed",
        item.provider_status ?? "EXPIRED",
        item.error_details ?? "Tempo limite para confirmacao de envio excedido.",
        now,
      );
      confirmedFailed++;
      continue;
    }

    if (!item.provider_message_id) {
      await finalizeProviderQueuedMessage(
        supabaseAdmin,
        item,
        "failed",
        item.provider_status ?? "MISSING_MESSAGE_ID",
        "A PlugueChat aceitou a requisicao, mas nao retornou ID da mensagem para confirmar o status.",
        now,
      );
      confirmedFailed++;
      continue;
    }

    let config = configCache.get(item.company_id);
    if (config === undefined) {
      config = await getPlugueChatCompanyConfig(supabaseAdmin, item.company_id);
      configCache.set(item.company_id, config);
    }

    if (!config) {
      await supabaseAdmin
        .from("pluguechat_message_queue")
        .update({
          error_details: "Configuracao PlugueChat indisponivel para verificar status da mensagem.",
          provider_status_checked_at: now,
        })
        .eq("id", item.id);
      checkFailed++;
      continue;
    }

    const statusResult = await checkPlugueChatMessageStatus(
      config.apiUrl,
      config.apiToken,
      item.provider_message_id,
      item.provider_status_url ?? null,
    );
    checked++;

    if (!statusResult.ok) {
      await supabaseAdmin
        .from("pluguechat_message_queue")
        .update({
          error_details: statusResult.error,
          provider_status_checked_at: now,
        })
        .eq("id", item.id);
      checkFailed++;
      continue;
    }

    const providerStatus = statusResult.provider_status ?? item.provider_status ?? null;
    const providerStatusUrl = statusResult.provider_status_url ?? item.provider_status_url ?? null;
    const errorDetails = statusResult.failure_reason ?? null;

    if (statusResult.delivery_state === "sent") {
      const nextItem = {
        ...item,
        provider_message_id: statusResult.provider_message_id ?? item.provider_message_id,
        provider_status_url: providerStatusUrl,
      };
      await finalizeProviderQueuedMessage(supabaseAdmin, nextItem, "sent", providerStatus, null, now);
      confirmedSent++;
      continue;
    }

    if (statusResult.delivery_state === "failed") {
      const nextItem = {
        ...item,
        provider_message_id: statusResult.provider_message_id ?? item.provider_message_id,
        provider_status_url: providerStatusUrl,
      };
      await finalizeProviderQueuedMessage(
        supabaseAdmin,
        nextItem,
        "failed",
        providerStatus,
        errorDetails ?? `PlugueChat retornou status ${providerStatus ?? "FAILED"}.`,
        now,
      );
      confirmedFailed++;
      continue;
    }

    await supabaseAdmin
      .from("pluguechat_message_queue")
      .update({
        status: "provider_queued",
        provider_message_id: statusResult.provider_message_id ?? item.provider_message_id,
        provider_status: providerStatus,
        provider_status_url: providerStatusUrl,
        provider_status_checked_at: now,
        error_details: errorDetails,
      })
      .eq("id", item.id);

    waiting++;
  }

  return { checked, confirmedSent, confirmedFailed, waiting, checkFailed };
}

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
      .order("priority", { ascending: true })
      .order("scheduled_for", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("process-pluguechat-queue fetch error", fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!items || items.length === 0) {
      const providerStatusSummary = await reconcileProviderQueuedMessages(supabaseAdmin, now);

      return new Response(JSON.stringify({
        sent: 0,
        failed: 0,
        skipped: 0,
        waiting_provider: 0,
        total: 0,
        provider_status: providerStatusSummary,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let waitingProvider = 0;

    for (const item of items) {
      // Marca como em processamento para evitar reprocessamento paralelo
      const { data: claimedItem, error: claimError } = await supabaseAdmin
        .from("pluguechat_message_queue")
        .update({ status: "processing", last_attempt_at: now, attempts: item.attempts + 1 })
        .eq("id", item.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (claimError || !claimedItem) {
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
        const deliveryState = classifyPlugueChatProviderStatus(result.provider_status ?? null);
        const nextItem = {
          ...item,
          provider_message_id: result.provider_message_id ?? null,
          provider_status_url: result.provider_status_url ?? null,
        };

        if (deliveryState === "sent") {
          await finalizeProviderQueuedMessage(
            supabaseAdmin,
            nextItem,
            "sent",
            result.provider_status ?? null,
            null,
            now,
          );
          sent++;
          continue;
        }

        if (!result.provider_message_id) {
          await finalizeProviderQueuedMessage(
            supabaseAdmin,
            nextItem,
            "failed",
            result.provider_status ?? "MISSING_MESSAGE_ID",
            "A PlugueChat aceitou a requisicao, mas nao retornou ID da mensagem para confirmar o status.",
            now,
          );
          failed++;
          continue;
        }

        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({
            status: "provider_queued",
            provider_message_id: result.provider_message_id,
            provider_status: result.provider_status ?? null,
            provider_status_url: result.provider_status_url ?? null,
            provider_status_checked_at: now,
            error_details: null,
          })
          .eq("id", item.id);

        await updateBroadcastRecipient(
          supabaseAdmin,
          {
            ...item,
            provider_message_id: result.provider_message_id,
          },
          "processing",
          null,
        );

        waitingProvider++;
      } else {
        const isFinal = item.attempts + 1 >= item.max_attempts;
        const nextItem = {
          ...item,
          provider_message_id: result.provider_message_id ?? null,
          provider_status_url: result.provider_status_url ?? null,
        };

        await supabaseAdmin
          .from("pluguechat_message_queue")
          .update({
            status: isFinal ? "failed" : "pending",
            provider_message_id: result.provider_message_id ?? null,
            provider_status: result.provider_status ?? null,
            provider_status_url: result.provider_status_url ?? null,
            provider_status_checked_at: now,
            error_details: result.error,
            last_attempt_at: now,
          })
          .eq("id", item.id);

        if (isFinal) {
          await upsertPlugueChatLog(
            supabaseAdmin,
            nextItem,
            "failed",
            result.provider_status ?? null,
            result.error,
          );
          await updateBroadcastRecipient(supabaseAdmin, nextItem, "failed", result.error);
        }

        failed++;
      }
    }

    const providerStatusSummary = await reconcileProviderQueuedMessages(supabaseAdmin, now);

    return new Response(JSON.stringify({
      sent,
      failed,
      skipped,
      waiting_provider: waitingProvider,
      total: items.length,
      provider_status: providerStatusSummary,
    }), {
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
