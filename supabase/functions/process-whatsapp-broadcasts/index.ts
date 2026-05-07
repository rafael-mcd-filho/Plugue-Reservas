import {
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";
import {
  formatPhoneForWhatsApp,
  getWhatsAppAcceptedLogStatus,
  randomIntInRange,
  sendWhatsAppMedia,
  sendWhatsAppText,
  serializeWhatsAppFailure,
  sleep,
  type WhatsAppFailureDetails,
} from "../_shared/whatsapp.ts";
import {
  checkWhatsAppCircuit,
  recordWhatsAppFailure,
  recordWhatsAppSuccess,
} from "../_shared/whatsapp-circuit.ts";

const BATCH_SIZE = 3;
const MAX_INVOCATION_SECONDS = 140;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const SUPPORTED_BROADCAST_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

interface BroadcastRow {
  id: string;
  company_id: string;
  message: string;
  image_url: string | null;
  delay_min_seconds: number;
  delay_max_seconds: number;
  status: string;
  started_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  cancelled_count: number;
}

interface RecipientRow {
  id: string;
  broadcast_id: string;
  company_id: string;
  reservation_id: string | null;
  phone: string;
  phone_normalized?: string | null;
  guest_name: string | null;
  status?: string;
  attempts: number;
  max_attempts: number;
}

function mimeTypeFromUrl(url: string): { mime: string; ext: string } {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  if (lower.endsWith(".png")) return { mime: "image/png", ext: "png" };
  if (lower.endsWith(".webp")) return { mime: "image/webp", ext: "webp" };
  if (lower.endsWith(".gif")) return { mime: "image/gif", ext: "gif" };
  return { mime: "image/jpeg", ext: "jpg" };
}

function normalizeMimeType(value: string | null | undefined) {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

function isSupportedBroadcastImageMime(value: string | null | undefined) {
  return SUPPORTED_BROADCAST_IMAGE_MIME_TYPES.has(normalizeMimeType(value));
}

function extensionFromMimeType(value: string) {
  return normalizeMimeType(value) === "image/png" ? "png" : "jpg";
}

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const mime = normalizeMimeType(res.headers.get("content-type")) || "application/octet-stream";
    return { base64: btoa(binary), mime };
  } catch {
    return null;
  }
}

