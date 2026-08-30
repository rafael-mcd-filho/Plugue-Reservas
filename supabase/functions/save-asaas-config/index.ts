import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import { ensureAsaasAccountSite, validateAsaasPaymentLinksAccess } from "../_shared/asaas.ts";
import { corsHeaders, jsonResponse, readJson } from "../_shared/reservation-payments.ts";

function buildWebhookUrl(companyId: string) {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  return supabaseUrl
    ? `${supabaseUrl}/functions/v1/asaas-webhook?company_id=${encodeURIComponent(companyId)}`
    : null;
}

function getAppOriginUrl() {
  const candidate = Deno.env.get("APP_URL") || Deno.env.get("SITE_URL") || "";
  return candidate.trim();
}

async function tryRegisterAsaasSite(
  supabaseAdmin: any,
  companyId: string,
  apiToken: string,
) {
  const appUrl = getAppOriginUrl();
  if (!appUrl) return;

  try {
    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .maybeSingle();
    const companyName = (company?.name as string | undefined) || "Plug Guest";
    await ensureAsaasAccountSite(apiToken, appUrl, companyName);
  } catch (error) {
    console.warn("tryRegisterAsaasSite failed", error);
  }
}

function publicConfigResponse(companyId: string, data: any) {
  return {
    status: data?.status ?? "not_configured",
    last_validated_at: data?.last_validated_at ?? null,
    last_error: data?.last_error ?? null,
    webhook_url: data ? buildWebhookUrl(companyId) : null,
    webhook_auth_token: data?.webhook_auth_token ?? null,
    has_api_token: Boolean(data),
  };
}

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
    const action = typeof body.action === "string" ? body.action : "save";
    const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : "";

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, ["admin"]);

    if (action === "get") {
      const { data, error } = await supabaseAdmin
        .from("company_asaas_configs")
        .select("company_id, status, webhook_auth_token, last_validated_at, last_error")
        .eq("company_id", companyId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return jsonResponse(publicConfigResponse(companyId, data));
    }

    if (action === "test") {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("company_asaas_configs")
        .select("company_id, api_token, webhook_auth_token")
        .eq("company_id", companyId)
        .maybeSingle();

      if (existingError) throw new Error(existingError.message);
      const tokenToValidate = apiToken || existing?.api_token;
      if (!tokenToValidate) return jsonResponse({ error: "Token Asaas obrigatorio" }, 400);

      let status = "configured";
      let lastError: string | null = null;
      try {
        await validateAsaasPaymentLinksAccess(tokenToValidate);
      } catch (error: any) {
        status = "error";
        lastError = error?.message || "Nao foi possivel validar o token Asaas";
      }

      if (status === "configured") {
        await tryRegisterAsaasSite(supabaseAdmin, companyId, tokenToValidate);
      }

      const updatePayload = existing
        ? {
          status,
          last_validated_at: new Date().toISOString(),
          last_error: lastError,
          ...(apiToken ? { api_token: apiToken } : {}),
        }
        : {
          company_id: companyId,
          provider: "asaas",
          api_token: tokenToValidate,
          webhook_auth_token: crypto.randomUUID().replaceAll("-", ""),
          status,
          last_validated_at: new Date().toISOString(),
          last_error: lastError,
        };

      const query = existing
        ? supabaseAdmin
          .from("company_asaas_configs")
          .update(updatePayload)
          .eq("company_id", companyId)
        : supabaseAdmin
          .from("company_asaas_configs")
          .insert(updatePayload);

      const { data, error } = await query
        .select("company_id, status, webhook_auth_token, last_validated_at, last_error")
        .single();

      if (error) throw new Error(error.message);
      return jsonResponse(publicConfigResponse(companyId, data));
    }

    if (!apiToken) return jsonResponse({ error: "Token Asaas obrigatorio" }, 400);

    let status = "configured";
    let lastError: string | null = null;
    try {
      await validateAsaasPaymentLinksAccess(apiToken);
    } catch (error: any) {
      status = "error";
      lastError = error?.message || "Nao foi possivel validar o token Asaas";
    }

    if (status === "configured") {
      await tryRegisterAsaasSite(supabaseAdmin, companyId, apiToken);
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

    return jsonResponse(publicConfigResponse(companyId, data));
  } catch (error: any) {
    const message = error?.message || "Erro interno";
    return jsonResponse({ error: message }, message === "Nao autorizado" ? 401 : 500);
  }
});
