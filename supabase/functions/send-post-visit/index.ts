import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function formatPhoneForWhatsApp(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('55') && digits.length <= 11) digits = '55' + digits;
  return digits;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

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
    const todayStr = now.toISOString().split('T')[0];

    // Find reservations that ended 1-2 hours ago (post-visit window)
    const hours2ago = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const hours1ago = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const timeFrom = `${String(hours2ago.getHours()).padStart(2, '0')}:${String(hours2ago.getMinutes()).padStart(2, '0')}:00`;
    const timeTo = `${String(hours1ago.getHours()).padStart(2, '0')}:${String(hours1ago.getMinutes()).padStart(2, '0')}:00`;

    console.log(`Post-visit: checking reservations on ${todayStr} with time ${timeFrom}-${timeTo}`);

    // Get completed reservations (status = completed or confirmed that already passed)
    const { data: reservations } = await supabaseAdmin
      .from('reservations')
      .select('*')
      .eq('date', todayStr)
      .in('status', ['completed', 'confirmed'])
      .gte('time', timeFrom)
      .lte('time', timeTo);

    if (!reservations || reservations.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const companyIds = [...new Set(reservations.map((r: any) => r.company_id))];

    const [{ data: automations }, { data: instances }, { data: alreadySent }] = await Promise.all([
      supabaseAdmin
        .from('automation_settings')
        .select('*')
        .in('company_id', companyIds)
        .eq('type', 'post_visit')
        .eq('enabled', true),
      supabaseAdmin
        .from('company_whatsapp_instances')
        .select('*')
        .in('company_id', companyIds)
        .eq('status', 'connected'),
      supabaseAdmin
        .from('whatsapp_message_logs')
        .select('reservation_id')
        .in('reservation_id', reservations.map((r: any) => r.id))
        .eq('type', 'post_visit')
        .eq('status', 'sent'),
    ]);

    const sentIds = new Set((alreadySent || []).map((l: any) => l.reservation_id));
    const instanceMap = new Map((instances || []).map((i: any) => [i.company_id, i]));

    let sent = 0;

    for (const reservation of reservations) {
      if (sentIds.has(reservation.id)) continue;

      const automation = (automations || []).find((a: any) => a.company_id === reservation.company_id);
      const instance = instanceMap.get(reservation.company_id);
      if (!automation || !instance) continue;

      const message = replaceTemplateVars(automation.message_template, reservation);
      const phone = formatPhoneForWhatsApp(reservation.guest_phone);

      try {
        const res = await fetch(`${evolutionUrl}/message/sendText/${instance.instance_name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
          body: JSON.stringify({ number: phone, text: message }),
        });
        const data = await res.json();

        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone, message,
          type: 'post_visit',
          status: res.ok ? 'sent' : 'error',
          error_details: res.ok ? null : JSON.stringify(data),
        });

        if (res.ok) sent++;
      } catch (err) {
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone, message,
          type: 'post_visit',
          status: 'error',
          error_details: String(err),
        });
      }
    }

    return new Response(JSON.stringify({ sent, total: reservations.length }), {
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
