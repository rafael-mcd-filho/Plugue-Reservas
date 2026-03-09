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
  if (!digits.startsWith('55') && digits.length <= 11) {
    digits = '55' + digits;
  }
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

    // Get Evolution API settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value;
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      console.log('Evolution API not configured, skipping reminders');
      return new Response(JSON.stringify({ skipped: true, reason: 'evolution_not_configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Find reservations happening in the next 55-65 minutes (to catch the ~1h window)
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    
    // Calculate time window: 55-65 minutes from now
    const min55 = new Date(now.getTime() + 55 * 60 * 1000);
    const min65 = new Date(now.getTime() + 65 * 60 * 1000);
    
    const timeFrom = `${String(min55.getHours()).padStart(2, '0')}:${String(min55.getMinutes()).padStart(2, '0')}:00`;
    const timeTo = `${String(min65.getHours()).padStart(2, '0')}:${String(min65.getMinutes()).padStart(2, '0')}:00`;

    console.log(`Checking reminders for ${todayStr} between ${timeFrom} and ${timeTo}`);

    // Get confirmed reservations in this window
    const { data: reservations, error: resErr } = await supabaseAdmin
      .from('reservations')
      .select('*')
      .eq('date', todayStr)
      .eq('status', 'confirmed')
      .gte('time', timeFrom)
      .lte('time', timeTo);

    if (resErr) {
      console.error('Error fetching reservations:', resErr);
      throw resErr;
    }

    if (!reservations || reservations.length === 0) {
      console.log('No reservations found in the window');
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`Found ${reservations.length} reservations for reminders`);

    // Group by company_id to batch automation lookups
    const companyIds = [...new Set(reservations.map((r: any) => r.company_id))];

    // Get reminder automations for these companies
    const { data: automations } = await supabaseAdmin
      .from('automation_settings')
      .select('*')
      .in('company_id', companyIds)
      .eq('type', 'reminder_1h')
      .eq('enabled', true);

    if (!automations || automations.length === 0) {
      console.log('No reminder automations enabled');
      return new Response(JSON.stringify({ sent: 0, reason: 'no_automations_enabled' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const automationMap = new Map(automations.map((a: any) => [a.company_id, a]));

    // Get WhatsApp instances for these companies
    const { data: instances } = await supabaseAdmin
      .from('company_whatsapp_instances')
      .select('*')
      .in('company_id', companyIds)
      .eq('status', 'connected');

    const instanceMap = new Map((instances || []).map((i: any) => [i.company_id, i]));

    let sent = 0;
    const errors: string[] = [];

    for (const reservation of reservations) {
      const automation = automationMap.get(reservation.company_id);
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
        const status = res.ok ? 'sent' : 'error';

        // Log message
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'reminder_1h',
          status,
          error_details: res.ok ? null : JSON.stringify(data),
        });

        if (res.ok) {
          sent++;
          console.log(`Reminder sent to ${phone} for reservation ${reservation.id}`);
        } else {
          errors.push(`${reservation.id}: ${JSON.stringify(data)}`);
          console.error(`Failed to send reminder for ${reservation.id}:`, data);
        }
      } catch (err) {
        errors.push(`${reservation.id}: ${err}`);
        console.error(`Error sending reminder for ${reservation.id}:`, err);
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone,
          message,
          type: 'reminder_1h',
          status: 'error',
          error_details: String(err),
        });
      }
    }

    return new Response(JSON.stringify({ sent, total: reservations.length, errors }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Send reminders error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
