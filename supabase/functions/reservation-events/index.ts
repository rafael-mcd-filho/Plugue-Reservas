import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface ReservationData {
  id: string;
  company_id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  occasion: string | null;
  notes: string | null;
}

function replaceTemplateVars(template: string, reservation: ReservationData): string {
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
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');
  // Add Brazil country code if not present
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

    const body = await req.json();
    const { event, reservation, waitlist } = body as { event: string; reservation?: ReservationData; waitlist?: any };

    const companyId = reservation?.company_id || waitlist?.company_id;
    if (!event || !companyId) {
      return new Response(JSON.stringify({ error: 'Missing event or data' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const results: { whatsapp?: string; webhooks?: string[] } = {};

    // 1. Send WhatsApp message if automation is enabled
    if (event === 'reservation_created' || event === 'reservation_cancelled') {
      const automationType = event === 'reservation_created' ? 'confirmation_message' : 'cancellation_message';

      const { data: automation } = await supabaseAdmin
        .from('automation_settings')
        .select('*')
        .eq('company_id', reservation.company_id)
        .eq('type', automationType)
        .eq('enabled', true)
        .maybeSingle();

      if (automation?.message_template && reservation.guest_phone) {
        // Get Evolution API settings
        const { data: settings } = await supabaseAdmin
          .from('system_settings')
          .select('key, value')
          .in('key', ['evolution_api_url', 'evolution_api_token']);

        const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
        const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

        if (evolutionUrl && evolutionToken) {
          const { data: instance } = await supabaseAdmin
            .from('company_whatsapp_instances')
            .select('instance_name, status')
            .eq('company_id', reservation.company_id)
            .maybeSingle();

          if (instance?.status === 'connected') {
            const message = replaceTemplateVars(automation.message_template, reservation);
            const phone = formatPhoneForWhatsApp(reservation.guest_phone);
            const logType = event === 'reservation_created' ? 'confirmation' : 'cancellation';

            try {
              const res = await fetch(`${evolutionUrl}/message/sendText/${instance.instance_name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
                body: JSON.stringify({ number: phone, text: message }),
              });
              const data = await res.json();
              const status = res.ok ? 'sent' : 'error';
              results.whatsapp = status;

              await supabaseAdmin.from('whatsapp_message_logs').insert({
                company_id: reservation.company_id,
                reservation_id: reservation.id,
                phone, message,
                type: logType,
                status,
                error_details: res.ok ? null : JSON.stringify(data),
              });

              // If send failed, queue for retry
              if (!res.ok) {
                await supabaseAdmin.from('whatsapp_message_queue').insert({
                  company_id: reservation.company_id,
                  reservation_id: reservation.id,
                  phone, message,
                  type: logType,
                });
              }
            } catch (err) {
              console.error('WhatsApp send error:', err);
              results.whatsapp = 'error';
              const phone = formatPhoneForWhatsApp(reservation.guest_phone);
              const message = replaceTemplateVars(automation.message_template, reservation);
              const logType = event === 'reservation_created' ? 'confirmation' : 'cancellation';

              await supabaseAdmin.from('whatsapp_message_logs').insert({
                company_id: reservation.company_id,
                reservation_id: reservation.id,
                phone, message,
                type: logType,
                status: 'error',
                error_details: String(err),
              });
              // Queue for retry
              await supabaseAdmin.from('whatsapp_message_queue').insert({
                company_id: reservation.company_id,
                reservation_id: reservation.id,
                phone, message,
                type: logType,
              });
            }
          } else {
            // Instance not connected — queue the message directly
            results.whatsapp = 'queued';
            const phone = formatPhoneForWhatsApp(reservation.guest_phone);
            const message = replaceTemplateVars(automation.message_template, reservation);
            const logType = event === 'reservation_created' ? 'confirmation' : 'cancellation';
            await supabaseAdmin.from('whatsapp_message_queue').insert({
              company_id: reservation.company_id,
              reservation_id: reservation.id,
              phone, message,
              type: logType,
            });
          }
        } else {
          results.whatsapp = 'evolution_not_configured';
        }
      }
    }

    // 2. Waitlist WhatsApp notifications
    if ((event === 'waitlist_added' || event === 'waitlist_called') && waitlist?.guest_phone) {
      const { data: settings } = await supabaseAdmin
        .from('system_settings')
        .select('key, value')
        .in('key', ['evolution_api_url', 'evolution_api_token']);

      const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
      const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

      if (evolutionUrl && evolutionToken) {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name, status')
          .eq('company_id', waitlist.company_id)
          .maybeSingle();

        const phone = formatPhoneForWhatsApp(waitlist.guest_phone);
        let message = '';

        if (event === 'waitlist_added') {
          message = `Olá ${waitlist.guest_name}! Você está na posição ${waitlist.position} da lista de espera (${waitlist.party_size} pessoa(s)).\n\n📋 Acompanhe em tempo real:\n${waitlist.tracking_url || ''}`;
        } else if (event === 'waitlist_called') {
          message = `🔔 ${waitlist.guest_name}, sua mesa está pronta! Dirija-se à recepção. Você tem 10 minutos para se apresentar.`;
        }

        const msgType = event === 'waitlist_added' ? 'waitlist_entry' : 'waitlist_called';

        if (message) {
          if (instance?.status === 'connected') {
            try {
              const res = await fetch(`${evolutionUrl}/message/sendText/${instance.instance_name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
                body: JSON.stringify({ number: phone, text: message }),
              });
              const data = await res.json();
              results.whatsapp = res.ok ? 'sent' : 'error';

              await supabaseAdmin.from('whatsapp_message_logs').insert({
                company_id: waitlist.company_id,
                phone, message,
                type: msgType,
                status: res.ok ? 'sent' : 'error',
                error_details: res.ok ? null : JSON.stringify(data),
              });

              if (!res.ok) {
                await supabaseAdmin.from('whatsapp_message_queue').insert({
                  company_id: waitlist.company_id, phone, message, type: msgType,
                });
              }
            } catch (err) {
              results.whatsapp = 'error';
              await supabaseAdmin.from('whatsapp_message_queue').insert({
                company_id: waitlist.company_id, phone, message, type: msgType,
              });
            }
          } else {
            // Not connected — queue
            results.whatsapp = 'queued';
            await supabaseAdmin.from('whatsapp_message_queue').insert({
              company_id: waitlist.company_id, phone, message, type: msgType,
            });
          }
        }
      }
    }

    // 3. Fire webhooks
    if (reservation) {
      const webhookEvent = event === 'reservation_created' ? 'reservation_created'
        : event === 'reservation_cancelled' ? 'reservation_cancelled'
        : 'status_changed';

      const { data: webhooks } = await supabaseAdmin
        .from('webhook_configs')
        .select('*')
        .eq('company_id', reservation.company_id)
        .eq('enabled', true);

    const matchingWebhooks = (webhooks || []).filter((wh: any) => {
      const events = wh.events as string[];
      return events.includes(webhookEvent);
    });

    results.webhooks = [];

    for (const wh of matchingWebhooks) {
      try {
        const webhookHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (wh.secret) {
          webhookHeaders['X-Webhook-Secret'] = wh.secret;
        }

        const res = await fetch(wh.url, {
          method: 'POST',
          headers: webhookHeaders,
          body: JSON.stringify({
            event: webhookEvent,
            timestamp: new Date().toISOString(),
            data: {
              id: reservation.id,
              company_id: reservation.company_id,
              guest_name: reservation.guest_name,
              guest_phone: reservation.guest_phone,
              guest_email: reservation.guest_email,
              date: reservation.date,
              time: reservation.time,
              party_size: reservation.party_size,
              status: reservation.status,
              occasion: reservation.occasion,
            },
          }),
        });
        await res.text(); // consume body
        results.webhooks.push(`${wh.url}: ${res.status}`);
        console.log(`Webhook ${wh.url}: ${res.status}`);
      } catch (err) {
        console.error(`Webhook error ${wh.url}:`, err);
        results.webhooks.push(`${wh.url}: error`);
      }
    }
    } // end if (reservation)

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Reservation events error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
