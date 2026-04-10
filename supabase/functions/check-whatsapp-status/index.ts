import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";

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

    // Get Evolution API settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      console.log('Evolution API not configured, skipping status check');
      return new Response(JSON.stringify({ skipped: true, reason: 'Evolution API not configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get all whatsapp instances
    const { data: instances, error: fetchError } = await supabaseAdmin
      .from('company_whatsapp_instances')
      .select('company_id, instance_name, status');

    if (fetchError || !instances || instances.length === 0) {
      console.log('No whatsapp instances found');
      return new Response(JSON.stringify({ checked: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': evolutionToken,
    };

    let updated = 0;

    for (const inst of instances) {
      try {
        const res = await fetch(`${evolutionUrl}/instance/connectionState/${inst.instance_name}`, {
          method: 'GET',
          headers,
        });

        const text = await res.text();
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = {}; }

        const isConnected = parsed?.instance?.state === 'open';
        const newStatus = isConnected ? 'connected' : 'disconnected';

        if (newStatus !== inst.status) {
          await supabaseAdmin.from('company_whatsapp_instances').update({
            status: newStatus,
            updated_at: new Date().toISOString(),
          }).eq('company_id', inst.company_id);
          updated++;
          console.log(`Instance ${inst.instance_name}: ${inst.status} -> ${newStatus}`);
        }
      } catch (err) {
        console.error(`Error checking instance ${inst.instance_name}:`, err);
      }
    }

    return new Response(JSON.stringify({ checked: instances.length, updated }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('check-whatsapp-status error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
