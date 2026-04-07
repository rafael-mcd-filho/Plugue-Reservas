import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";

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

function formatPhoneForWhatsApp(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('55') && digits.length <= 11) digits = '55' + digits;
  return digits;
}

async function getEvolutionConfig(supabaseAdmin: any) {
  const { data: settings } = await supabaseAdmin
    .from('system_settings')
    .select('key, value')
    .in('key', ['evolution_api_url', 'evolution_api_token']);

  const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
  const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;
  return { evolutionUrl, evolutionToken };
}

async function sendWhatsAppMessage(
  evolutionUrl: string, evolutionToken: string, instanceName: string,
  phone: string, message: string
): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
    body: JSON.stringify({ number: phone, text: message }),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!isAuthorizedInternalJob(req)) {
      return new Response(JSON.stringify({ error: 'Nao autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createSupabaseAdminClient();

    const { evolutionUrl, evolutionToken } = await getEvolutionConfig(supabaseAdmin);
    if (!evolutionUrl || !evolutionToken) {
      console.log('Evolution API not configured, skipping reminders');
      return new Response(JSON.stringify({ skipped: true, reason: 'evolution_not_configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

    // === 1H REMINDERS (today, 55-65 min from now) ===
    const min55 = new Date(now.getTime() + 55 * 60 * 1000);
    const min65 = new Date(now.getTime() + 65 * 60 * 1000);
    const timeFrom1h = `${String(min55.getHours()).padStart(2, '0')}:${String(min55.getMinutes()).padStart(2, '0')}:00`;
    const timeTo1h = `${String(min65.getHours()).padStart(2, '0')}:${String(min65.getMinutes()).padStart(2, '0')}:00`;

    // === 24H REMINDERS (tomorrow, same time window as now ±5min) ===
    const timeFrom24h = `${String(now.getHours()).padStart(2, '0')}:${String(Math.max(0, now.getMinutes() - 5)).padStart(2, '0')}:00`;
    const timeTo24h = `${String(now.getHours()).padStart(2, '0')}:${String(Math.min(59, now.getMinutes() + 5)).padStart(2, '0')}:00`;

    console.log(`1h reminders: ${todayStr} ${timeFrom1h}-${timeTo1h}`);
    console.log(`24h reminders: ${tomorrowStr} all confirmed reservations`);

    // Fetch both sets of reservations
    const [res1h, res24h] = await Promise.all([
      supabaseAdmin
        .from('reservations')
        .select('*')
        .eq('date', todayStr)
        .eq('status', 'confirmed')
        .gte('time', timeFrom1h)
        .lte('time', timeTo1h),
      supabaseAdmin
        .from('reservations')
        .select('*')
        .eq('date', tomorrowStr)
        .eq('status', 'confirmed'),
    ]);

    const reservations1h = res1h.data || [];
    const reservations24h = res24h.data || [];

    // For 24h reminders: skip if reservation was created less than 24h before the reservation time
    // (i.e., don't send a 24h reminder if the person just booked for tomorrow)
    const filtered24h = reservations24h.filter((r: any) => {
      const createdAt = new Date(r.created_at);
      const [rh, rm] = (r.time || '00:00').split(':').map(Number);
      const reservationDatetime = new Date(`${r.date}T${String(rh).padStart(2,'0')}:${String(rm).padStart(2,'0')}:00`);
      const hoursUntilReservation = (reservationDatetime.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
      // Only send 24h reminder if reservation was made at least 24h before
      if (hoursUntilReservation < 24) {
        console.log(`Skipping 24h reminder for ${r.id}: booked only ${hoursUntilReservation.toFixed(1)}h before`);
        return false;
      }
      return true;
    });

    console.log(`Found ${reservations1h.length} 1h reminders, ${filtered24h.length} 24h reminders (${reservations24h.length - filtered24h.length} skipped)`);

    // Collect all company IDs
    const allReservations = [
      ...reservations1h.map((r: any) => ({ ...r, _reminderType: 'reminder_1h' })),
      ...filtered24h.map((r: any) => ({ ...r, _reminderType: 'reminder_24h' })),
    ];

    if (allReservations.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const companyIds = [...new Set(allReservations.map((r: any) => r.company_id))];

    // Get automations for both types
    const { data: automations } = await supabaseAdmin
      .from('automation_settings')
      .select('*')
      .in('company_id', companyIds)
      .in('type', ['reminder_1h', 'reminder_24h'])
      .eq('enabled', true);

    // Get WhatsApp instances
    const { data: instances } = await supabaseAdmin
      .from('company_whatsapp_instances')
      .select('*')
      .in('company_id', companyIds)
      .eq('status', 'connected');

    const instanceMap = new Map((instances || []).map((i: any) => [i.company_id, i]));

    // Check already-sent reminders to avoid duplicates
    const reservationIds = allReservations.map((r: any) => r.id);
    const { data: alreadySent } = await supabaseAdmin
      .from('whatsapp_message_logs')
      .select('reservation_id, type')
      .in('reservation_id', reservationIds)
      .in('type', ['reminder_1h', 'reminder_24h'])
      .eq('status', 'sent');

    const sentSet = new Set((alreadySent || []).map((l: any) => `${l.reservation_id}:${l.type}`));

    let sent = 0;
    const errors: string[] = [];

    for (const reservation of allReservations) {
      const reminderType = reservation._reminderType;
      const key = `${reservation.id}:${reminderType}`;

      if (sentSet.has(key)) {
        console.log(`Skipping duplicate ${reminderType} for ${reservation.id}`);
        continue;
      }

      const automation = (automations || []).find(
        (a: any) => a.company_id === reservation.company_id && a.type === reminderType
      );
      const instance = instanceMap.get(reservation.company_id);

      if (!automation || !instance) continue;

      const message = replaceTemplateVars(automation.message_template, reservation);
      const phone = formatPhoneForWhatsApp(reservation.guest_phone);

      try {
        const result = await sendWhatsAppMessage(evolutionUrl, evolutionToken, instance.instance_name, phone, message);
        const status = result.ok ? 'sent' : 'error';

        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone, message,
          type: reminderType,
          status,
          error_details: result.ok ? null : JSON.stringify(result.data),
        });

        if (result.ok) {
          sent++;
          console.log(`${reminderType} sent to ${phone} for reservation ${reservation.id}`);
        } else {
          errors.push(`${reservation.id}: ${JSON.stringify(result.data)}`);
        }
      } catch (err) {
        errors.push(`${reservation.id}: ${err}`);
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: reservation.company_id,
          reservation_id: reservation.id,
          phone, message,
          type: reminderType,
          status: 'error',
          error_details: String(err),
        });
      }
    }

    return new Response(JSON.stringify({ sent, total: allReservations.length, errors }), {
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
