import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  formatPhoneForWhatsApp,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";
import { formatDateKeyInTimeZone } from "../_shared/timezone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

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

async function getEvolutionConfig(supabaseAdmin: any) {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("key, value")
    .in("key", ["evolution_api_url", "evolution_api_token"]);

  const evolutionUrl = settings?.find((setting: any) => setting.key === "evolution_api_url")?.value?.replace(/\/+$/, "");
  const evolutionToken = settings?.find((setting: any) => setting.key === "evolution_api_token")?.value;
  return { evolutionUrl, evolutionToken };
}

function getReservationDateTime(date: string, time: string) {
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
    const { evolutionUrl, evolutionToken } = await getEvolutionConfig(supabaseAdmin);

    if (!evolutionUrl || !evolutionToken) {
      console.log("Evolution API not configured, skipping reminders");
      return new Response(JSON.stringify({ skipped: true, reason: "evolution_not_configured" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const todayStr = formatDateKeyInTimeZone(now);
    const tomorrowStr = formatDateKeyInTimeZone(new Date(now.getTime() + 24 * 60 * 60 * 1000));

    console.log(`Checking reminders for ${todayStr} and ${tomorrowStr}`);

    const [{ data: reservationsToday }, { data: reservationsTomorrow }] = await Promise.all([
      supabaseAdmin
        .from("reservations")
        .select("*")
        .eq("date", todayStr)
        .eq("status", "confirmed"),
      supabaseAdmin
        .from("reservations")
        .select("*")
        .eq("date", tomorrowStr)
        .eq("status", "confirmed"),
    ]);

    const candidateReservations = [...(reservationsToday || []), ...(reservationsTomorrow || [])];

    const reservations1h = candidateReservations.filter((reservation: any) => {
      const minutesUntilReservation =
        (getReservationDateTime(reservation.date, reservation.time).getTime() - now.getTime()) / (1000 * 60);
      return minutesUntilReservation >= 55 && minutesUntilReservation <= 65;
    });

    const reservations24h = candidateReservations.filter((reservation: any) => {
      const minutesUntilReservation =
        (getReservationDateTime(reservation.date, reservation.time).getTime() - now.getTime()) / (1000 * 60);
      return minutesUntilReservation >= 1435 && minutesUntilReservation <= 1445;
    });

    const filtered24h = reservations24h.filter((reservation: any) => {
      const createdAt = new Date(reservation.created_at);
      const reservationDateTime = getReservationDateTime(reservation.date, reservation.time || "00:00");
      const hoursUntilReservation = (reservationDateTime.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

      if (hoursUntilReservation < 24) {
        console.log(`Skipping 24h reminder for ${reservation.id}: booked only ${hoursUntilReservation.toFixed(1)}h before`);
        return false;
      }

      return true;
    });

    console.log(
      `Found ${reservations1h.length} 1h reminders, ${filtered24h.length} 24h reminders (${reservations24h.length - filtered24h.length} skipped)`,
    );

    const allReservations = [
      ...reservations1h.map((reservation: any) => ({ ...reservation, _reminderType: "reminder_1h" })),
      ...filtered24h.map((reservation: any) => ({ ...reservation, _reminderType: "reminder_24h" })),
    ];

    if (allReservations.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const companyIds = [...new Set(allReservations.map((reservation: any) => reservation.company_id))];

    const [{ data: automations }, { data: instances }, { data: alreadySent }, { data: alreadyQueued }] = await Promise.all([
      supabaseAdmin
        .from("automation_settings")
        .select("*")
        .in("company_id", companyIds)
        .in("type", ["reminder_1h", "reminder_24h"])
        .eq("enabled", true),
      supabaseAdmin
        .from("company_whatsapp_instances")
        .select("*")
        .in("company_id", companyIds),
      supabaseAdmin
        .from("whatsapp_message_logs")
        .select("reservation_id, type")
        .in("reservation_id", allReservations.map((reservation: any) => reservation.id))
        .in("type", ["reminder_1h", "reminder_24h"])
        .eq("status", "sent"),
      supabaseAdmin
        .from("whatsapp_message_queue")
        .select("reservation_id, type")
        .in("reservation_id", allReservations.map((reservation: any) => reservation.id))
        .in("type", ["reminder_1h", "reminder_24h"]),
    ]);

    const instanceMap = new Map((instances || []).map((instance: any) => [instance.company_id, instance]));
    const sentSet = new Set((alreadySent || []).map((log: any) => `${log.reservation_id}:${log.type}`));
    const queuedSet = new Set((alreadyQueued || []).map((item: any) => `${item.reservation_id}:${item.type}`));

    let sent = 0;
    const errors: string[] = [];

    for (const reservation of allReservations) {
      const reminderType = reservation._reminderType;
      const key = `${reservation.id}:${reminderType}`;

      if (sentSet.has(key) || queuedSet.has(key)) {
        console.log(`Skipping duplicate ${reminderType} for ${reservation.id}`);
        continue;
      }

      const automation = (automations || []).find(
        (item: any) => item.company_id === reservation.company_id && item.type === reminderType,
      );

      if (!automation) continue;

      const message = replaceTemplateVars(automation.message_template, reservation);
      const phone = formatPhoneForWhatsApp(reservation.guest_phone);
      const instance = instanceMap.get(reservation.company_id);

      if (!instance) {
        const failure = buildInstanceNotConfiguredFailure();
        await supabaseAdmin.from("whatsapp_message_queue").insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: reminderType,
          error_details: serializeWhatsAppFailure(failure.error),
        });
        errors.push(`${reservation.id}: ${failure.error.message}`);
        continue;
      }

      if (instance.status !== "connected") {
        const failure = buildInstanceDisconnectedFailure();
        await supabaseAdmin.from("whatsapp_message_queue").insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: reminderType,
          error_details: serializeWhatsAppFailure(failure.error),
        });
        errors.push(`${reservation.id}: ${failure.error.message}`);
        continue;
      }

      const result = await sendWhatsAppText(
        evolutionUrl,
        evolutionToken,
        instance.instance_name,
        phone,
        message,
      );

      if (result.ok) {
        await supabaseAdmin.from("whatsapp_message_logs").insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: reminderType,
          status: "sent",
          error_details: null,
        });
        sent++;
        console.log(`${reminderType} sent to ${phone} for reservation ${reservation.id}`);
        continue;
      }

      const serializedError = serializeWhatsAppFailure(result.error);
      errors.push(`${reservation.id}: ${result.error.message}`);

      await supabaseAdmin.from("whatsapp_message_logs").insert({
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: reminderType,
        status: "error",
        error_details: serializedError,
      });

      await supabaseAdmin.from("whatsapp_message_queue").insert({
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: reminderType,
        error_details: serializedError,
      });
    }

    return new Response(JSON.stringify({ sent, total: allReservations.length, errors }), {
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