async function markBroadcastCompletedIfDone(supabase: any, broadcastId: string) {
  const { count } = await supabase
    .from("whatsapp_broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .in("status", ["pending", "processing"]);

  if ((count ?? 0) === 0) {
    await supabase
      .from("whatsapp_broadcasts")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", broadcastId)
      .eq("status", "running");
  }
}

async function syncBroadcastCounts(supabase: any, broadcastId: string) {
  const { data: totals, error: totalsError } = await supabase
    .from("whatsapp_broadcast_recipients")
    .select("status")
    .eq("broadcast_id", broadcastId);

  if (totalsError) {
    console.warn(`[broadcast] failed to load recipient counts for ${broadcastId}: ${totalsError.message}`);
    return;
  }

  const counts = {
    total_recipients: 0,
    sent_count: 0,
    failed_count: 0,
    skipped_count: 0,
    cancelled_count: 0,
  };

  for (const row of totals ?? []) {
    counts.total_recipients++;
    if (row.status === "sent") counts.sent_count++;
    else if (row.status === "failed") counts.failed_count++;
    else if (row.status === "skipped") counts.skipped_count++;
    else if (row.status === "cancelled") counts.cancelled_count++;
  }

  const { error: updateError } = await supabase
    .from("whatsapp_broadcasts")
    .update(counts)
    .eq("id", broadcastId);

  if (updateError) {
    console.warn(`[broadcast] failed to update counts for ${broadcastId}: ${updateError.message}`);
  }
}

async function processBroadcast(
  supabase: any,
  broadcast: BroadcastRow,
  evolutionUrl: string,
  evolutionToken: string,
  instanceName: string,
  invocationDeadline: number,
): Promise<{ sent: number; failed: number; skipped: number; circuitTripped: boolean }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let circuitTripped = false;

  await supabase
    .from("whatsapp_broadcast_recipients")
    .update({ status: "pending" })
    .eq("broadcast_id", broadcast.id)
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  if (!broadcast.started_at) {
    await supabase
      .from("whatsapp_broadcasts")
      .update({ started_at: new Date().toISOString() })
      .eq("id", broadcast.id)
      .is("started_at", null);
  }

  const { data: recipients } = await supabase
    .from("whatsapp_broadcast_recipients")
    .select("*")
    .eq("broadcast_id", broadcast.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const recipientList: RecipientRow[] = recipients ?? [];

  for (let index = 0; index < recipientList.length; index++) {
    if (Date.now() >= invocationDeadline) break;

    const recipient = recipientList[index];
    const { data: claimedRecipient } = await supabase
      .from("whatsapp_broadcast_recipients")
      .update({ status: "processing", error_details: null })
      .eq("id", recipient.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (!claimedRecipient) {
      continue;
    }

    const activeRecipient = claimedRecipient as RecipientRow;

    const { data: broadcastCheck } = await supabase
      .from("whatsapp_broadcasts")
      .select("status")
      .eq("id", broadcast.id)
      .maybeSingle();

    if (broadcastCheck?.status === "cancelled" || broadcastCheck?.status === "paused") {
      break;
    }

    if (index > 0) {
      const minMs = Math.max(0, broadcast.delay_min_seconds) * 1000;
      const maxMs = Math.max(minMs, broadcast.delay_max_seconds * 1000);
      await sleep(randomIntInRange(minMs, maxMs));
    }

    const runtimeCircuit = await checkWhatsAppCircuit(supabase, broadcast.company_id);
    if (runtimeCircuit.open) {
      circuitTripped = true;
      break;
    }

    const phone = formatPhoneForWhatsApp(activeRecipient.phone || "");
    if (!phone) {
      const failureDetails: WhatsAppFailureDetails = {
        code: "invalid_payload",
        title: "Telefone invalido",
        message: "O destinatario nao possui um telefone valido para envio.",
        provider_status: null,
        provider_message: null,
        raw: null,
      };
      await supabase
        .from("whatsapp_broadcast_recipients")
        .update({
          status: "skipped",
          error_details: serializeWhatsAppFailure(failureDetails),
          attempts: activeRecipient.attempts + 1,
        })
        .eq("id", activeRecipient.id);
      skipped++;
      continue;
    }

    let result;
    try {
      if (broadcast.image_url) {
        const { mime: mimeFromUrl, ext } = mimeTypeFromUrl(broadcast.image_url);
        const imageData = await fetchImageAsBase64(broadcast.image_url);
        const mediaSource = imageData ? imageData.base64 : broadcast.image_url;
        const fetchedMime = normalizeMimeType(imageData?.mime);
        const actualMime = fetchedMime.startsWith("image/") ? fetchedMime : mimeFromUrl;
        console.log(`[broadcast] image_url=${broadcast.image_url} | fetched=${!!imageData} | mime=${actualMime} | base64len=${imageData ? imageData.base64.length : 0}`);
        if (!isSupportedBroadcastImageMime(actualMime)) {
          const failureDetails: WhatsAppFailureDetails = {
            code: "unsupported_media_type",
            title: "Formato de imagem nao suportado",
            message: "Envie a imagem em PNG ou JPG. WebP deve ser convertido antes do envio pelo WhatsApp.",
            provider_status: null,
            provider_message: `mimetype=${actualMime}`,
            raw: JSON.stringify({
              image_url: broadcast.image_url,
              detected_mime: actualMime,
              fallback_extension: ext,
            }),
          };
          console.warn(`[broadcast] unsupported image mime: ${actualMime} | image_url=${broadcast.image_url}`);
          result = { ok: false, error: failureDetails };
        } else {
          result = await sendWhatsAppMedia(
            evolutionUrl,
            evolutionToken,
            instanceName,
            phone,
            mediaSource,
            broadcast.message,
            { mediaType: "image", mimeType: actualMime, fileName: `broadcast.${extensionFromMimeType(actualMime)}` },
          );
        }
      } else {
        result = await sendWhatsAppText(
          evolutionUrl,
          evolutionToken,
          instanceName,
          phone,
          broadcast.message,
        );
      }

      if (result.ok) {
        const logStatus = getWhatsAppAcceptedLogStatus(result);

        const { data: insertedLog } = await supabase
          .from("whatsapp_message_logs")
          .insert({
            company_id: broadcast.company_id,
            reservation_id: activeRecipient.reservation_id,
            phone: activeRecipient.phone,
            message: broadcast.message,
            type: "broadcast",
            status: logStatus,
          })
          .select("id")
          .maybeSingle();

        await supabase
          .from("whatsapp_broadcast_recipients")
          .update({
            status: "sent",
            attempts: activeRecipient.attempts + 1,
            sent_at: new Date().toISOString(),
            message_log_id: insertedLog?.id ?? null,
            error_details: null,
          })
          .eq("id", activeRecipient.id);

        await recordWhatsAppSuccess(supabase, broadcast.company_id);
        sent++;
      } else {
        await supabase
          .from("whatsapp_broadcast_recipients")
          .update({
            status: "failed",
            attempts: activeRecipient.attempts + 1,
            error_details: serializeWhatsAppFailure(result.error),
          })
          .eq("id", activeRecipient.id);

        const nextCircuit = await recordWhatsAppFailure(supabase, broadcast.company_id, result.error);
        if (nextCircuit.open) circuitTripped = true;
        failed++;
      }
    } catch (error) {
      const failureDetails: WhatsAppFailureDetails = {
        code: "unknown_error",
        title: "Falha ao processar disparo",
        message: error instanceof Error ? error.message : "Erro desconhecido ao processar o disparo.",
        provider_status: null,
        provider_message: null,
        raw: null,
      };
      await supabase
        .from("whatsapp_broadcast_recipients")
        .update({
          status: "failed",
          attempts: activeRecipient.attempts + 1,
          error_details: serializeWhatsAppFailure(failureDetails),
        })
        .eq("id", activeRecipient.id);

      const nextCircuit = await recordWhatsAppFailure(supabase, broadcast.company_id, failureDetails);
      if (nextCircuit.open) circuitTripped = true;
      failed++;
    }

    if (circuitTripped) break;
  }

  await syncBroadcastCounts(supabase, broadcast.id);
  await markBroadcastCompletedIfDone(supabase, broadcast.id);

  return { sent, failed, skipped, circuitTripped };
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
      await assertUserCanAccessCompany(req, requestedCompanyId, ["superadmin", "admin"]);
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const invocationDeadline = Date.now() + MAX_INVOCATION_SECONDS * 1000;

    const { data: settings } = await supabaseAdmin
      .from("system_settings")
      .select("key, value")
      .in("key", ["evolution_api_url", "evolution_api_token"]);

    const evolutionUrl = settings?.find((s: any) => s.key === "evolution_api_url")?.value?.replace(/\/+$/, "");
    const evolutionToken = settings?.find((s: any) => s.key === "evolution_api_token")?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ skipped: true, reason: "Evolution API not configured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const runningQuery = supabaseAdmin
      .from("whatsapp_broadcasts")
      .select("*")
      .eq("status", "running")
      .order("created_at", { ascending: true })
      .limit(5);

    const { data: runningBroadcasts } = requestedCompanyId
      ? await runningQuery.eq("company_id", requestedCompanyId)
      : await runningQuery;

    if (!runningBroadcasts || runningBroadcasts.length === 0) {
      return new Response(JSON.stringify({ processed: 0, reason: "no_running_broadcasts" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const companyIds = Array.from(new Set(runningBroadcasts.map((b: BroadcastRow) => b.company_id)));

    const { data: instances } = await supabaseAdmin
      .from("company_whatsapp_instances")
      .select("company_id, instance_name, status")
      .in("company_id", companyIds)
      .eq("status", "connected");

    const instanceMap = new Map<string, string>();
    for (const inst of instances ?? []) {
      instanceMap.set(inst.company_id, inst.instance_name);
    }

    const results: Array<{ broadcast_id: string; sent: number; failed: number; skipped: number; circuit_tripped: boolean }> = [];

    for (const broadcast of runningBroadcasts as BroadcastRow[]) {
      if (Date.now() >= invocationDeadline) break;

      const instanceName = instanceMap.get(broadcast.company_id);
      if (!instanceName) {
        continue;
      }

      const circuit = await checkWhatsAppCircuit(supabaseAdmin, broadcast.company_id);
      if (circuit.open) {
        continue;
      }

      const result = await processBroadcast(
        supabaseAdmin,
        broadcast,
        evolutionUrl,
        evolutionToken,
        instanceName,
        invocationDeadline,
      );

      results.push({
        broadcast_id: broadcast.id,
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped,
        circuit_tripped: result.circuitTripped,
      });

      if (result.circuitTripped) break;
    }

    return new Response(
      JSON.stringify({ processed: results.length, results }),
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
