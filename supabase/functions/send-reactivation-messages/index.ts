import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
  formatPhoneForWhatsApp,
} from "../_shared/whatsapp.ts";
import {
  buildReactivationParameters,
  enqueuePlugueChatMessage,
  getCompanyChannels,
  normalizePhone,
} from "../_shared/pluguechat.ts";
import { getFirstName } from "../_shared/names.ts";
import { formatDateKeyInTimeZone } from "../_shared/timezone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const AUTOMATION_TYPE = "reactivation_30d";
const REACTIVATION_DAYS = 30;
const PRIORITY_REACTIVATION = 90;
const REACTIVATION_WINDOW_START = "09:10";
const REACTIVATION_EXPIRES_AT = "18:00";

interface ReactivationCandidate {
  lead_key: string;
  company_id: string;
  guest_name: string | null;
  guest_phone: string | null;
  phone_normalized: string;
  last_visit_date: string;
  last_visit_source: string | null;
  days_since_visit: number;
}

interface DispatchClaim {
  id: string;
  dispatchKey: string;
}

function getLocalDateTime(date: string, time: string) {
  const [hours = "00", minutes = "00"] = time.split(":");
  return new Date(`${date}T${hours}:${minutes}:00-03:00`);
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return day && month && year ? `${day}/${month}/${year}` : date;
}

function buildReservationUrl(appOrigin: string | null, companySlug: string | null | undefined) {
  if (!appOrigin || !companySlug) return "";
  return `${appOrigin}/${companySlug}`;
}

function replaceTemplateVars(template: string, candidate: ReactivationCandidate, reservationUrl: string) {
  return template
    .replace(/\{nome\}/g, getFirstName(candidate.guest_name))
    .replace(/\{dias_sem_visita\}/g, String(candidate.days_since_visit || REACTIVATION_DAYS))
    .replace(/\{data_ultima_visita\}/g, formatDate(candidate.last_visit_date))
    .replace(/\{link_reserva\}/g, reservationUrl)
    .replace(/\{telefone\}/g, candidate.guest_phone ?? "");
}

function buildDispatchKey(candidate: ReactivationCandidate, daysWithoutVisit = REACTIVATION_DAYS) {
  return `reactivation:${candidate.company_id}:${candidate.phone_normalized}:${candidate.last_visit_date}:${daysWithoutVisit}`;
}

async function claimLeadReactivationDispatch(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  candidate: ReactivationCandidate,
  channel: "evolution" | "pluguechat_official",
): Promise<DispatchClaim | null> {
  const dispatchKey = buildDispatchKey(candidate);
  const { data, error } = await supabaseAdmin
    .from("lead_reactivation_dispatches")
    .insert({
      company_id: candidate.company_id,
      phone: candidate.guest_phone ?? candidate.phone_normalized,
      phone_normalized: candidate.phone_normalized,
      guest_name: candidate.guest_name ?? null,
      last_visit_date: candidate.last_visit_date,
      last_visit_source: candidate.last_visit_source ?? null,
      days_without_visit: REACTIVATION_DAYS,
      channel,
      status: "processing",
      dispatch_key: dispatchKey,
    })
    .select("id")
    .maybeSingle();

  if (!error) {
    return data?.id ? { id: data.id, dispatchKey } : null;
  }

  if (error.code === "23505") return null;
  throw error;
}

