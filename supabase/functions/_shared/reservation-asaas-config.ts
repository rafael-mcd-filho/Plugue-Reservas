import { asaasRequest, type AsaasCredentials } from "./asaas.ts";
import { decryptPlatformAsaasToken } from "./platform-billing.ts";

export const CENTRAL_RESERVATION_ASAAS_TABLE = "platform_reservation_asaas_config";
// Cash receipts also emit PAYMENT_RECEIVED; RECEIVED_IN_CASH is a billingType.
export const RESERVATION_ASAAS_WEBHOOK_EVENTS = [
  "PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE", "PAYMENT_DELETED", "PAYMENT_RESTORED",
  "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_REFUND_DENIED", "PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
] as const;

export interface GlobalReservationAsaasConfig {
  id: boolean;
  api_token_encrypted: string | null;
  api_environment: "sandbox" | "production";
  provider_account_id: string | null;
  project_url?: string | null;
  token_last_four: string | null;
  webhook_auth_token: string;
  webhook_id: string | null;
  webhook_email: string | null;
  status: "not_configured" | "configured" | "error";
  last_validated_at: string | null;
  last_error: string | null;
  revision: string;
  credentials: Exclude<AsaasCredentials, string> | null;
}

export async function getGlobalReservationAsaasConfig(
  supabaseAdmin: any,
  options: { decryptToken?: boolean } = {},
): Promise<GlobalReservationAsaasConfig | null> {
  const { data, error } = await supabaseAdmin.from(CENTRAL_RESERVATION_ASAAS_TABLE)
    .select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (!["sandbox", "production"].includes(data.api_environment)) {
    throw new Error("Ambiente da conta central Asaas inválido");
  }
  return {
    ...data,
    credentials: data.api_token_encrypted && options.decryptToken !== false
      ? { apiToken: await decryptPlatformAsaasToken(data.api_token_encrypted), environment: data.api_environment }
      : null,
  };
}

// Legacy payments retain their original company account. They must never be
// redirected to the platform account just because a new default was enabled.
export async function getReservationAsaasCredentials(supabaseAdmin: any, payment: {
  company_id: string;
  metadata?: Record<string, unknown> | null;
}): Promise<AsaasCredentials> {
  if (payment.metadata?.asaas_account_scope === "platform") {
    const config = await getGlobalReservationAsaasConfig(supabaseAdmin);
    if (!config?.credentials || !config.provider_account_id) {
      throw new Error("Conta central Asaas não configurada");
    }
    if (payment.metadata.asaas_account_id !== config.provider_account_id
      || payment.metadata.asaas_environment !== config.api_environment) {
      throw new Error("A cobrança pertence a outra conta ou ambiente Asaas");
    }
    return config.credentials;
  }
  const { data, error } = await supabaseAdmin.from("company_asaas_configs")
    .select("api_token, status").eq("company_id", payment.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.api_token) throw new Error("Conta Asaas original da cobrança não configurada");
  return data.api_token;
}

export function centralReservationWebhookUrl() {
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  if (!base) throw new Error("SUPABASE_URL não configurada");
  // A distinct destination prevents provisioning from replacing the secret of
  // an existing global/company legacy webhook on the unscoped endpoint.
  return `${base}/functions/v1/asaas-webhook?scope=platform`;
}

export function publicGlobalReservationAsaasConfig(config: GlobalReservationAsaasConfig | null) {
  return {
    status: config?.status ?? "not_configured",
    environment: config?.api_environment ?? "production",
    account_id: config?.provider_account_id ?? null,
    has_api_token: Boolean(config?.api_token_encrypted),
    token_last_four: config?.token_last_four ?? null,
    last_validated_at: config?.last_validated_at ?? null,
    last_error: config?.last_error ?? null,
    webhook_id: config?.webhook_id ?? null,
    webhook_url: centralReservationWebhookUrl(),
    webhook_email: config?.webhook_email ?? null,
  };
}

export async function getReservationAsaasAccountId(credentials: AsaasCredentials) {
  const response = await asaasRequest<{ data?: Array<{ id?: string }>; id?: string }>(credentials, "/wallets/", { method: "GET" });
  const ids = response?.data ? response.data.map((wallet) => wallet.id).filter(Boolean) : [response?.id].filter(Boolean);
  if (ids.length !== 1 || typeof ids[0] !== "string") {
    throw new Error("Não foi possível identificar a conta Asaas pelo WalletId");
  }
  return ids[0];
}

interface AsaasWebhook {
  id: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  interrupted?: boolean;
  sendType?: string;
  events?: string[];
}

export async function provisionCentralReservationWebhook(credentials: AsaasCredentials, config: {
  webhook_auth_token: string;
  webhook_email: string;
  webhook_id?: string | null;
}) {
  const url = centralReservationWebhookUrl();
  const response = await asaasRequest<{ data?: AsaasWebhook[] }>(credentials, "/webhooks?limit=100", { method: "GET" });
  const existing = (response.data ?? []).find((hook) => hook.id === config.webhook_id && hook.url === url)
    ?? (response.data ?? []).find((hook) => hook.url === url);
  const payload = {
    name: "Plug Guest - reservas de todas as empresas",
    url,
    email: config.webhook_email,
    enabled: true,
    interrupted: false,
    apiVersion: 3,
    authToken: config.webhook_auth_token,
    sendType: "SEQUENTIALLY",
    events: [...RESERVATION_ASAAS_WEBHOOK_EVENTS],
  };
  const webhook = await asaasRequest<AsaasWebhook>(credentials,
    existing ? `/webhooks/${encodeURIComponent(existing.id)}` : "/webhooks",
    { method: existing ? "PUT" : "POST", json: payload });
  if (!webhook?.id) throw new Error("Asaas não retornou o identificador do webhook");
  return webhook;
}

export async function inspectCentralReservationWebhook(credentials: AsaasCredentials, config: {
  webhook_id: string | null;
}) {
  if (!config.webhook_id) throw new Error("Webhook central ainda não configurado");
  const webhook = await asaasRequest<AsaasWebhook>(credentials,
    `/webhooks/${encodeURIComponent(config.webhook_id)}`, { method: "GET" });
  if (webhook.url !== centralReservationWebhookUrl() || !webhook.enabled || webhook.interrupted
    || webhook.sendType !== "SEQUENTIALLY"
    || RESERVATION_ASAAS_WEBHOOK_EVENTS.some((event) => !webhook.events?.includes(event))) {
    throw new Error("O webhook central está incompleto, desativado ou com fila interrompida. Salve novamente para reparar a configuração.");
  }
  return webhook;
}
