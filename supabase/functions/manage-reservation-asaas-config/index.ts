import { assertSuperadmin } from "../_shared/internal-auth.ts";
import { ensureAsaasAccountSite, validateAsaasPaymentLinksAccess } from "../_shared/asaas.ts";
import { encryptPlatformAsaasToken, safePlatformBillingError } from "../_shared/platform-billing.ts";
import {
  CENTRAL_RESERVATION_ASAAS_TABLE,
  getGlobalReservationAsaasConfig,
  getReservationAsaasAccountId,
  inspectCentralReservationWebhook,
  provisionCentralReservationWebhook,
  publicGlobalReservationAsaasConfig,
} from "../_shared/reservation-asaas-config.ts";
import { corsHeaders, jsonResponse, readJson } from "../_shared/reservation-payments.ts";

function safeCentralError(error: unknown, secrets: string[]) {
  let message = safePlatformBillingError(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[CREDENCIAL_REMOVIDA]");
  }
  return message;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido" }, 405);
  let submittedToken = "";
  let webhookSecret = "";
  let storedValidation: { supabaseAdmin: any; revision: string } | null = null;
  let provisioningLease: { supabaseAdmin: any; id: string } | null = null;
  try {
    const { supabaseAdmin, user } = await assertSuperadmin(req);
    const body = await readJson(req);
    const action = typeof body.action === "string" ? body.action : "get";
    if (!["get", "save", "test"].includes(action)) return jsonResponse({ error: "Ação inválida" }, 400);
    const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : "";
    submittedToken = apiToken;
    const existing = await getGlobalReservationAsaasConfig(supabaseAdmin, { decryptToken: action !== "get" && !apiToken });
    webhookSecret = existing?.webhook_auth_token ?? "";
    if (action === "get") return jsonResponse(publicGlobalReservationAsaasConfig(existing));
    if (!existing) return jsonResponse({ error: "A configuração central de reservas não foi instalada" }, 409);

    const environment = body.environment ?? existing.api_environment;
    if (!["sandbox", "production"].includes(environment)) return jsonResponse({ error: "Ambiente Asaas inválido" }, 400);
    if (!apiToken && environment !== existing.api_environment) {
      return jsonResponse({ error: "Informe o token correspondente ao novo ambiente" }, 400);
    }
    const credentials = apiToken ? { apiToken, environment } : existing.credentials;
    if (!credentials) return jsonResponse({ error: "Informe o token da conta central Asaas" }, 400);
    submittedToken = credentials.apiToken;
    const email = typeof body.webhook_email === "string" ? body.webhook_email.trim() : existing.webhook_email ?? "";
    if (action === "save" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
      return jsonResponse({ error: "Informe um e-mail válido para os avisos do webhook" }, 400);
    }

    // Validate without replacing a working credential when the candidate fails.
    if (!apiToken) storedValidation = { supabaseAdmin, revision: existing.revision };
    await validateAsaasPaymentLinksAccess(credentials);
    const accountId = await getReservationAsaasAccountId(credentials);
    const accountChanged = existing.provider_account_id && (
      existing.provider_account_id !== accountId || existing.api_environment !== environment
    );
    if (accountChanged) {
      const { data: charges, error } = await supabaseAdmin.from("reservation_payments")
        .select("id").contains("metadata", { asaas_account_scope: "platform" }).limit(1);
      if (error) throw new Error(error.message);
      if (charges?.length) {
        return jsonResponse({ error: "A conta e o ambiente Asaas não podem mudar enquanto houver cobranças centrais no histórico. É permitido atualizar o token da mesma conta." }, 409);
      }
    }

    if (action === "test") {
      if (apiToken || accountChanged) {
        return jsonResponse({
          ...publicGlobalReservationAsaasConfig(existing),
          candidate_token_valid: true,
          message: "Token validado. Salve para instalar e validar o webhook desta conta.",
        });
      }
      try {
        await inspectCentralReservationWebhook(credentials, existing);
      } catch (error) {
        const message = safeCentralError(error, [submittedToken, webhookSecret]);
        const { error: updateError } = await supabaseAdmin.from(CENTRAL_RESERVATION_ASAAS_TABLE)
          .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
          .eq("id", true).eq("revision", existing.revision);
        if (updateError) throw new Error(updateError.message);
        return jsonResponse({ ...publicGlobalReservationAsaasConfig(await getGlobalReservationAsaasConfig(supabaseAdmin, { decryptToken: false })), message });
      }
      const now = new Date().toISOString();
      const { data: updated, error } = await supabaseAdmin.from(CENTRAL_RESERVATION_ASAAS_TABLE)
        .update({ status: "configured", last_validated_at: now, last_error: null, updated_at: now, updated_by: user.id })
        .eq("id", true).eq("revision", existing.revision).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!updated) return jsonResponse({ error: "A configuração mudou. Recarregue e tente novamente." }, 409);
      return jsonResponse(publicGlobalReservationAsaasConfig(await getGlobalReservationAsaasConfig(supabaseAdmin, { decryptToken: false })));
    }

    // Encrypt before changing any provider configuration, so a missing key does
    // not leave a newly provisioned webhook without a usable local credential.
    const encryptedToken = apiToken ? await encryptPlatformAsaasToken(apiToken) : existing.api_token_encrypted;
    const leaseId = crypto.randomUUID();
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc("claim_central_reservation_asaas_config", {
      _expected_revision: existing.revision, _lease_id: leaseId,
    });
    if (claimError) throw new Error(claimError.message);
    if (!claimed) return jsonResponse({ error: "Outra atualização está em andamento ou a configuração mudou. Recarregue e tente novamente." }, 409);
    provisioningLease = { supabaseAdmin, id: leaseId };
    const webhook = await provisionCentralReservationWebhook(credentials, {
      webhook_auth_token: existing.webhook_auth_token,
      webhook_email: email,
      webhook_id: accountChanged ? null : existing.webhook_id,
    });
    const appUrl = Deno.env.get("APP_URL") || Deno.env.get("SITE_URL");
    if (appUrl) await ensureAsaasAccountSite(credentials, appUrl, "Plug Guest - reservas");
    const now = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin.from(CENTRAL_RESERVATION_ASAAS_TABLE).update({
      api_token_encrypted: encryptedToken,
      api_environment: environment,
      provider_account_id: accountId,
      project_url: Deno.env.get("SUPABASE_URL")!.replace(/\/+$/, ""),
      token_last_four: apiToken ? apiToken.slice(-4) : existing.token_last_four,
      webhook_id: webhook.id,
      webhook_email: email,
      status: "configured",
      last_validated_at: now,
      last_error: null,
      updated_at: now,
      updated_by: user.id,
      revision: crypto.randomUUID(),
      provisioning_lease_id: null,
      provisioning_lease_until: null,
    }).eq("id", true).eq("revision", existing.revision).eq("provisioning_lease_id", leaseId).select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) return jsonResponse({ error: "A configuração mudou. Recarregue e tente novamente." }, 409);
    const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
      user_id: user.id,
      action: "save_central_reservation_asaas_config",
      entity_type: CENTRAL_RESERVATION_ASAAS_TABLE,
      entity_id: null,
      details: { environment, account_id: accountId, webhook_id: webhook.id, token_replaced: Boolean(apiToken) },
    });
    if (auditError) console.warn("Failed to audit central reservation Asaas config");
    return jsonResponse(publicGlobalReservationAsaasConfig(await getGlobalReservationAsaasConfig(supabaseAdmin, { decryptToken: false })));
  } catch (error) {
    const message = safeCentralError(error, [submittedToken, webhookSecret]);
    // Keep a failed candidate from damaging a working integration, while a
    // failed check of the saved credential must stop new charge creation.
    if (storedValidation) {
      const { error: statusError } = await storedValidation.supabaseAdmin.from(CENTRAL_RESERVATION_ASAAS_TABLE)
        .update({ status: "error", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", true).eq("revision", storedValidation.revision);
      if (statusError) console.warn("Failed to persist central reservation Asaas validation status");
    }
    const code = /não autorizado|nao autorizado/i.test(message) ? 401 : /sem permiss/i.test(message) ? 403 : /não podem mudar|configuração mudou/i.test(message) ? 409 : 500;
    return jsonResponse({ error: message }, code);
  } finally {
    if (provisioningLease) {
      try {
        const { error } = await provisioningLease.supabaseAdmin.rpc("release_central_reservation_asaas_config", { _lease_id: provisioningLease.id });
        if (error) console.warn("Failed to release central reservation Asaas configuration lease");
      } catch {
        console.warn("Failed to release central reservation Asaas configuration lease");
      }
    }
  }
});
