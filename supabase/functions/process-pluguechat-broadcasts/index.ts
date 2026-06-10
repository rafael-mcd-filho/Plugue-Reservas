import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { enqueuePlugueChatMessage, getCompanyChannel, normalizePhone } from "../_shared/pluguechat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const RECIPIENT_BATCH = 200;
const LEGACY_RECIPIENT_LIMIT = 500;

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDueBroadcast(broadcast: any, nowMs: number) {
  if (broadcast.status === "processing") return true;
  if (broadcast.status === "draft") return true;
  if (!broadcast.scheduled_for) return true;
  return Date.parse(broadcast.scheduled_for) <= nowMs;
}

function getRecipientParameters(recipient: any): Record<string, string> {
  const raw = recipient.parameters;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, String(value ?? "")]),
    );
  }

  return {};
}

async function countBroadcastRecipients(supabaseAdmin: SupabaseAdmin, broadcastId: string) {
  const { count, error } = await supabaseAdmin
    .from("pluguechat_broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId);

  if (error) throw error;
  return count ?? 0;
}

async function materializeLegacyRecipientsIfNeeded(supabaseAdmin: SupabaseAdmin, broadcast: any) {
  const existingCount = await countBroadcastRecipients(supabaseAdmin, broadcast.id);
  if (existingCount > 0) return existingCount;

  const { data: customers, error } = await supabaseAdmin
    .from("reservations")
    .select("guest_name, guest_phone")
    .eq("company_id", broadcast.company_id)
    .not("guest_phone", "is", null)
    .limit(LEGACY_RECIPIENT_LIMIT);

  if (error) throw error;

  const uniquePhones = new Map<string, { name: string; phone: string }>();
  for (const customer of customers ?? []) {
    const phone = normalizePhone(String(customer.guest_phone ?? ""));
    if (!phone || uniquePhones.has(phone)) continue;
    uniquePhones.set(phone, { name: String(customer.guest_name ?? ""), phone });
  }

  if (uniquePhones.size === 0) return 0;

  const rows = [...uniquePhones.values()].map((recipient) => ({
    broadcast_id: broadcast.id,
    company_id: broadcast.company_id,
    phone: recipient.phone,
    parameters: { nome: recipient.name },
    status: "pending",
  }));

  const { error: insertError } = await supabaseAdmin
    .from("pluguechat_broadcast_recipients")
    .insert(rows);

  if (insertError) throw insertError;
  return rows.length;
}

async function countPendingRecipients(supabaseAdmin: SupabaseAdmin, broadcastId: string) {
  const { count, error } = await supabaseAdmin
    .from("pluguechat_broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");

  if (error) throw error;
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return json({ error: "Nao autorizado" }, 401);
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);

    const { data: broadcasts, error: broadcastsError } = await supabaseAdmin
      .from("pluguechat_broadcasts")
      .select("*")
      .in("status", ["draft", "scheduled", "processing"])
      .order("scheduled_for", { ascending: true, nullsFirst: true })
      .limit(10);

    if (broadcastsError) throw broadcastsError;

    const readyBroadcasts = (broadcasts ?? []).filter((broadcast: any) => isDueBroadcast(broadcast, nowMs));

    if (readyBroadcasts.length === 0) {
      return json({ processed: 0, queued: 0 });
    }

    let totalQueued = 0;
    let processed = 0;

    for (const broadcast of readyBroadcasts) {
      const channel = await getCompanyChannel(supabaseAdmin, broadcast.company_id);
      if (channel !== "pluguechat_official") {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("id", broadcast.id);
        continue;
      }

      await supabaseAdmin
        .from("pluguechat_broadcasts")
        .update({ status: "processing", started_at: broadcast.started_at ?? now })
        .eq("id", broadcast.id)
        .in("status", ["draft", "scheduled", "processing"]);

      const totalRecipients = await materializeLegacyRecipientsIfNeeded(supabaseAdmin, broadcast);
      if (totalRecipients === 0) {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "completed", finished_at: now })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      const { data: recipients, error: recipientsError } = await supabaseAdmin
        .from("pluguechat_broadcast_recipients")
        .select("*")
        .eq("broadcast_id", broadcast.id)
        .eq("company_id", broadcast.company_id)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(RECIPIENT_BATCH);

      if (recipientsError) throw recipientsError;

      if (!recipients || recipients.length === 0) {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "completed", finished_at: now })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      for (const recipient of recipients) {
        const phone = normalizePhone(String(recipient.phone ?? ""));
        if (!phone) {
          await supabaseAdmin
            .from("pluguechat_broadcast_recipients")
            .update({ status: "failed", error_details: "Telefone invalido." })
            .eq("id", recipient.id);
          continue;
        }

        try {
          const result = await enqueuePlugueChatMessage(supabaseAdmin, {
            company_id: broadcast.company_id,
            phone,
            type: "broadcast",
            template_id: broadcast.template_id,
            template_name: broadcast.template_name ?? null,
            parameters: getRecipientParameters(recipient),
            idempotency_key: `pluguechat:broadcast:${broadcast.id}:${phone}`,
          });

          await supabaseAdmin
            .from("pluguechat_broadcast_recipients")
            .update({
              status: "queued",
              error_details: null,
            })
            .eq("id", recipient.id);

          if (result === "inserted") totalQueued++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Erro ao enfileirar destinatario.";
          await supabaseAdmin
            .from("pluguechat_broadcast_recipients")
            .update({
              status: "failed",
              error_details: message,
            })
            .eq("id", recipient.id);
        }
      }

      const remainingPending = await countPendingRecipients(supabaseAdmin, broadcast.id);
      if (remainingPending === 0) {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "completed", finished_at: now })
          .eq("id", broadcast.id);
      }

      processed++;
    }

    return json({ processed, queued: totalQueued });
  } catch (error: unknown) {
    console.error("process-pluguechat-broadcasts error", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return json({ error: msg }, 500);
  }
});
