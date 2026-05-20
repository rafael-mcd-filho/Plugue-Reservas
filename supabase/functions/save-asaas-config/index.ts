import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import { validateAsaasPaymentLinksAccess } from "../_shared/asaas.ts";
import { corsHeaders, jsonResponse, readJson } from "../_shared/reservation-payments.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const body = await readJson(req);
    const companyId = typeof body.company_id === "string" ? body.company_id : null;
    const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : "";

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);
    if (!apiToken) return jsonResponse({ error: "Token Asaas obrigatorio" }, 400);

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, ["admin"]);

    let status = "configured";
    let lastError: string | null = null;
    try {
      await validateAsaasPaymentLinksAccess(apiToken);
    } catch (error: any) {
      status = "error";
      lastError = error?.message || "Nao foi possivel validar o token Asaas";
    }

    const { data: existing } = await supabaseAdmin
      .from("company_asaas_configs")
      .select("webhook_auth_token")
      .eq("company_id", companyId)
      .maybeSingle();

    const { data, error } = await supabaseAdmin
      .from("company_asaas_configs")
      .upsert({
        company_id: companyId,
        provider: "asaas",
        api_token: apiToken,
        webhook_auth_token: existing?.webhook_auth_token ?? crypto.randomUUID().replaceAll("-", ""),
        status,
        last_validated_at: new Date().toISOString(),
        last_error: lastError,
      }, { onConflict: "company_id" })
      .select("company_id, status, webhook_auth_token, last_validated_at, last_error")
      .single();

    if (error) throw new Error(error.message);

    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");

    return jsonResponse({
      status: data.status,
      last_validated_at: data.last_validated_at,
      last_error: data.last_error,
      webhook_url: supabaseUrl ? `${supabaseUrl}/functions/v1/asaas-webhook` : null,
      webhook_auth_token: data.webhook_auth_token,
    });
  } catch (error: any) {
    const message = error?.message || "Erro interno";
    return jsonResponse({ error: message }, message === "Nao autorizado" ? 401 : 500);
  }
});