async function updateDispatch(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  dispatchId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("lead_reactivation_dispatches")
    .update(payload)
    .eq("id", dispatchId);

  if (error) {
    console.warn("Reactivation dispatch update error:", error.message);
  }
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
    const now = new Date();
    const todayStr = formatDateKeyInTimeZone(now);
    const windowStart = getLocalDateTime(todayStr, REACTIVATION_WINDOW_START);
    const expiresAt = getLocalDateTime(todayStr, REACTIVATION_EXPIRES_AT);
    const scheduledFor = new Date(Math.max(now.getTime(), windowStart.getTime()));

    if (scheduledFor >= expiresAt) {
      return new Response(JSON.stringify({ queued: 0, skipped: true, reason: "outside_reactivation_window" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: candidates, error: candidatesError } = await supabaseAdmin.rpc(
      "get_lead_reactivation_candidates",
      {
        _company_id: null,
        _days_without_visit: REACTIVATION_DAYS,
        _limit: 1000,
        _reference_date: todayStr,
        _exclude_future_reservations: true,
        _match_exact_days: true,
      },
    );

    if (candidatesError) throw candidatesError;

    const eligibleCandidates = ((candidates ?? []) as ReactivationCandidate[])
      .filter((candidate) => candidate.company_id && candidate.phone_normalized);

    if (eligibleCandidates.length === 0) {
      return new Response(JSON.stringify({ queued: 0, skipped: 0, total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const companyIds = [...new Set(eligibleCandidates.map((candidate) => candidate.company_id))];
    const channelMap = await getCompanyChannels(supabaseAdmin, companyIds);

    const [
      { data: automations },
      { data: plugueChatTemplates },
      { data: companyRows },
    ] = await Promise.all([
      supabaseAdmin
        .from("automation_settings")
        .select("*")
        .in("company_id", companyIds)
        .eq("type", AUTOMATION_TYPE)
        .eq("enabled", true),
      supabaseAdmin
        .from("pluguechat_automation_templates")
        .select("company_id, template_id, template_name")
        .in("company_id", companyIds)
        .eq("type", AUTOMATION_TYPE)
        .eq("enabled", true),
      supabaseAdmin
        .from("companies")
        .select("id, slug")
        .in("id", companyIds),
    ]);

    const companySlugMap = new Map<string, string>(
      (companyRows ?? []).map((company: any) => [company.id, company.slug]),
    );
    const appOrigin: string | null = (() => {
      const value = Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL");
      if (!value) return null;
      try { return new URL(value).origin; } catch { return null; }
    })();

    let queued = 0;
    let skipped = 0;

    for (const candidate of eligibleCandidates) {
      const channel = (channelMap.get(candidate.company_id) ?? "evolution") as "evolution" | "pluguechat_official";
      const reservationUrl = buildReservationUrl(appOrigin, companySlugMap.get(candidate.company_id));

      if (channel === "pluguechat_official") {
        const template = (plugueChatTemplates || []).find((item: any) => item.company_id === candidate.company_id);
        if (!template?.template_id) { skipped++; continue; }

        const claimed = await claimLeadReactivationDispatch(supabaseAdmin, candidate, channel);
        if (!claimed) { skipped++; continue; }

        try {
          const phone = normalizePhone(candidate.guest_phone ?? candidate.phone_normalized);
          const result = await enqueuePlugueChatMessage(supabaseAdmin, {
            company_id: candidate.company_id,
            phone,
            type: AUTOMATION_TYPE,
            template_id: template.template_id,
            template_name: template.template_name ?? null,
            parameters: buildReactivationParameters({
              nome: candidate.guest_name ?? "",
              diasSemVisita: candidate.days_since_visit || REACTIVATION_DAYS,
              dataUltimaVisita: candidate.last_visit_date,
              linkReserva: reservationUrl,
            }),
            scheduled_for: scheduledFor.toISOString(),
            expires_at: expiresAt.toISOString(),
            priority: PRIORITY_REACTIVATION,
            idempotency_key: `pluguechat:${claimed.dispatchKey}`,
          });

          await updateDispatch(supabaseAdmin, claimed.id, {
            status: "queued",
            skip_reason: result === "duplicate" ? "duplicate_queue_item" : null,
          });
          queued++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Erro ao enfileirar reativacao PlugueChat.";
          await updateDispatch(supabaseAdmin, claimed.id, { status: "failed", error_details: message });
          skipped++;
        }
        continue;
      }

      const automation = (automations || []).find((item: any) => item.company_id === candidate.company_id);
      if (!automation?.message_template) { skipped++; continue; }

      const claimed = await claimLeadReactivationDispatch(supabaseAdmin, candidate, channel);
      if (!claimed) { skipped++; continue; }

      const phone = formatPhoneForWhatsApp(candidate.guest_phone ?? candidate.phone_normalized);
      const locked = await claimWhatsAppDispatch(supabaseAdmin, {
        deliveryKey: claimed.dispatchKey,
        companyId: candidate.company_id,
        automationType: AUTOMATION_TYPE,
        phone,
      });

      if (!locked) {
        await updateDispatch(supabaseAdmin, claimed.id, { status: "skipped", skip_reason: "dispatch_already_claimed" });
        skipped++;
        continue;
      }

      try {
        const enqueueResult = await enqueueWhatsAppMessageOnce(supabaseAdmin, {
          company_id: candidate.company_id,
          phone,
          message: replaceTemplateVars(automation.message_template, candidate, reservationUrl),
          type: AUTOMATION_TYPE,
          scheduled_for: scheduledFor.toISOString(),
          expires_at: expiresAt.toISOString(),
          priority: PRIORITY_REACTIVATION,
        });

        await finalizeWhatsAppDispatch(supabaseAdmin, { deliveryKey: claimed.dispatchKey, status: "queued" });
        await updateDispatch(supabaseAdmin, claimed.id, {
          status: "queued",
          skip_reason: enqueueResult === "duplicate" ? "duplicate_queue_item" : null,
        });
        queued++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro ao enfileirar reativacao Evolution.";
        await finalizeWhatsAppDispatch(supabaseAdmin, { deliveryKey: claimed.dispatchKey, status: "failed", errorDetails: message });
        await updateDispatch(supabaseAdmin, claimed.id, { status: "failed", error_details: message });
        skipped++;
      }
    }

    return new Response(JSON.stringify({ queued, skipped, total: eligibleCandidates.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Reactivation messages error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
