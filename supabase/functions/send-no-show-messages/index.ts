import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildReservationDispatchKey,
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  claimWhatsAppDispatch,
  enqueueWhatsAppMessageOnce,
  finalizeWhatsAppDispatch,
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

    if (localHour !== 9) {
      console.log(`No-show: skipping outside 09:00 local window (${zonedNow.hour}:${zonedNow.minute}:${zonedNow.second})`);
      return new Response(JSON.stringify({ sent: 0, skipped: true, reason: 'outside_no_show_window' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const yesterdayStr = formatDateKeyInTimeZone(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    console.log(`No-show: checking no-show reservations from ${yesterdayStr} for next-day 09:00 delivery`);

    const { data: reservations } = await supabaseAdmin
      .from('reservations')
      .select('*')
      .eq('date', yesterdayStr)
      .eq('status', 'no-show');

    if (!reservations || reservations.length === 0) {
      console.log('No no-show reservations from yesterday');
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`Found ${reservations.length} no-show reservations from yesterday`);

    const companyIds = [...new Set(reservations.map((r: any) => r.company_id))];

    const [{ data: automations }, { data: instances }, { data: alreadySent }, { data: alreadyQueued }] = await Promise.all([
      supabaseAdmin
        .from('automation_settings')
        .select('*')
        .in('company_id', companyIds)
        .eq('type', 'no_show_message')
        .eq('enabled', true),
      supabaseAdmin
        .from('company_whatsapp_instances')
        .select('*')
        .in('company_id', companyIds),
      supabaseAdmin
        .from('whatsapp_message_logs')
        .select('reservation_id')
        .in('reservation_id', reservations.map((r: any) => r.id))
        .eq('type', 'no_show'),
      supabaseAdmin
        .from('whatsapp_message_queue')
        .select('reservation_id')
        .in('reservation_id', reservations.map((r: any) => r.id))
        .eq('type', 'no_show'),
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
      const deliveryKey = buildReservationDispatchKey('no_show', reservation.id);
      const claimed = await claimWhatsAppDispatch(supabaseAdmin, {
        deliveryKey,
        companyId: reservation.company_id,
        automationType: 'no_show',
        reservationId: reservation.id,
        phone,
      });

      if (!claimed) {
        continue;
      }

      const instance = instanceMap.get(reservation.company_id);

      if (!instance) {
        const failure = buildInstanceNotConfiguredFailure();
        await enqueueWhatsAppMessageOnce(supabaseAdmin, {
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'no_show',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        await finalizeWhatsAppDispatch(supabaseAdmin, {
          deliveryKey,
          status: 'queued',
          errorDetails: serializeWhatsAppFailure(failure.error),
        });
        queued++;
        continue;
      }

      if (instance.status !== 'connected') {
        const failure = buildInstanceDisconnectedFailure();
        await enqueueWhatsAppMessageOnce(supabaseAdmin, {
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'no_show',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        await finalizeWhatsAppDispatch(supabaseAdmin, {
          deliveryKey,
          status: 'queued',
          errorDetails: serializeWhatsAppFailure(failure.error),
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
          type: 'no_show',
          status: logStatus,
          error_details: null,
        });
        await finalizeWhatsAppDispatch(supabaseAdmin, {
          deliveryKey,
          status: 'accepted',
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
        type: 'no_show',
        status: 'error',
        error_details: serializedError,
      });
      await enqueueWhatsAppMessageOnce(supabaseAdmin, {
        company_id: reservation.company_id,
        reservation_id: reservation.id,
        phone,
        message,
        type: 'no_show',
        error_details: serializedError,
      });
      await finalizeWhatsAppDispatch(supabaseAdmin, {
        deliveryKey,
        status: 'queued',
        errorDetails: serializedError,
      });
      queued++;
    }

    return new Response(JSON.stringify({ sent, queued, total: reservations.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('No-show messages error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
