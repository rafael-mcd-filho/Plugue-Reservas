import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import {
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  formatPhoneForWhatsApp,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";
import { formatDateKeyInTimeZone, formatMonthDayInTimeZone } from "../_shared/timezone.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-job-secret',
};

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
    const todayMMDD = formatMonthDayInTimeZone(now);
    const todayStr = formatDateKeyInTimeZone(now);

    console.log(`Birthday check for day: ${todayMMDD}`);

    const [
      { data: birthdayReservations },
      { data: birthdayCompanions },
      { data: birthdayWaitlistHolders },
      { data: birthdayWaitlistCompanions },
    ] = await Promise.all([
      supabaseAdmin
        .from('reservations')
        .select('guest_name, guest_phone, guest_birthdate, company_id')
        .not('guest_birthdate', 'is', null)
        .not('guest_phone', 'is', null),
      supabaseAdmin
        .from('reservation_companions')
        .select('name, phone, birthdate, company_id')
        .not('birthdate', 'is', null)
        .not('phone', 'is', null),
      supabaseAdmin
        .from('waitlist')
        .select('guest_name, guest_phone, guest_birthdate, company_id')
        .eq('status', 'seated')
        .not('guest_birthdate', 'is', null)
        .not('guest_phone', 'is', null),
      supabaseAdmin
        .from('waitlist_companions')
        .select('name, phone, birthdate, company_id')
        .not('birthdate', 'is', null)
        .not('phone', 'is', null),
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
      return new Response(JSON.stringify({ sent: 0, reason: 'no_birthdate_data' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const todayBirthdays = birthdayContacts.filter((r: any) => {
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

      if (!instance) {
        const failure = buildInstanceNotConfiguredFailure();
        await supabaseAdmin.from('whatsapp_message_queue').insert({
          company_id: contact.company_id,
          phone,
          message,
          type: 'birthday',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        queued++;
        console.log(`Queued birthday for ${phone} (instance not configured)`);
        continue;
      }

      if (instance.status !== 'connected') {
        const failure = buildInstanceDisconnectedFailure();
        await supabaseAdmin.from('whatsapp_message_queue').insert({
          company_id: contact.company_id,
          phone,
          message,
          type: 'birthday',
          error_details: serializeWhatsAppFailure(failure.error),
        });
        queued++;
        console.log(`Queued birthday for ${phone} (instance not connected)`);
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
        await supabaseAdmin.from('whatsapp_message_logs').insert({
          company_id: contact.company_id,
          phone,
          message,
          type: 'birthday',
          status: 'sent',
          error_details: null,
        });
        sent++;
        continue;
      }

      const serializedError = serializeWhatsAppFailure(result.error);
      await supabaseAdmin.from('whatsapp_message_logs').insert({
        company_id: contact.company_id,
        phone,
        message,
        type: 'birthday',
        status: 'error',
        error_details: serializedError,
      });
      await supabaseAdmin.from('whatsapp_message_queue').insert({
        company_id: contact.company_id,
        phone,
        message,
        type: 'birthday',
        error_details: serializedError,
      });
      queued++;
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
