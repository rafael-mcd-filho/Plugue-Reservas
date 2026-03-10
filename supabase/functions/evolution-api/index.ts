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

    // Verify user token
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    // Get Evolution API settings from system_settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      return new Response(JSON.stringify({ error: 'Evolution API não configurada. Configure URL e token nas configurações do sistema.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json();
    const { action, company_id, instance_name, phone, message } = body;

    const headers: Record<string, string> = {
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
        
        const responseText = await res.text();
        console.log('create_instance response status:', res.status);
        console.log('create_instance response body:', responseText);
        
        let parsed: any;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          return new Response(JSON.stringify({ error: `Evolution API retornou resposta inválida: ${responseText.substring(0, 200)}` }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (!res.ok) {
          // If instance already exists, that's ok — we'll get QR on connect
          const isAlreadyExists = responseText.includes('already') || responseText.includes('exists') || res.status === 403;
          if (!isAlreadyExists) {
            return new Response(JSON.stringify({ error: `Erro ao criar instância: ${parsed?.message || parsed?.error || responseText.substring(0, 200)}` }), {
              status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }

        // Save instance to DB
        await supabaseAdmin.from('company_whatsapp_instances').upsert({
          company_id,
          instance_name: name,
          status: 'connecting',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'company_id' });

        // The create response with qrcode:true may contain qrcode data
        // Evolution API v2 returns it in various formats
        const qrBase64 = parsed?.qrcode?.base64 || parsed?.base64 || parsed?.qr?.base64;
        const qrCode = parsed?.qrcode?.code || parsed?.code || parsed?.qr?.code || parsed?.qrcode?.pairingCode;

        result = { 
          ...parsed, 
          base64: qrBase64 || null,
          code: qrCode || null,
          instance_created: true,
        };
        break;
      }

      case 'get_qrcode': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name')
          .eq('company_id', company_id)
          .maybeSingle();

        if (!instance) {
          return new Response(JSON.stringify({ error: 'Instância não encontrada. Crie a instância primeiro.' }), {
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const res = await fetch(`${evolutionUrl}/instance/connect/${instance.instance_name}`, {
          method: 'GET',
          headers,
        });

        const responseText = await res.text();
        console.log('get_qrcode response status:', res.status);
        console.log('get_qrcode response body:', responseText);

        if (!res.ok) {
          return new Response(JSON.stringify({ error: `Erro ao obter QR Code (${res.status}): ${responseText.substring(0, 200)}` }), {
            status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        let parsed: any;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          return new Response(JSON.stringify({ error: `Resposta inválida da Evolution API` }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // v2 connect endpoint returns { base64, code, pairingCode, count }
        const qrBase64 = parsed?.base64 || parsed?.qrcode?.base64;
        const qrCode = parsed?.code || parsed?.pairingCode;

        result = { 
          base64: qrBase64 || null,
          code: qrCode || null,
          pairingCode: parsed?.pairingCode || null,
        };
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
        
        const responseText = await res.text();
        console.log('check_status response:', responseText);
        
        let parsed: any;
        try { parsed = JSON.parse(responseText); } catch { parsed = {}; }
        result = parsed;

        // Update status in DB
        const isConnected = parsed?.instance?.state === 'open';
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
