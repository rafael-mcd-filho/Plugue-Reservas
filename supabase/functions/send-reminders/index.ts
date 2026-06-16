import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildReservationDispatchKey,
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
  formatPhoneForWhatsApp,
  WHATSAPP_ACCEPTED_LOG_STATUSES,
} from "../_shared/whatsapp.ts";
import {
  buildReservationParameters,
  enqueuePlugueChatMessage,
  getCompanyChannels,
  normalizePhone,
} from "../_shared/pluguechat.ts";
import { formatDateKeyInTimeZone } from "../_shared/timezone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const REMINDER_TYPES = ["reminder_1h", "reminder_24h"];
const SAME_DAY_MIN_MINUTES_BEFORE = 60;
const SAME_DAY_MAX_MINUTES_BEFORE = 5 * 60;
const MIN_MINUTES_AFTER_CREATION = 60;
const DAY_BEFORE_WINDOW_START = "10:00";
const DAY_BEFORE_WINDOW_END = "17:00";
const PRIORITY_REMINDER_SOON = 20;
const PRIORITY_REMINDER_DAY_BEFORE = 60;

function replaceTemplateVars(template: string, reservation: any): string {
  const [hours, minutes] = (reservation.time || "").split(":");
  const timeFormatted = hours && minutes ? `${hours}:${minutes}` : reservation.time;
  const [year, month, day] = (reservation.date || "").split("-");
  const dateFormatted = day && month && year ? `${day}/${month}/${year}` : reservation.date;

  return template
    .replace(/\{nome\}/g, reservation.guest_name || "")
    .replace(/\{pessoas\}/g, String(reservation.party_size || 1))
    .replace(/\{data\}/g, dateFormatted)
    .replace(/\{hora\}/g, timeFormatted)
    .replace(/\{telefone\}/g, reservation.guest_phone || "");
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function maxDate(...dates: Date[]) {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function getLocalDateTime(date: string, time: string) {
  const [hours = "00", minutes = "00"] = time.split(":");
  return new Date(`${date}T${hours}:${minutes}:00-03:00`);
}

function getCreatedAtDelay(reservation: any) {
  const createdAt = reservation.created_at ? new Date(reservation.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return null;
  return addMinutes(createdAt, MIN_MINUTES_AFTER_CREATION);
}

function getDayBeforeSchedule(reservation: any, now: Date, todayStr: string) {
  const windowStart = getLocalDateTime(todayStr, DAY_BEFORE_WINDOW_START);
  const expiresAt = getLocalDateTime(todayStr, DAY_BEFORE_WINDOW_END);
  const createdDelay = getCreatedAtDelay(reservation);
  const scheduledFor = maxDate(now, windowStart, ...(createdDelay ? [createdDelay] : []));

  if (scheduledFor >= expiresAt) {
    return null;
  }

  return {
    scheduledFor,
    expiresAt,
    priority: PRIORITY_REMINDER_DAY_BEFORE,
  };
}

function getSameDaySchedule(reservation: any, now: Date) {
  const reservationAt = getLocalDateTime(reservation.date, reservation.time || "00:00");
  const minutesUntilReservation = (reservationAt.getTime() - now.getTime()) / (1000 * 60);

  if (
    minutesUntilReservation < SAME_DAY_MIN_MINUTES_BEFORE ||
    minutesUntilReservation > SAME_DAY_MAX_MINUTES_BEFORE
  ) {
    return null;
  }

  const expiresAt = addMinutes(reservationAt, -SAME_DAY_MIN_MINUTES_BEFORE);
  const createdDelay = getCreatedAtDelay(reservation);
  const scheduledFor = maxDate(now, ...(createdDelay ? [createdDelay] : []));

  if (scheduledFor >= expiresAt) {
    return null;
  }

  return {
    scheduledFor,
    expiresAt,
    priority: PRIORITY_REMINDER_SOON,
  };
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
    const tomorrowStr = formatDateKeyInTimeZone(addMinutes(now, 24 * 60));

    const [{ data: reservationsToday }, { data: reservationsTomorrow }] = await Promise.all([
      supabaseAdmin
        .from("reservations")
        .select("*")
        .eq("date", todayStr)
        .eq("status", "confirmed")
        .not("guest_phone", "is", null),
      supabaseAdmin
        .from("reservations")
        .select("*")
        .eq("date", tomorrowStr)
        .eq("status", "confirmed")
        .not("guest_phone", "is", null),
    ]);

    const sameDayReservations = (reservationsToday || [])
      .map((reservation: any) => ({
        ...reservation,
        _reminderType: "reminder_1h",
        _schedule: getSameDaySchedule(reservation, now),
      }))
      .filter((reservation: any) => reservation._schedule);

    const dayBeforeReservations = (reservationsTomorrow || [])
      .map((reservation: any) => ({
        ...reservation,
        _reminderType: "reminder_24h",
        _schedule: getDayBeforeSchedule(reservation, now, todayStr),
      }))
      .filter((reservation: any) => reservation._schedule);

    const allReservations = [...sameDayReservations, ...dayBeforeReservations];

    if (allReservations.length === 0) {
      return new Response(JSON.stringify({ queued: 0, total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const companyIds = [...new Set(allReservations.map((reservation: any) => reservation.company_id))];
    const reservationIds = allReservations.map((reservation: any) => reservation.id);

    const channelMap = await getCompanyChannels(supabaseAdmin, companyIds);

    const [
      { data: automations },
      { data: alreadySent },
      { data: alreadyQueued },
      { data: plugueChatTemplates },
      { data: plugueChatLogs },
      { data: plugueChatQueue },
    ] = await Promise.all([
      supabaseAdmin
        .from("automation_settings")
        .select("*")
        .in("company_id", companyIds)
        .in("type", REMINDER_TYPES)
        .eq("enabled", true),
      supabaseAdmin
        .from("whatsapp_message_logs")
        .select("reservation_id, type")
        .in("reservation_id", reservationIds)
        .in("type", REMINDER_TYPES)
        .in("status", [...WHATSAPP_ACCEPTED_LOG_STATUSES]),
      supabaseAdmin
        .from("whatsapp_message_queue")
        .select("reservation_id, type")
        .in("reservation_id", reservationIds)
        .in("type", REMINDER_TYPES),
      supabaseAdmin
        .from("pluguechat_automation_templates")
        .select("company_id, type, template_id, template_name")
        .in("company_id", companyIds)
        .in("type", REMINDER_TYPES)
        .eq("enabled", true),
      supabaseAdmin
        .from("pluguechat_message_logs")
        .select("reservation_id, type")
        .in("reservation_id", reservationIds)
        .in("type", REMINDER_TYPES),
      supabaseAdmin
        .from("pluguechat_message_queue")
        .select("reservation_id, type")
        .in("reservation_id", reservationIds)
        .in("type", REMINDER_TYPES)
        .neq("status", "cancelled"),
    ]);

    const sentSet = new Set((alreadySent || []).map((log: any) => `${log.reservation_id}:${log.type}`));
    const queuedSet = new Set((alreadyQueued || []).map((item: any) => `${item.reservation_id}:${item.type}`));
    const pcLogSet = new Set((plugueChatLogs || []).map((l: any) => `${l.reservation_id}:${l.type}`));
    const pcQueueSet = new Set((plugueChatQueue || []).map((i: any) => `${i.reservation_id}:${i.type}`));

    let queued = 0;
    let skipped = 0;

    for (const reservation of allReservations) {
      const reminderType = reservation._reminderType;
      const schedule = reservation._schedule;
      const key = `${reservation.id}:${reminderType}`;
      const channel = channelMap.get(reservation.company_id) ?? "evolution";

      if (channel === "pluguechat_official") {
        if (pcLogSet.has(key) || pcQueueSet.has(key)) { skipped++; continue; }

        const template = (plugueChatTemplates || []).find(
          (t: any) => t.company_id === reservation.company_id && t.type === reminderType,
        );
        if (!template?.template_id) { skipped++; continue; }

        const phone = normalizePhone(reservation.guest_phone);
        const parameters = buildReservationParameters(reminderType, reservation);
        const idempotencyKey = `pluguechat:reservation:${reservation.id}:${reminderType}`;

        const result = await enqueuePlugueChatMessage(supabaseAdmin, {
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          type: reminderType,
          template_id: template.template_id,
          template_name: template.template_name ?? null,
          parameters,
          scheduled_for: schedule.scheduledFor.toISOString(),
          expires_at: schedule.expiresAt.toISOString(),
          idempotency_key: idempotencyKey,
        });

        pcQueueSet.add(key);
        if (result === "inserted") queued++;
        else skipped++;
        continue;
      }

      // Canal Evolution
      if (sentSet.has(key) || queuedSet.has(key)) { skipped++; continue; }

      const automation = (automations || []).find(
        (item: any) => item.company_id === reservation.company_id && item.type === reminderType,
      );
      if (!automation?.message_template) { skipped++; continue; }

      const phone = formatPhoneForWhatsApp(reservation.guest_phone);
      const message = replaceTemplateVars(automation.message_template, reservation);
      const deliveryKey = buildReservationDispatchKey(reminderType, reservation.id);
      const claimed = await claimWhatsAppDispatch(supabaseAdmin, {
        deliveryKey,
        companyId: reservation.company_id,
        automationType: reminderType,
        reservationId: reservation.id,
        phone,
      });

      if (!claimed) { skipped++; continue; }

      const enqueueResult = await enqueueWhatsAppMessageOnce(supabaseAdmin, {
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: reminderType,
        scheduled_for: schedule.scheduledFor.toISOString(),
        expires_at: schedule.expiresAt.toISOString(),
        priority: schedule.priority,
      });

      await finalizeWhatsAppDispatch(supabaseAdmin, { deliveryKey, status: "queued" });
      queuedSet.add(key);
      if (enqueueResult === "inserted") queued++;
      else skipped++;
    }

    return new Response(JSON.stringify({ queued, skipped, total: allReservations.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Send reminders error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
