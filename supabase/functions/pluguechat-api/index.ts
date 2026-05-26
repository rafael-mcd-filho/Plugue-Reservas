import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json() as Record<string, unknown>;
    const action = body.action as string;
    const companyId = body.company_id as string;

    if (!companyId) {
      return new Response(JSON.stringify({ error: "company_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verifica se o usuário tem acesso à empresa
    const { data: roleData } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("company_id", companyId)
      .in("role", ["admin", "operator"])
      .maybeSingle();

    const { data: isSuperAdmin } = await supabaseAdmin.rpc("has_role", {
      _user_id: user.id,
      _role: "superadmin",
    });

    if (!roleData && !isSuperAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ----------------------------------------------------------------
    // action: save_config
    // Salva número remetente e, se informado, criptografa e salva token
    // ----------------------------------------------------------------
    if (action === "save_config") {
      const fromNumber = normalizePhone(String(body.from_number ?? ""));
      const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : null;

      if (!fromNumber) {
        return new Response(JSON.stringify({ error: "from_number required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const upsertPayload: Record<string, unknown> = {
        company_id: companyId,
        from_number: fromNumber,
        status: "configured",
        updated_at: new Date().toISOString(),
      };

      // O token é armazenado em texto simples por ora (produção deve usar vault/secrets)
      // Nunca é exposto de volta ao frontend (a coluna não é selecionada nas queries do cliente)
      if (apiToken) {
        upsertPayload.api_token_encrypted = apiToken;
      }

      const { error } = await supabaseAdmin
        .from("pluguechat_official_configs")
        .upsert(upsertPayload, { onConflict: "company_id" });

      if (error) {
        console.error("pluguechat-api save_config error", error);
        return new Response(JSON.stringify({ error: "Erro ao salvar configuração." }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("pluguechat-api unexpected error", err);
    return new Response(JSON.stringify({ error: "Erro interno." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
