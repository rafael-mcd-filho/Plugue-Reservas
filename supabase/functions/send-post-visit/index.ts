import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  formatPhoneForWhatsApp,
  getWhatsAppAcceptedLogStatus,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";
import { formatDateKeyInTimeZone, getZonedParts } from "../_shared/timezone.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-job-secret',
};

function replaceTemplateVars(template: string, reservation: any): string {
  const [h, m] = (reservation.time || '').split(':');
  const timeFormatted = h && m ? `${h}:${m}` : reservation.time;
  const [y, mo, d] = (reservation.date || '').split('-');
  const dateFormatted = d && mo && y ? `${d}/${mo}/${y}` : reservation.date;

  return template
    .replace(/\{nome\}/g, reservation.guest_name || '')
    .replace(/\{pessoas\}/g, String(reservation.party_size || 1))
    .replace(/\{data\}/g, dateFormatted)
    .replace(/\{hora\}/g, timeFormatted)
    .replace(/\{telefone\}/g, reservation.guest_phone || '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return new Response(JSON.stringify({ error: 'Nao autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createSupabaseAdminClient();

    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ skipped: true, reason: 'evolution_not_configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const now = new Date();
    const zonedNow = getZonedParts(now);
    const localHour = Number(zonedNow.hour);

    if (localHour !== 8) {
      console.log(`Post-visit: skipping outside 08:00 local window (${zonedNow.hour}:${zonedNow.minute}:${zonedNow.second})`);
      return new Response(JSON.stringify({ sent: 0, skipped: true, reason: 'outside_post_visit_window' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const yesterdayStr = formatDateKeyInTimeZone(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    console.log(`Post-visit: checking successful reservations from ${yesterdayStr} for next-day 08:00 delivery`);

    const { data: reservations } = await supabaseAdmin
      .from('reservations')
      .select('*')
      .eq('date', yesterdayStr)
      .in('status', ['checked_in', 'completed']);

    if (!reservations || reservations.length === 0) {
      console.log('No successful reservations from yesterday for post-visit');
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`Found ${reservations.length} successful reservations from yesterday`);

    const companyIds = [...new Set(reservations.map((r: any) => r.company_id))];

    const [{ data: automations }, { data: instances }, { data: alreadySent }, { data: alreadyQueued }] = await Promise.all([
      supabaseAdmin
        .from('automation_settings')
        .select('*')
        .in('company_id', companyIds)
        .eq('type', 'post_visit')
        .eq('enabled', true),
      supabaseAdmin
        .from('company_whatsapp_instances')
        .select('*')
        .in('company_id', companyIds),
      supabaseAdmin
        .from('whatsapp_message_logs')
        .select('reservation_id')
        .in('reservation_id', reservations.map((r: any) => r.id))
        .eq('type', 'post_visit'),
      supabaseAdmin
        .from('whatsapp_message_queue')
        .select('reservation_id')
        .in('reservation_id', reservations.map((r: any) => r.id))
        .eq('type', 'post_visit'),
    ]);

    const sentIds = new Set((alreadySent || []).map((l: any) => l.reservation_id));
    const queuedIds = new Set((alreadyQueued || []).map((l: any) => l.reservation_id));
    const instanceMap = new Map((instances || []).map((i: any) => [i.company_id, i]));

    let sent = 0;
    let queued = 0;

    for (const reservation of reservations) {
      if (sentIds.has(reservation.id) || queuedIds.has(reservation.id)) continue;

      const automation = (automations || []).find((a: any) => a.company_id === reservation.company_id);
      if (!automation) continue;

      const message = replaceTemplateVars(automation.message_template, reservation);
      const phone = formatPhoneForWhatsApp(reservation.guest_phone);
      const instance = instanceMap.get(reservation.company_id);

      if (!instance) {
        const failure = buildInstanceNotConfiguredFailure();
        await supabaseAdmin.from('whatsapp_message_queue').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'post_visit',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        queued++;
        continue;
      }

      if (instance.status !== 'connected') {
        const failure = buildInstanceDisconnectedFailure();
        await supabaseAdmin.from('whatsapp_message_queue').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'post_visit',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        queued++;
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
        const logStatus = getWhatsAppAcceptedLogStatus(result);
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'post_visit',
          status: logStatus,
          error_details: null,
        });
        sent++;
        continue;
      }

      const serializedError = serializeWhatsAppFailure(result.error);
      await supabaseAdmin.from('whatsapp_message_logs').insert({
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: 'post_visit',
        status: 'error',
        error_details: serializedError,
      });
      await supabaseAdmin.from('whatsapp_message_queue').insert({
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: 'post_visit',
        error_details: serializedError,
      });
      queued++;
    }

    return new Response(JSON.stringify({ sent, queued, total: reservations.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Post-visit error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
