import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildReservationDispatchKey,
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
  formatPhoneForWhatsApp,
} from "../_shared/whatsapp.ts";
import {
  buildReservationParameters,
  enqueuePlugueChatMessage,
  getCompanyChannels,
  normalizePhone,
} from "../_shared/pluguechat.ts";
import { formatDateKeyInTimeZone, getZonedParts } from "../_shared/timezone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const PRIORITY_NO_SHOW = 70;
const NO_SHOW_EXPIRES_AT = "15:00";

function replaceTemplateVars(template: string, reservation: any): string {
  const [h, m] = (reservation.time || "").split(":");
  const timeFormatted = h && m ? `${h}:${m}` : reservation.time;
  const [y, mo, d] = (reservation.date || "").split("-");
  const dateFormatted = d && mo && y ? `${d}/${mo}/${y}` : reservation.date;

  return template
    .replace(/\{nome\}/g, reservation.guest_name || "")
    .replace(/\{pessoas\}/g, String(reservation.party_size || 1))
    .replace(/\{data\}/g, dateFormatted)
    .replace(/\{hora\}/g, timeFormatted)
    .replace(/\{telefone\}/g, reservation.guest_phone || "");
}

function getLocalDateTime(date: string, time: string) {
  const [hours = "00", minutes = "00"] = time.split(":");
  return new Date(`${date}T${hours}:${minutes}:00-03:00`);
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
    const zonedNow = getZonedParts(now);
    const localHour = Number(zonedNow.hour);

    if (localHour !== 9) {
      console.log(`No-show: skipping outside 09:00 local window (${zonedNow.hour}:${zonedNow.minute}:${zonedNow.second})`);
      return new Response(JSON.stringify({ queued: 0, skipped: true, reason: "outside_no_show_window" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const todayStr = formatDateKeyInTimeZone(now);
    const yesterdayStr = formatDateKeyInTimeZone(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const expiresAt = getLocalDateTime(todayStr, NO_SHOW_EXPIRES_AT);

    const { data: reservations } = await supabaseAdmin
      .from("reservations")
      .select("*")
      .eq("date", yesterdayStr)
      .eq("status", "no-show")
      .not("guest_phone", "is", null);

    if (!reservations || reservations.length === 0) {
      return new Response(JSON.stringify({ queued: 0, total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const companyIds = [...new Set(reservations.map((r: any) => r.company_id))];
    const reservationIds = reservations.map((r: any) => r.id);

    const channelMap = await getCompanyChannels(supabaseAdmin, companyIds);

    const [
      { data: automations }, { data: alreadySent }, { data: alreadyQueued },
      { data: plugueChatTemplates }, { data: plugueChatLogs }, { data: plugueChatQueue },
    ] = await Promise.all([
      supabaseAdmin.from("automation_settings").select("*").in("company_id", companyIds).eq("type", "no_show_message").eq("enabled", true),
      supabaseAdmin.from("whatsapp_message_logs").select("reservation_id").in("reservation_id", reservationIds).eq("type", "no_show"),
      supabaseAdmin.from("whatsapp_message_queue").select("reservation_id").in("reservation_id", reservationIds).eq("type", "no_show"),
      supabaseAdmin.from("pluguechat_automation_templates").select("company_id, template_id, template_name").in("company_id", companyIds).eq("type", "no_show_message").eq("enabled", true),
      supabaseAdmin.from("pluguechat_message_logs").select("reservation_id").in("reservation_id", reservationIds).eq("type", "no_show_message"),
      supabaseAdmin.from("pluguechat_message_queue").select("reservation_id").in("reservation_id", reservationIds).eq("type", "no_show_message").neq("status", "cancelled"),
    ]);

    const sentIds = new Set((alreadySent || []).map((l: any) => l.reservation_id));
    const queuedIds = new Set((alreadyQueued || []).map((l: any) => l.reservation_id));
    const pcLogIds = new Set((plugueChatLogs || []).map((l: any) => l.reservation_id));
    const pcQueueIds = new Set((plugueChatQueue || []).map((i: any) => i.reservation_id));

    let queued = 0;
    let skipped = 0;

    for (const reservation of reservations) {
      const channel = channelMap.get(reservation.company_id) ?? "evolution";

      if (channel === "pluguechat_official") {
        if (pcLogIds.has(reservation.id) || pcQueueIds.has(reservation.id)) { skipped++; continue; }

        const template = (plugueChatTemplates || []).find((t: any) => t.company_id === reservation.company_id);
        if (!template?.template_id) { skipped++; continue; }

        const phone = normalizePhone(reservation.guest_phone);
        const result = await enqueuePlugueChatMessage(supabaseAdmin, {
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          type: "no_show_message",
          template_id: template.template_id,
          template_name: template.template_name ?? null,
          parameters: buildReservationParameters("no_show_message", reservation),
          scheduled_for: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          idempotency_key: `pluguechat:reservation:${reservation.id}:no_show_message`,
        });

        pcQueueIds.add(reservation.id);
        result === "inserted" ? queued++ : skipped++;
        continue;
      }

      // Canal Evolution
      if (sentIds.has(reservation.id) || queuedIds.has(reservation.id)) { skipped++; continue; }

      const automation = (automations || []).find((a: any) => a.company_id === reservation.company_id);
      if (!automation?.message_template) { skipped++; continue; }

      const phone = formatPhoneForWhatsApp(reservation.guest_phone);
      const message = replaceTemplateVars(automation.message_template, reservation);
      const deliveryKey = buildReservationDispatchKey("no_show", reservation.id);
      const claimed = await claimWhatsAppDispatch(supabaseAdmin, { deliveryKey, companyId: reservation.company_id, automationType: "no_show", reservationId: reservation.id, phone });

      if (!claimed) { skipped++; continue; }

      const enqueueResult = await enqueueWhatsAppMessageOnce(supabaseAdmin, {
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: "no_show",
        scheduled_for: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        priority: PRIORITY_NO_SHOW,
      });

      await finalizeWhatsAppDispatch(supabaseAdmin, { deliveryKey, status: "queued" });
      queuedIds.add(reservation.id);
      enqueueResult === "inserted" ? queued++ : skipped++;
    }

    return new Response(JSON.stringify({ queued, skipped, total: reservations.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("No-show messages error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
