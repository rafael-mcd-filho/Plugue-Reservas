import { getStoredPhoneLookupVariants, matchesCanonicalPhone, normalizeStoredPhoneE164 } from "../_shared/phone.ts";
import { getReservationChangeMessageEligibility } from "../_shared/reservation-change-notifications.ts";
import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { normalizePlugueChatPostVisitParameters } from "../_shared/post-visit.ts";
import {
  buildPlugueChatPayload,
  checkPlugueChatMessageStatus,
  classifyPlugueChatProviderStatus,
  getCompanyChannel,
  getPlugueChatCompanyConfig,
  sendPlugueChatMessage,
} from "../_shared/pluguechat.ts";
import { getWaitlistCallEligibility, isPlugueChatCallFailureRetryable } from "../_shared/waitlist-call-eligibility.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-support-impersonation, x-job-secret",
};

const BATCH_SIZE = 20;
const STATUS_CHECK_BATCH_SIZE = 30;
const SENT_RECHECK_WINDOW_DAYS = 7;

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

/** Ignore a late result for a call once its queue row belongs to another attempt. */
async function updateQueueAttempt(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  patch: Record<string, unknown>,
  expected: any = item,
): Promise<boolean> {
  let query = supabaseAdmin.from("pluguechat_message_queue").update(patch).eq("id", item.id);
  if (item.type !== "waitlist_called") {
    await query;
    return true;
  }
  query = query.eq("company_id", item.company_id).eq("status", expected.status);
  query = expected.provider_message_id
    ? query.eq("provider_message_id", expected.provider_message_id)
    : query.is("provider_message_id", null);
  if (expected.last_attempt_at) query = query.eq("last_attempt_at", expected.last_attempt_at);
  if (item.waitlist_called_at) query = query.eq("waitlist_called_at", item.waitlist_called_at);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) console.warn("Could not persist the current waitlist call attempt.");
  return !error && !!data;
}

