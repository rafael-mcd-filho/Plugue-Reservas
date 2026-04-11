import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildEvolutionNotConfiguredFailure,
  buildInstanceDisconnectedFailure,
  buildInstanceNotConfiguredFailure,
  sendWhatsAppText,
  serializeWhatsAppFailure,
} from "../_shared/whatsapp.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function normalizeOptionalCompanyId(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeEffectiveRole(value: unknown) {
  return value === 'admin' || value === 'operator' ? value : null;
}

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

    const body = await req.json();
    const { action, company_id, instance_name, phone, message, log_id } = body;
    const scopeCompanyId = normalizeOptionalCompanyId(body.scope_company_id);
    const impersonatedBySuperadmin = body.impersonated_by_superadmin === true;
    const effectiveRole = normalizeEffectiveRole(body.effective_role);

    if (!company_id) {
      return new Response(JSON.stringify({ error: 'company_id é obrigatório' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: memberships, error: membershipsError } = await supabaseAdmin
      .from('user_roles')
      .select('role, company_id')
      .eq('user_id', userData.user.id);

    if (membershipsError) {
      return new Response(JSON.stringify({ error: membershipsError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const roleRows = memberships ?? [];
    const isSuperadmin = roleRows.some((row: any) => row.role === 'superadmin');
    const adminCompanyIds = [...new Set(
      roleRows
        .filter((row: any) => row.role === 'admin' && row.company_id)
        .map((row: any) => row.company_id as string)
    )];

    if (!isSuperadmin && adminCompanyIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Apenas admins e superadmins podem gerenciar a Evolution API' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const allowedCompanyIds = isSuperadmin
      ? (scopeCompanyId ? [scopeCompanyId] : null)
      : adminCompanyIds;

    if (allowedCompanyIds && !allowedCompanyIds.includes(company_id)) {
      return new Response(JSON.stringify({ error: 'Acesso negado para esta empresa no contexto atual' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (isSuperadmin && scopeCompanyId && impersonatedBySuperadmin && effectiveRole !== 'admin') {
      return new Response(JSON.stringify({ error: 'Operadores impersonados nao podem gerenciar a Evolution API' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'clear_logs') {
      const { error } = await supabaseAdmin
        .from('whatsapp_message_logs')
        .delete()
        .eq('company_id', company_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'clear_queue') {
      const { error } = await supabaseAdmin
        .from('whatsapp_message_queue')
        .delete()
        .eq('company_id', company_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get Evolution API settings from system_settings
    const { data: settings } = await supabaseAdmin
      .from('system_settings')
      .select('key, value')
      .in('key', ['evolution_api_url', 'evolution_api_token']);

    const evolutionUrl = settings?.find((s: any) => s.key === 'evolution_api_url')?.value?.replace(/\/+$/, '');
    const evolutionToken = settings?.find((s: any) => s.key === 'evolution_api_token')?.value;

    if (!evolutionUrl || !evolutionToken) {
      if (action === 'send_message' || action === 'resend_message') {
        const failure = buildEvolutionNotConfiguredFailure();
        if (action === 'resend_message' && log_id && !failure.ok) {
          await supabaseAdmin.from('whatsapp_message_logs')
            .update({ status: 'error', error_details: serializeWhatsAppFailure(failure.error) })
            .eq('id', log_id);
        }

        return new Response(JSON.stringify(
          failure.ok
            ? { ok: true, data: failure.data }
            : {
                ok: false,
                error_code: failure.error.code,
                error_title: failure.error.title,
                error_message: failure.error.message,
              }
        ), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'Evolution API não configurada. Configure URL e token nas configurações do sistema.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

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

        const instanceName = instance?.instance_name || instance_name || `company_${company_id}`;

        // Try to connect and get QR
        let res = await fetch(`${evolutionUrl}/instance/connect/${instanceName}`, {
          method: 'GET',
          headers,
        });

        let responseText = await res.text();
        console.log('get_qrcode response status:', res.status);
        console.log('get_qrcode response body:', responseText);

        // If instance doesn't exist on Evolution side, recreate it
        if (res.status === 404) {
          console.log('Instance not found on Evolution, recreating...');
          const createRes = await fetch(`${evolutionUrl}/instance/create`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              instanceName: instanceName,
              integration: 'WHATSAPP-BAILEYS',
              qrcode: true,
            }),
          });
          const createText = await createRes.text();
          console.log('recreate instance response:', createRes.status, createText);

          let createParsed: any;
          try { createParsed = JSON.parse(createText); } catch { createParsed = {}; }

          // Save/update instance in DB
          await supabaseAdmin.from('company_whatsapp_instances').upsert({
            company_id,
            instance_name: instanceName,
            status: 'connecting',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'company_id' });

          // If create returned QR, use it directly
          const qrBase64 = createParsed?.qrcode?.base64 || createParsed?.base64;
          const qrCode = createParsed?.qrcode?.pairingCode || createParsed?.pairingCode || createParsed?.code;
          if (qrBase64 || qrCode) {
            result = { base64: qrBase64 || null, code: qrCode || null, pairingCode: qrCode || null };
            break;
          }

          // Otherwise try connect again
          res = await fetch(`${evolutionUrl}/instance/connect/${instanceName}`, {
            method: 'GET',
            headers,
          });
          responseText = await res.text();
          console.log('get_qrcode retry response:', res.status, responseText);
        }
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

      case 'send_message':
      case 'resend_message': {
        const { data: instance } = await supabaseAdmin
          .from('company_whatsapp_instances')
          .select('instance_name, status')
          .eq('company_id', company_id)
          .maybeSingle();

        if (!instance) {
          const failure = buildInstanceNotConfiguredFailure();
          if (action === 'resend_message' && log_id && !failure.ok) {
            await supabaseAdmin.from('whatsapp_message_logs')
              .update({ status: 'error', error_details: serializeWhatsAppFailure(failure.error) })
              .eq('id', log_id);
          }
          result = failure.ok ? { ok: true, data: failure.data } : {
            ok: false,
            error_code: failure.error.code,
            error_title: failure.error.title,
            error_message: failure.error.message,
          };
          break;
        }

        if (instance.status !== 'connected') {
          const failure = buildInstanceDisconnectedFailure();
          if (action === 'resend_message' && log_id && !failure.ok) {
            await supabaseAdmin.from('whatsapp_message_logs')
              .update({ status: 'error', error_details: serializeWhatsAppFailure(failure.error) })
              .eq('id', log_id);
          }
          result = failure.ok ? { ok: true, data: failure.data } : {
            ok: false,
            error_code: failure.error.code,
            error_title: failure.error.title,
            error_message: failure.error.message,
          };
          break;
        }

        const sendResult = await sendWhatsAppText(
          evolutionUrl,
          evolutionToken,
          instance.instance_name,
          phone,
          message,
        );

        if (action === 'resend_message' && log_id) {
          if (sendResult.ok) {
            await supabaseAdmin.from('whatsapp_message_logs')
              .update({ status: 'sent', error_details: null })
              .eq('id', log_id);
          } else {
            await supabaseAdmin.from('whatsapp_message_logs')
              .update({ status: 'error', error_details: serializeWhatsAppFailure(sendResult.error) })
              .eq('id', log_id);
          }
        }

        result = sendResult.ok ? { ok: true, data: sendResult.data } : {
          ok: false,
          error_code: sendResult.error.code,
          error_title: sendResult.error.title,
          error_message: sendResult.error.message,
          provider_status: sendResult.error.provider_status,
          provider_message: sendResult.error.provider_message,
        };
        break;
      }

      case 'clear_logs': {
        const { error } = await supabaseAdmin
          .from('whatsapp_message_logs')
          .delete()
          .eq('company_id', company_id);

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        result = { ok: true };
        break;
      }

      case 'clear_queue': {
        const { error } = await supabaseAdmin
          .from('whatsapp_message_queue')
          .delete()
          .eq('company_id', company_id);

        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        result = { ok: true };
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
