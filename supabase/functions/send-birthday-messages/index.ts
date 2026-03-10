import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const todayMonth = String(now.getMonth() + 1).padStart(2, '0');
    const todayDay = String(now.getDate()).padStart(2, '0');
    const todayMMDD = `${todayMonth}-${todayDay}`;
    const todayStr = now.toISOString().split('T')[0];

    console.log(`Birthday check for day: ${todayMMDD}`);

    // Find all reservations with guest_birthdate matching today's MM-DD
    const { data: birthdayReservations } = await supabaseAdmin
      .from('reservations')
      .select('guest_name, guest_phone, guest_birthdate, company_id')
      .not('guest_birthdate', 'is', null)
      .not('guest_phone', 'is', null);

    if (!birthdayReservations || birthdayReservations.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no_birthdate_data' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const todayBirthdays = birthdayReservations.filter((r: any) => {
      if (!r.guest_birthdate) return false;
      return r.guest_birthdate.substring(5) === todayMMDD;
    });

    if (todayBirthdays.length === 0) {
      console.log('No birthdays today');
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Deduplicate by phone+company
    const uniqueMap = new Map<string, any>();
    for (const r of todayBirthdays) {
      const key = `${r.guest_phone}:${r.company_id}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, r);
    }
    const uniqueBirthdays = Array.from(uniqueMap.values());

    console.log(`Found ${uniqueBirthdays.length} unique birthday contacts`);

    const companyIds = [...new Set(uniqueBirthdays.map((r: any) => r.company_id))];

    const [{ data: automations }, { data: instances }] = await Promise.all([
      supabaseAdmin
        .from('automation_settings')
        .select('*')
        .in('company_id', companyIds)
        .eq('type', 'birthday_message')
        .eq('enabled', true),
      supabaseAdmin
        .from('company_whatsapp_instances')
        .select('*')
        .in('company_id', companyIds),
    ]);

    const instanceMap = new Map((instances || []).map((i: any) => [i.company_id, i]));

    // Check already-sent or queued birthday messages today
    const { data: alreadySent } = await supabaseAdmin
      .from('whatsapp_message_logs')
      .select('phone, company_id')
      .eq('type', 'birthday')
      .gte('created_at', todayStr + 'T00:00:00')
      .eq('status', 'sent');

    const { data: alreadyQueued } = await supabaseAdmin
      .from('whatsapp_message_queue')
      .select('phone, company_id')
      .eq('type', 'birthday')
      .gte('created_at', todayStr + 'T00:00:00');

    const sentSet = new Set([
      ...(alreadySent || []).map((l: any) => `${l.phone}:${l.company_id}`),
      ...(alreadyQueued || []).map((l: any) => `${l.phone}:${l.company_id}`),
    ]);

    let sent = 0;
    let queued = 0;

    for (const contact of uniqueBirthdays) {
      const automation = (automations || []).find((a: any) => a.company_id === contact.company_id);
      if (!automation) continue;

      const phone = formatPhoneForWhatsApp(contact.guest_phone);
      const sentKey = `${phone}:${contact.company_id}`;
      if (sentSet.has(sentKey)) {
        console.log(`Already sent/queued birthday to ${phone}`);
        continue;
      }

      const message = automation.message_template
        .replace(/\{nome\}/g, contact.guest_name || '');

      const instance = instanceMap.get(contact.company_id);

      if (instance?.status === 'connected') {
        try {
          const res = await fetch(`${evolutionUrl}/message/sendText/${instance.instance_name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
            body: JSON.stringify({ number: phone, text: message }),
          });
          const data = await res.json();

          await supabaseAdmin.from('whatsapp_message_logs').insert({
            company_id: contact.company_id,
            phone, message,
            type: 'birthday',
            status: res.ok ? 'sent' : 'error',
            error_details: res.ok ? null : JSON.stringify(data),
          });

          if (res.ok) {
            sent++;
          } else {
            // Queue for retry
            await supabaseAdmin.from('whatsapp_message_queue').insert({
              company_id: contact.company_id, phone, message, type: 'birthday',
            });
            queued++;
          }
        } catch (err) {
          await supabaseAdmin.from('whatsapp_message_logs').insert({
            company_id: contact.company_id, phone, message,
            type: 'birthday', status: 'error', error_details: String(err),
          });
          await supabaseAdmin.from('whatsapp_message_queue').insert({
            company_id: contact.company_id, phone, message, type: 'birthday',
          });
          queued++;
        }
      } else {
        // Not connected — queue directly
        await supabaseAdmin.from('whatsapp_message_queue').insert({
          company_id: contact.company_id, phone, message, type: 'birthday',
        });
        queued++;
        console.log(`Queued birthday for ${phone} (instance not connected)`);
      }
    }

    return new Response(JSON.stringify({ sent, queued, total: uniqueBirthdays.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Birthday messages error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