async function upsertPlugueChatLog(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  status: "sent" | "failed",
  providerStatus: string | null,
  errorDetails: string | null,
) {
  if (item.type === "waitlist_called") {
    // The queue may have been retried after its final status was written. Let the
    // database lock and match the exact attempt before touching its durable log.
    const { error } = await supabaseAdmin.rpc("write_waitlist_call_notification_log", {
      _queue_id: item.id,
      _called_at: item.waitlist_called_at,
      _last_attempt_at: item.last_attempt_at,
      _status: status,
      _provider_message_id: item.provider_message_id ?? null,
    });
    if (error) console.warn("Could not persist the current waitlist call log.");
    return;
  }
  const { error } = await supabaseAdmin.from("pluguechat_message_logs").upsert(
    {
      queue_id: item.id,
      company_id: item.company_id,
      reservation_id: item.reservation_id ?? null,
      ...(item.reservation_change_revision ? { reservation_change_revision: item.reservation_change_revision } : {}),
      waitlist_id: item.waitlist_id ?? null,
      phone: normalizeStoredPhoneE164(item.phone_e164 ?? item.phone) || item.phone,
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

export async function updateBroadcastRecipient(
  supabaseAdmin: SupabaseAdmin,
  item: any,
  status: string,
  errorDetails: string | null = null,
) {
  if (item.type !== "broadcast" || typeof item.idempotency_key !== "string") return;

  const match = item.idempotency_key.match(/^pluguechat:broadcast:([^:]+):/);
  const broadcastId = match?.[1];
  if (!broadcastId) return;

  const phone = normalizeStoredPhoneE164(item.phone_e164 ?? item.phone);
  if (!phone) return;
  const variants = getStoredPhoneLookupVariants(phone).map((value) => JSON.stringify(value)).join(',');
  const { data: candidates, error: lookupError } = await supabaseAdmin
    .from('pluguechat_broadcast_recipients')
    .select('id, phone, phone_e164')
    .eq('broadcast_id', broadcastId)
    .eq('company_id', item.company_id)
    .or(`phone_e164.eq.${phone},phone.in.(${variants})`);
  if (lookupError) throw new Error(`Erro ao localizar destinatario: ${lookupError.message}`);
  const recipientIds = candidates?.filter((candidate) => matchesCanonicalPhone(candidate, phone)).map((candidate) => candidate.id) ?? [];
  if (recipientIds.length === 0) return;

  const { error } = await supabaseAdmin
    .from("pluguechat_broadcast_recipients")
    .update({
      queue_id: item.id,
      status,
      provider_message_id: item.provider_message_id ?? null,
      error_details: errorDetails,
    })
    .eq("broadcast_id", broadcastId)
    .eq("company_id", item.company_id)
    .in('id', recipientIds);

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
  expected: any = item,
) {
  const patch = {
    status: finalStatus,
    provider_message_id: item.provider_message_id ?? null,
    provider_status_url: item.provider_status_url ?? null,
    provider_status: providerStatus,
    provider_status_checked_at: checkedAt,
    error_details: errorDetails,
    last_attempt_at: checkedAt,
  };
  if (item.type === "waitlist_called") {
    // A stale reconciler must not write a log or overwrite a manually retried row.
    if (!await updateQueueAttempt(supabaseAdmin, item, patch, expected)) return false;
    await upsertPlugueChatLog(supabaseAdmin, { ...item, last_attempt_at: checkedAt }, finalStatus, providerStatus, errorDetails);
    return true;
  }
  await upsertPlugueChatLog(supabaseAdmin, item, finalStatus, providerStatus, errorDetails);

  await supabaseAdmin
    .from("pluguechat_message_queue")
    .update(patch)
    .eq("id", item.id);

  await updateBroadcastRecipient(supabaseAdmin, item, finalStatus, errorDetails);
  return true;
}

async function reconcileProviderQueuedMessages(supabaseAdmin: SupabaseAdmin, now: string, companyId: string | null, queueId: string | null = null) {
  let providerQueuedQuery = supabaseAdmin
    .from("pluguechat_message_queue")
    .select("*")
    .eq("status", "provider_queued")
    .order("provider_status_checked_at", { ascending: true })
    .limit(STATUS_CHECK_BATCH_SIZE);
  if (companyId) providerQueuedQuery = providerQueuedQuery.eq("company_id", companyId);
  if (queueId) providerQueuedQuery = providerQueuedQuery.eq("id", queueId);
  const { data: providerQueuedItems, error } = await providerQueuedQuery;

  if (error) {
    console.error("pluguechat provider status fetch error", error);
    return { checked: 0, confirmedSent: 0, confirmedFailed: 0, waiting: 0, checkFailed: 0 };
  }

  const recheckCutoff = new Date(Date.parse(now) - SENT_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const remainingLimit = Math.max(0, STATUS_CHECK_BATCH_SIZE - (providerQueuedItems?.length ?? 0));
  let sentQuery = supabaseAdmin
      .from("pluguechat_message_queue")
      .select("*")
      .eq("status", "sent")
      .is("provider_status", null)
      .not("provider_message_id", "is", null)
      .gte("created_at", recheckCutoff)
      .order("last_attempt_at", { ascending: false })
      .limit(remainingLimit);
  if (companyId) sentQuery = sentQuery.eq("company_id", companyId);
  if (queueId) sentQuery = sentQuery.eq("id", queueId);
  const { data: sentWithoutProviderStatus, error: sentFetchError } = remainingLimit > 0
    ? await sentQuery : { data: [], error: null };

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
      const finalized = await finalizeProviderQueuedMessage(
        supabaseAdmin,
        item,
        "failed",
        item.provider_status ?? "EXPIRED",
        item.error_details ?? "Tempo limite para confirmacao de envio excedido.",
        now,
      );
      if (finalized) confirmedFailed++;
      continue;
    }

    if (!item.provider_message_id) {
      const finalized = await finalizeProviderQueuedMessage(
        supabaseAdmin,
        item,
        "failed",
        item.provider_status ?? "MISSING_MESSAGE_ID",
        "A PlugueChat aceitou a requisicao, mas nao retornou ID da mensagem para confirmar o status.",
        now,
      );
      if (finalized) confirmedFailed++;
      continue;
    }

    let config = configCache.get(item.company_id);
    if (config === undefined) {
      config = await getPlugueChatCompanyConfig(supabaseAdmin, item.company_id);
      configCache.set(item.company_id, config);
    }

    if (!config) {
      const persisted = await updateQueueAttempt(supabaseAdmin, item, {
          error_details: "Configuracao PlugueChat indisponivel para verificar status da mensagem.",
          provider_status_checked_at: now,
        });
      if (persisted) checkFailed++;
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
      const persisted = await updateQueueAttempt(supabaseAdmin, item, {
          error_details: statusResult.error,
          provider_status_checked_at: now,
        });
      if (persisted) checkFailed++;
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
      const finalized = await finalizeProviderQueuedMessage(supabaseAdmin, nextItem, "sent", providerStatus, null, now, item);
      if (finalized) confirmedSent++;
      continue;
    }

    if (statusResult.delivery_state === "failed") {
      const nextItem = {
        ...item,
        provider_message_id: statusResult.provider_message_id ?? item.provider_message_id,
        provider_status_url: providerStatusUrl,
      };
      const finalized = await finalizeProviderQueuedMessage(
        supabaseAdmin,
        nextItem,
        "failed",
        providerStatus,
        errorDetails ?? `PlugueChat retornou status ${providerStatus ?? "FAILED"}.`,
        now,
        item,
      );
      if (finalized) confirmedFailed++;
      continue;
    }

    const persisted = await updateQueueAttempt(supabaseAdmin, item, {
        status: "provider_queued",
        provider_message_id: statusResult.provider_message_id ?? item.provider_message_id,
        provider_status: providerStatus,
        provider_status_url: providerStatusUrl,
        provider_status_checked_at: now,
        error_details: errorDetails,
      });

    if (persisted) waiting++;
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
    const body = await req.json().catch(() => ({}));
    const requestedCompanyId = typeof body.company_id === "string" && body.company_id.length > 0
      ? body.company_id : null;
    const requestedQueueId = typeof body.queue_id === "string" && body.queue_id.length > 0 ? body.queue_id : null;
    if (requestedQueueId && !requestedCompanyId) {
      return new Response(JSON.stringify({ error: "company_id e obrigatorio para uma mensagem especifica" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const now = new Date().toISOString();

    // Busca itens pendentes prontos para envio
    let itemsQuery = supabaseAdmin
      .from("pluguechat_message_queue")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_for", now)
      .gt("expires_at", now)
      .order("priority", { ascending: true })
      .order("scheduled_for", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (requestedCompanyId) itemsQuery = itemsQuery.eq("company_id", requestedCompanyId);
    if (requestedQueueId) itemsQuery = itemsQuery.eq("id", requestedQueueId);
    const { data: items, error: fetchError } = await itemsQuery;

    if (fetchError) {
      console.error("process-pluguechat-queue fetch error", fetchError);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!items || items.length === 0) {
      const providerStatusSummary = await reconcileProviderQueuedMessages(supabaseAdmin, now, requestedCompanyId, requestedQueueId);

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
      if (item.attempts >= item.max_attempts) {
        await supabaseAdmin.from("pluguechat_message_queue").update({ status: "failed" })
          .eq("id", item.id).eq("status", "pending");
        skipped++;
        continue;
      }
      // Marca como em processamento para evitar reprocessamento paralelo
      const { data: claimedItem, error: claimError } = await supabaseAdmin
        .from("pluguechat_message_queue")
        .update({ status: "processing", last_attempt_at: now, attempts: item.attempts + 1,
          ...(item.type === 'waitlist_called' ? { error_details: null, provider_message_id: null, provider_status: null, provider_status_url: null, provider_status_checked_at: null } : {}),
        })
        .eq("id", item.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (claimError || !claimedItem) {
        skipped++;
        continue;
      }
      const currentAttempt = {
        ...item, status: "processing", last_attempt_at: now,
        provider_message_id: item.type === "waitlist_called" ? null : item.provider_message_id,
      };

      // Valida que o canal ainda é PlugueChat
      const channel = await getCompanyChannel(supabaseAdmin, item.company_id);
      if (channel !== "pluguechat_official") {
        await updateQueueAttempt(supabaseAdmin, item, { status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now }, currentAttempt);
        skipped++;
        continue;
      }

      const callEligibility = await getWaitlistCallEligibility(supabaseAdmin, item, 'pluguechat_official');
      if (!callEligibility.eligible) {
        await updateQueueAttempt(supabaseAdmin, item, {
          status: callEligibility.reason === 'lookup_failed' ? 'pending' : 'cancelled',
          attempts: item.attempts,
          ...(callEligibility.reason === 'lookup_failed'
            ? { scheduled_for: new Date(Date.now() + 30_000).toISOString() }
            : { cancel_reason: callEligibility.reason, cancelled_at: now }),
        }, currentAttempt);
        skipped++;
        continue;
      }

      // Busca configuração da empresa
      const config = await getPlugueChatCompanyConfig(supabaseAdmin, item.company_id);
      if (!config) {
        await updateQueueAttempt(supabaseAdmin, item, {
            status: item.attempts + 1 >= item.max_attempts ? "failed" : "pending",
            error_details: "Configuração PlugueChat não encontrada ou incompleta.",
            last_attempt_at: now,
          }, currentAttempt);
        failed++;
        continue;
      }

      const payload = buildPlugueChatPayload(
        config.fromNumber,
        item.phone_e164 ?? item.phone,
        item.template_id,
        item.type === "post_visit"
          ? normalizePlugueChatPostVisitParameters(item.parameters ?? {})
          : item.parameters ?? {},
      );

      // Configuration may have changed while it was loaded above.
      const finalCallEligibility = await getWaitlistCallEligibility(supabaseAdmin, item, 'pluguechat_official');
      if (!finalCallEligibility.eligible) {
        await updateQueueAttempt(supabaseAdmin, item, {
          status: finalCallEligibility.reason === 'lookup_failed' ? 'pending' : 'cancelled',
          attempts: item.attempts,
          ...(finalCallEligibility.reason === 'lookup_failed'
            ? { scheduled_for: new Date(Date.now() + 30_000).toISOString() }
            : { cancel_reason: finalCallEligibility.reason, cancelled_at: new Date().toISOString() }),
        }, currentAttempt);
        skipped++;
        continue;
      }

      const reservationEligibility = await getReservationChangeMessageEligibility(supabaseAdmin, item);
      if (!reservationEligibility.eligible) {
        await updateQueueAttempt(supabaseAdmin, item, {
          status: reservationEligibility.reason === "lookup_failed" ? "pending" : "cancelled",
          attempts: item.attempts,
          ...(reservationEligibility.reason === "lookup_failed"
            ? { scheduled_for: new Date(Date.now() + 30_000).toISOString() }
            : { cancel_reason: "public_reservation_changed", cancelled_at: new Date().toISOString() }),
        }, currentAttempt);
        skipped++;
        continue;
      }

      const result = await sendPlugueChatMessage(config.apiUrl, config.apiToken, payload);

      if (result.ok) {
        const deliveryState = classifyPlugueChatProviderStatus(result.provider_status ?? null);
        const nextItem = {
          ...item,
          provider_message_id: result.provider_message_id ?? null,
          provider_status_url: result.provider_status_url ?? null,
        };

        if (deliveryState === "sent") {
          const finalized = await finalizeProviderQueuedMessage(
            supabaseAdmin,
            nextItem,
            "sent",
            result.provider_status ?? null,
            null,
            now,
            currentAttempt,
          );
          if (finalized) sent++;
          continue;
        }

        if (!result.provider_message_id) {
          const finalized = await finalizeProviderQueuedMessage(
            supabaseAdmin,
            nextItem,
            "failed",
            result.provider_status ?? "MISSING_MESSAGE_ID",
            "A PlugueChat aceitou a requisicao, mas nao retornou ID da mensagem para confirmar o status.",
            now,
            currentAttempt,
          );
          if (finalized) failed++;
          continue;
        }

        const persisted = await updateQueueAttempt(supabaseAdmin, item, {
            status: "provider_queued",
            provider_message_id: result.provider_message_id,
            provider_status: result.provider_status ?? null,
            provider_status_url: result.provider_status_url ?? null,
            provider_status_checked_at: now,
            error_details: null,
          }, currentAttempt);
        if (!persisted) continue;

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
        const isFinal = item.attempts + 1 >= item.max_attempts || (item.type === 'waitlist_called' && !isPlugueChatCallFailureRetryable(result));
        const nextItem = {
          ...item,
          provider_message_id: result.provider_message_id ?? null,
          provider_status_url: result.provider_status_url ?? null,
        };

        const persisted = await updateQueueAttempt(supabaseAdmin, item, {
            status: isFinal ? "failed" : "pending",
            provider_message_id: result.provider_message_id ?? null,
            provider_status: result.provider_status ?? null,
            provider_status_url: result.provider_status_url ?? null,
            provider_status_checked_at: now,
            error_details: result.error,
            last_attempt_at: now,
          }, currentAttempt);
        if (!persisted) continue;

        if (isFinal) {
          await upsertPlugueChatLog(
            supabaseAdmin,
            item.type === "waitlist_called" ? { ...nextItem, last_attempt_at: now } : nextItem,
            "failed",
            result.provider_status ?? null,
            result.error,
          );
          await updateBroadcastRecipient(supabaseAdmin, nextItem, "failed", result.error);
        }

        failed++;
      }
    }

    const providerStatusSummary = await reconcileProviderQueuedMessages(supabaseAdmin, now, requestedCompanyId, requestedQueueId);

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
