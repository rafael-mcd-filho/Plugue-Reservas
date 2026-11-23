import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import { getGlobalReservationAsaasConfig } from "../_shared/reservation-asaas-config.ts";
import { corsHeaders, jsonResponse, readJson } from "../_shared/reservation-payments.ts";

// Company staff can inspect readiness; only the superadmin endpoint can manage
// the central receiving account. Never return central credentials to a tenant.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await readJson(req);
    const companyId = typeof body.company_id === "string" ? body.company_id : null;
    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, ["admin"]);
    const action = typeof body.action === "string" ? body.action : "get";
    if (!["get", "test"].includes(action) || body.api_token) {
      return jsonResponse({ error: "A conta Asaas e gerenciada nas integracoes globais pelo superadmin." }, 403);
    }

    const config = await getGlobalReservationAsaasConfig(supabaseAdmin, { decryptToken: false });
    return jsonResponse({
      status: config?.status ?? "not_configured",
      last_validated_at: config?.last_validated_at ?? null,
      last_error: config?.status === "error"
        ? "A integracao central precisa de atencao do suporte."
        : null,
      webhook_url: null,
      webhook_auth_token: null,
      has_api_token: Boolean(config?.api_token_encrypted),
      managed_by_platform: true,
      from_company_account: false,
      environment: config?.api_environment ?? null,
    });
  } catch (error: any) {
    const message = error?.message || "Erro interno";
    const status = message === "Nao autorizado" ? 401 : message === "Sem permissao" ? 403 : 500;
    return jsonResponse({ error: status < 500 ? message : "Nao foi possivel consultar a integracao central." }, status);
  }
});
