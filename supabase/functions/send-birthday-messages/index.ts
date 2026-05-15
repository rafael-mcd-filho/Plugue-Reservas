import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildBirthdayDispatchKey,
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
  formatPhoneForWhatsApp,
  WHATSAPP_ACCEPTED_LOG_STATUSES,
} from "../_shared/whatsapp.ts";
import { formatDateKeyInTimeZone, formatMonthDayInTimeZone } from "../_shared/timezone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

const BIRTHDAY_ADVANCE_DAYS = 4;
const PRIORITY_BIRTHDAY = 100;
const BIRTHDAY_WINDOW_START = "09:05";
const BIRTHDAY_EXPIRES_AT = "18:00";

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
    const targetDate = new Date(now.getTime() + BIRTHDAY_ADVANCE_DAYS * 24 * 60 * 60 * 1000);
    const targetMMDD = formatMonthDayInTimeZone(targetDate);
    const targetDateKey = formatDateKeyInTimeZone(targetDate);
    const todayStr = formatDateKeyInTimeZone(now);
    const windowStart = getLocalDateTime(todayStr, BIRTHDAY_WINDOW_START);
    const expiresAt = getLocalDateTime(todayStr, BIRTHDAY_EXPIRES_AT);
    const scheduledFor = new Date(Math.max(now.getTime(), windowStart.getTime()));

    if (scheduledFor >= expiresAt) {
      return new Response(JSON.stringify({ queued: 0, skipped: true, reason: "outside_birthday_window" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [
      { data: birthdayReservations },
      { data: birthdayCompanions },
      { data: birthdayWaitlistHolders },
      { data: birthdayWaitlistCompanions },
    ] = await Promise.all([
      supabaseAdmin
        .from("reservations")
        .select("guest_name, guest_phone, guest_birthdate, company_id")
        .not("guest_birthdate", "is", null)
        .not("guest_phone", "is", null),
      supabaseAdmin
        .from("reservation_companions")
        .select("name, phone, birthdate, company_id")
        .not("birthdate", "is", null)
        .not("phone", "is", null),
      supabaseAdmin
        .from("waitlist")
        .select("guest_name, guest_phone, guest_birthdate, company_id")
        .eq("status", "seated")
        .not("guest_birthdate", "is", null)
        .not("guest_phone", "is", null),
      supabaseAdmin
        .from("waitlist_companions")
        .select("name, phone, birthdate, company_id")
        .not("birthdate", "is", null)
        .not("phone", "is", null),
    ]);

    const birthdayContacts = [
      ...((birthdayReservations || []).map((reservation: any) => ({
        guest_name: reservation.guest_name,
        guest_phone: reservation.guest_phone,
        guest_birthdate: reservation.guest_birthdate,
        company_id: reservation.company_id,
      }))),
      ...((birthdayCompanions || []).map((companion: any) => ({
        guest_name: companion.name,
        guest_phone: companion.phone,
        guest_birthdate: companion.birthdate,
        company_id: companion.company_id,
      }))),
      ...((birthdayWaitlistHolders || []).map((entry: any) => ({
        guest_name: entry.guest_name,
        guest_phone: entry.guest_phone,
        guest_birthdate: entry.guest_birthdate,
        company_id: entry.company_id,
      }))),
      ...((birthdayWaitlistCompanions || []).map((companion: any) => ({
        guest_name: companion.name,
        guest_phone: companion.phone,
        guest_birthdate: companion.birthdate,
        company_id: companion.company_id,
      }))),
    ];

    if (birthdayContacts.length === 0) {
      return new Response(JSON.stringify({ queued: 0, reason: "no_birthdate_data" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const upcomingBirthdays = birthdayContacts.filter((contact: any) => {
      if (!contact.guest_birthdate) return false;
      return contact.guest_birthdate.substring(5) === targetMMDD;
    });

    if (upcomingBirthdays.length === 0) {
      return new Response(JSON.stringify({ queued: 0, total: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uniqueMap = new Map<string, any>();
    for (const contact of upcomingBirthdays) {
      const phone = formatPhoneForWhatsApp(contact.guest_phone);
      const key = `${phone}:${contact.company_id}`;
      const existing = uniqueMap.get(key);

      if (!existing) {
        uniqueMap.set(key, { ...contact, guest_phone: phone });
        continue;
      }

      if (!existing.guest_name && contact.guest_name) {
        uniqueMap.set(key, { ...existing, guest_name: contact.guest_name });
      }
    }

    const uniqueBirthdays = Array.from(uniqueMap.values());
    const companyIds = [...new Set(uniqueBirthdays.map((contact: any) => contact.company_id))];

    const { data: automations } = await supabaseAdmin
      .from("automation_settings")
      .select("*")
      .in("company_id", companyIds)
      .eq("type", "birthday_message")
      .eq("enabled", true);

    const { data: alreadySent } = await supabaseAdmin
      .from("whatsapp_message_logs")
      .select("phone, company_id")
      .eq("type", "birthday")
      .gte("created_at", `${todayStr}T00:00:00`)
      .in("status", [...WHATSAPP_ACCEPTED_LOG_STATUSES]);

    const { data: alreadyQueued } = await supabaseAdmin
      .from("whatsapp_message_queue")
      .select("phone, company_id")
      .eq("type", "birthday")
      .gte("created_at", `${todayStr}T00:00:00`);

    const processedSet = new Set([
      ...(alreadySent || []).map((item: any) => `${formatPhoneForWhatsApp(item.phone)}:${item.company_id}`),
      ...(alreadyQueued || []).map((item: any) => `${formatPhoneForWhatsApp(item.phone)}:${item.company_id}`),
    ]);

    let queued = 0;
    let skipped = 0;

    for (const contact of uniqueBirthdays) {
      const automation = (automations || []).find((item: any) => item.company_id === contact.company_id);
      if (!automation?.message_template) {
        skipped++;
        continue;
      }

      const phone = contact.guest_phone;
      const sentKey = `${phone}:${contact.company_id}`;
      if (processedSet.has(sentKey)) {
        skipped++;
        continue;
      }

      const deliveryKey = buildBirthdayDispatchKey(contact.company_id, targetDateKey, phone);
      const claimed = await claimWhatsAppDispatch(supabaseAdmin, {
        deliveryKey,
        companyId: contact.company_id,
        automationType: "birthday",
        phone,
      });

      if (!claimed) {
        skipped++;
        continue;
      }

      const message = automation.message_template.replace(/\{nome\}/g, contact.guest_name || "");
      const enqueueResult = await enqueueWhatsAppMessageOnce(supabaseAdmin, {
        company_id: contact.company_id,
        phone,
        message,
        type: "birthday",
        scheduled_for: scheduledFor.toISOString(),
        expires_at: expiresAt.toISOString(),
        priority: PRIORITY_BIRTHDAY,
      });

      await finalizeWhatsAppDispatch(supabaseAdmin, {
        deliveryKey,
        status: "queued",
      });

      processedSet.add(sentKey);
      if (enqueueResult === "inserted") {
        queued++;
      } else {
        skipped++;
      }
    }

    return new Response(JSON.stringify({ queued, skipped, total: uniqueBirthdays.length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Birthday messages error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
