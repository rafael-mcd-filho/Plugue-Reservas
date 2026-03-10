import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    // Simple lock: check if there's a message currently being processed (last_attempt_at within last 3 min and status pending)
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: processing } = await supabaseAdmin
      .from('whatsapp_message_queue')
      .select('id')
      .eq('status', 'pending')
      .gte('last_attempt_at', threeMinAgo)
      .limit(1);

    if (processing && processing.length > 0) {
      console.log('Another process appears to be running, skipping');
      return new Response(JSON.stringify({ skipped: true, reason: 'another_process_running' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get Evolution API settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ skipped: true, reason: 'Evolution API not configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get all connected whatsapp instances
    const { data: instances } = await supabaseAdmin
      .from('company_whatsapp_instances')
      .select('company_id, instance_name, status')
      .eq('status', 'connected');

    if (!instances || instances.length === 0) {
      console.log('No connected instances, nothing to process');
      return new Response(JSON.stringify({ processed: 0, reason: 'no_connected_instances' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const connectedCompanyIds = instances.map(i => i.company_id);
    const instanceMap = new Map(instances.map(i => [i.company_id, i.instance_name]));

    // Expire old messages first
    await supabaseAdmin
      .from('whatsapp_message_queue')
      .update({ status: 'failed', error_details: 'Expired after 2 hours' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());

    // Get pending messages for connected companies that haven't expired
    const { data: pendingMessages } = await supabaseAdmin
      .from('whatsapp_message_queue')
      .select('*')
      .in('company_id', connectedCompanyIds)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(10);

    if (!pendingMessages || pendingMessages.length === 0) {
      // Also expire old messages
      await supabaseAdmin
        .from('whatsapp_message_queue')
        .update({ status: 'failed', error_details: 'Expired after 2 hours' })
        .eq('status', 'pending')
        .lt('expires_at', new Date().toISOString());

      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let sent = 0;
    let failed = 0;

    for (const msg of pendingMessages) {
      const instanceName = instanceMap.get(msg.company_id);
      if (!instanceName) continue;

      // Random delay between 40 seconds and 2 minutes (only between messages, not the first)
      if (sent > 0) {
        const delayMs = Math.floor(Math.random() * (120000 - 40000 + 1)) + 40000;
        console.log(`Waiting ${Math.round(delayMs/1000)}s before next message...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      try {
        const res = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': evolutionToken },
          body: JSON.stringify({ number: msg.phone, text: msg.message }),
        });

        const data = await res.json();

        if (res.ok) {
          // Mark as sent
          await supabaseAdmin.from('whatsapp_message_queue').update({
            status: 'sent',
            last_attempt_at: new Date().toISOString(),
            attempts: msg.attempts + 1,
          }).eq('id', msg.id);

          // Log success
          await supabaseAdmin.from('whatsapp_message_logs').insert({
            company_id: msg.company_id,
            reservation_id: msg.reservation_id,
            phone: msg.phone,
            message: msg.message,
            type: msg.type,
            status: 'sent',
          });

          sent++;
          console.log(`Queue message sent: ${msg.id}`);
        } else {
          const newAttempts = msg.attempts + 1;
          await supabaseAdmin.from('whatsapp_message_queue').update({
            attempts: newAttempts,
            last_attempt_at: new Date().toISOString(),
            error_details: JSON.stringify(data),
            status: newAttempts >= msg.max_attempts ? 'failed' : 'pending',
          }).eq('id', msg.id);
          failed++;
        }
      } catch (err) {
        const newAttempts = msg.attempts + 1;
        await supabaseAdmin.from('whatsapp_message_queue').update({
          attempts: newAttempts,
          last_attempt_at: new Date().toISOString(),
          error_details: String(err),
          status: newAttempts >= msg.max_attempts ? 'failed' : 'pending',
        }).eq('id', msg.id);
        failed++;
      }
    }

    return new Response(JSON.stringify({ processed: pendingMessages.length, sent, failed }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('process-message-queue error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
