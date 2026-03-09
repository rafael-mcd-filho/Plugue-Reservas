import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    // Get Evolution API settings from system_settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value;
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ error: 'Evolution API não configurada. Configure URL e token nas configurações do sistema.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { action, company_id, instance_name, phone, message } = body;

    const headers = {
      'Content-Type': 'application/json',
      'apikey': evolutionToken,
    };

    let result: any;

    switch (action) {
      case 'create_instance': {
        const name = instance_name || `company_${company_id}`;
        const res = await fetch(`${evolutionUrl}/instance/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            instanceName: name,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true,
          }),
        });
        result = await res.json();

        // Save instance to DB
        await supabaseAdmin.from('company_whatsapp_instances').upsert({
          company_id,
          instance_name: name,
          status: 'connecting',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'company_id' });

        break;
      }

      case 'get_qrcode': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name')
          .eq('company_id', company_id)
          .maybeSingle();

        if (!instance) {
          return new Response(JSON.stringify({ error: 'Instância não encontrada' }), {
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const res = await fetch(`${evolutionUrl}/instance/connect/${instance.instance_name}`, {
          method: 'GET',
          headers,
        });
        result = await res.json();
        break;
      }

      case 'check_status': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name')
          .eq('company_id', company_id)
          .maybeSingle();

        if (!instance) {
          return new Response(JSON.stringify({ status: 'no_instance' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const res = await fetch(`${evolutionUrl}/instance/connectionState/${instance.instance_name}`, {
          method: 'GET',
          headers,
        });
        result = await res.json();

        // Update status in DB
        const isConnected = result?.instance?.state === 'open';
        await supabaseAdmin.from('company_whatsapp_instances').update({
          status: isConnected ? 'connected' : 'disconnected',
          updated_at: new Date().toISOString(),
        }).eq('company_id', company_id);

        break;
      }

      case 'send_message': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name')
          .eq('company_id', company_id)
          .maybeSingle();

        if (!instance) {
          return new Response(JSON.stringify({ error: 'WhatsApp não conectado' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const res = await fetch(`${evolutionUrl}/message/sendText/${instance.instance_name}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            number: phone,
            text: message,
          }),
        });
        result = await res.json();
        break;
      }

      case 'disconnect': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name')
          .eq('company_id', company_id)
          .maybeSingle();

        if (instance) {
          await fetch(`${evolutionUrl}/instance/logout/${instance.instance_name}`, {
            method: 'DELETE',
            headers,
          });

          await supabaseAdmin.from('company_whatsapp_instances').update({
            status: 'disconnected',
            updated_at: new Date().toISOString(),
          }).eq('company_id', company_id);
        }

        result = { success: true };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: 'Ação inválida' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Evolution API error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
