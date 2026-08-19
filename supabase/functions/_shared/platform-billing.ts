import { resolvePlatformAsaasBaseUrl } from "./platform-billing-base-url.ts";

export type PlatformBillingEnvironment = "sandbox" | "production";

export const platformBillingCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export function platformBillingJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...platformBillingCorsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function readPlatformBillingJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

const TOKEN_CIPHER_PREFIX = "v1";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function getPlatformBillingEncryptionKey(): Promise<CryptoKey> {
  const rawKey = Deno.env.get("PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY");
  if (!rawKey) {
    throw new Error("PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY não configurada");
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawKey);
  } catch {
    keyBytes = new TextEncoder().encode(rawKey);
  }

  if (keyBytes.length !== 32) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawKey),
    );
    keyBytes = new Uint8Array(digest);
  }

  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPlatformAsaasToken(token: string): Promise<string> {
  const normalized = token.trim();
  if (!normalized) throw new Error("Token do Asaas obrigatório");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getPlatformBillingEncryptionKey();
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(normalized),
    ),
  );

  return `${TOKEN_CIPHER_PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(cipherText)}`;
}

export async function decryptPlatformAsaasToken(storedToken: string): Promise<string> {
  if (!storedToken.startsWith(`${TOKEN_CIPHER_PREFIX}:`)) {
    throw new Error("O token global do Asaas não está criptografado no formato esperado");
  }

  const [, ivValue, cipherTextValue] = storedToken.split(":");
  if (!ivValue || !cipherTextValue) {
    throw new Error("Token global do Asaas criptografado inválido");
  }

  const key = await getPlatformBillingEncryptionKey();
  const plainText = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(cipherTextValue),
  );

  return new TextDecoder().decode(plainText);
}

export class PlatformAsaasApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "PlatformAsaasApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getPlatformAsaasBaseUrl(environment: PlatformBillingEnvironment) {
  // This intentionally does not read ASAAS_API_BASE_URL, which belongs to the
  // reservation prepayment integration.
  return resolvePlatformAsaasBaseUrl({
    environment,
    override: Deno.env.get("PLATFORM_ASAAS_API_BASE_URL"),
    allowSandboxOverride:
      Deno.env.get("PLATFORM_ASAAS_ALLOW_BASE_URL_OVERRIDE") === "true",
    allowedProxyOrigins:
      Deno.env.get("PLATFORM_ASAAS_ALLOWED_BASE_URL_ORIGINS"),
  });
}

function getProviderErrorMessage(payload: unknown, status: number) {
  const errors = (payload as { errors?: Array<{ description?: unknown; code?: unknown }> } | null)?.errors;
  if (Array.isArray(errors)) {
    const message = errors
      .map((error) => {
        if (typeof error?.description === "string") return error.description;
        if (typeof error?.code === "string") return error.code;
        return null;
      })
      .filter(Boolean)
      .join("; ");
    if (message) return message.slice(0, 1000);
  }

  return `Asaas respondeu HTTP ${status}`;
}

async function platformAsaasGet<T>(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): Promise<T> {
  const baseUrl = getPlatformAsaasBaseUrl(environment);
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "access_token": apiToken,
      "User-Agent": Deno.env.get("PLATFORM_ASAAS_USER_AGENT") || "PlugueGuestPlatformBilling/1.0",
    },
    signal: AbortSignal.timeout(15000),
  });

  const responseText = await response.text();
  let payload: unknown = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = responseText;
    }
  }

  if (!response.ok) {
    throw new PlatformAsaasApiError(
      getProviderErrorMessage(payload, response.status),
      response.status,
      payload,
    );
  }

  return payload as T;
}

export interface PlatformAsaasCustomer {
  id: string;
  name?: string | null;
  cpfCnpj?: string | null;
  email?: string | null;
  mobilePhone?: string | null;
  phone?: string | null;
  externalReference?: string | null;
  deleted?: boolean;
}

export interface PlatformAsaasCustomerPage {
  customers: PlatformAsaasCustomer[];
  offset: number;
  limit: number;
  hasMore: boolean;
  totalCount: number | null;
}

export interface PlatformAsaasPayment {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  description?: string | null;
  status?: string | null;
  value?: number | string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  billingType?: string | null;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  externalReference?: string | null;
  dateCreated?: string | null;
  deleted?: boolean;
}

export async function getPlatformAsaasPayment(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  paymentId: string,
) {
  return platformAsaasGet<PlatformAsaasPayment>(
    apiToken,
    environment,
    `/payments/${encodeURIComponent(paymentId)}`,
  );
}

export async function getPlatformAsaasPaymentPixQrCode(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  paymentId: string,
) {
  return platformAsaasGet<unknown>(
    apiToken,
    environment,
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
  );
}

interface PlatformAsaasListResponse<T> {
  object?: string;
  hasMore?: boolean;
  totalCount?: number;
  limit?: number;
  offset?: number;
  data?: T[];
}

export async function validatePlatformAsaasToken(
  apiToken: string,
  environment: PlatformBillingEnvironment,
) {
  const response = await platformAsaasGet<PlatformAsaasListResponse<PlatformAsaasCustomer>>(
    apiToken,
    environment,
    "/customers",
    { limit: 1, offset: 0 },
  );
  if (!Array.isArray(response?.data)) {
    throw new Error("Resposta inválida do Asaas ao validar o token");
  }
}

export function normalizeAsaasCustomerId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(normalized)) {
    throw new Error("Customer ID do Asaas inválido");
  }
  return normalized;
}

export async function getPlatformAsaasCustomer(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  customerId: string,
) {
  const normalizedId = normalizeAsaasCustomerId(customerId);
  const customer = await platformAsaasGet<PlatformAsaasCustomer>(
    apiToken,
    environment,
    `/customers/${encodeURIComponent(normalizedId)}`,
  );

  if (!customer?.id || customer.deleted === true) {
    throw new Error("Cliente Asaas não encontrado ou removido");
  }

  return customer;
}

export async function listPlatformAsaasCustomers(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  options: {
    offset: number;
    limit: number;
    name?: string;
    email?: string;
    cpfCnpj?: string;
    externalReference?: string;
  },
): Promise<PlatformAsaasCustomerPage> {
  const response = await platformAsaasGet<PlatformAsaasListResponse<PlatformAsaasCustomer>>(
    apiToken,
    environment,
    "/customers",
    {
      offset: options.offset,
      limit: options.limit,
      name: options.name,
      email: options.email,
      cpfCnpj: options.cpfCnpj,
      externalReference: options.externalReference,
    },
  );

  if (
    !Array.isArray(response?.data)
    || typeof response.hasMore !== "boolean"
    || response.data.some((customer) =>
      !customer
      || typeof customer !== "object"
      || typeof customer.id !== "string"
      || !customer.id.trim()
    )
  ) {
    throw new Error("Resposta inválida do Asaas ao listar clientes");
  }

  const providerTotal = Number(response.totalCount);
  return {
    customers: response.data.filter((customer) => customer.deleted !== true),
    offset: options.offset,
    limit: options.limit,
    hasMore: response.hasMore,
    totalCount: Number.isSafeInteger(providerTotal) && providerTotal >= 0
      ? providerTotal
      : null,
  };
}

export async function listAllPlatformAsaasCustomerPayments(
  apiToken: string,
  environment: PlatformBillingEnvironment,
  customerId: string,
) {
  const normalizedId = normalizeAsaasCustomerId(customerId);
  const limit = 100;
  const maximumPages = 100;
  const payments: PlatformAsaasPayment[] = [];
  let offset = 0;

  for (let page = 0; page < maximumPages; page += 1) {
    const response = await platformAsaasGet<PlatformAsaasListResponse<PlatformAsaasPayment>>(
      apiToken,
      environment,
      "/payments",
      { customer: normalizedId, limit, offset },
    );
    if (!Array.isArray(response?.data)) {
      throw new Error("Resposta inválida do Asaas ao listar cobranças");
    }
    const pageItems = response.data;
    if (
      typeof response.hasMore !== "boolean"
      || pageItems.some((payment) =>
        !payment
        || typeof payment !== "object"
        || typeof payment.id !== "string"
        || !payment.id.trim()
      )
    ) {
      throw new Error("Paginação ou cobrança inválida retornada pelo Asaas");
    }
    payments.push(...pageItems);

    const hasMore = response.hasMore;
    if (!hasMore) return payments;

    if (pageItems.length === 0) {
      throw new Error("A paginação do Asaas retornou hasMore sem novos registros");
    }
    offset += pageItems.length;
  }

  throw new Error("O cliente possui mais de 10.000 cobranças; sincronização interrompida por segurança");
}

export function paymentDescriptionContainsMarker(
  description: unknown,
  marker: string,
) {
  if (typeof description !== "string") return false;
  const normalizedMarker = marker.trim().toLocaleLowerCase("pt-BR");
  if (!normalizedMarker) return false;
  return description.toLocaleLowerCase("pt-BR").includes(normalizedMarker);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableHttpsUrl(value: unknown): string | null {
  const candidate = nullableString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function nullableDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function moneyValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100) / 100;
}

export function toCompanyBillingInvoiceRow(
  payment: PlatformAsaasPayment,
  companyId: string,
  customerId: string,
  syncedAt: string,
) {
  if (typeof payment?.id !== "string" || !payment.id.trim()) {
    throw new Error("Cobrança do Asaas sem identificador");
  }

  return {
    company_id: companyId,
    asaas_payment_id: payment.id.trim(),
    asaas_customer_id: customerId,
    asaas_subscription_id: nullableString(payment.subscription),
    description: nullableString(payment.description),
    status: nullableString(payment.status)?.toUpperCase() ?? "UNKNOWN",
    value: moneyValue(payment.value),
    due_date: nullableDate(payment.dueDate),
    payment_date: nullableDate(
      payment.paymentDate ?? payment.clientPaymentDate ?? payment.confirmedDate,
    ),
    billing_type: nullableString(payment.billingType)?.toUpperCase() ?? null,
    invoice_url: nullableHttpsUrl(payment.invoiceUrl),
    bank_slip_url: nullableHttpsUrl(payment.bankSlipUrl),
    external_reference: nullableString(payment.externalReference),
    asaas_created_at: nullableDate(payment.dateCreated),
    last_synced_at: syncedAt,
    updated_at: syncedAt,
  };
}

export interface StoredPlatformBillingConfig {
  apiToken: string;
  environment: PlatformBillingEnvironment;
  moduleEnabled: boolean;
  sourceRevision: string;
}

export async function loadStoredPlatformBillingConfig(
  supabaseAdmin: any,
): Promise<StoredPlatformBillingConfig> {
  const { data, error } = await supabaseAdmin
    .from("platform_billing_config")
    .select("api_token_encrypted, api_environment, module_enabled, source_revision, token_validated_at, token_last_error")
    .eq("id", true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.api_token_encrypted) {
    throw new Error("Token global do Asaas não configurado");
  }
  if (typeof data.source_revision !== "string" || !data.source_revision) {
    throw new Error("Revisão da fonte Asaas não configurada");
  }

  const environment = data.api_environment === "sandbox" ? "sandbox" : "production";
  return {
    apiToken: await decryptPlatformAsaasToken(data.api_token_encrypted),
    environment,
    moduleEnabled: data.module_enabled === true
      && Boolean(data.token_validated_at)
      && !data.token_last_error,
    sourceRevision: data.source_revision,
  };
}

export function normalizePlatformBillingEnvironment(
  value: unknown,
  fallback: PlatformBillingEnvironment = "production",
): PlatformBillingEnvironment {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "sandbox" || value === "production") return value;
  throw new Error("Ambiente Asaas inválido");
}

export function publicPlatformBillingConfig(data: Record<string, unknown> | null) {
  return {
    module_enabled: data?.module_enabled === true,
    configured: Boolean(
      data?.api_token_encrypted
      && data?.token_validated_at
      && !data?.token_last_error
    ),
    environment: data?.api_environment === "sandbox" ? "sandbox" : "production",
    token_last_four: nullableString(data?.token_last_four),
    token_validated_at: nullableString(data?.token_validated_at),
    token_last_error: nullableString(data?.token_last_error),
    updated_at: nullableString(data?.updated_at),
  };
}

export function safePlatformBillingError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "Erro interno";
  const sanitizedMessage = message.replace(/\$aact_[A-Za-z0-9_-]+/g, "[TOKEN_REMOVIDO]");
  const localizedMessage = ({
    "SUPABASE_ANON_KEY nao configurada": "SUPABASE_ANON_KEY não configurada",
    "Nao autorizado": "Não autorizado",
    "Sem permissao para esta empresa": "Sem permissão para esta empresa",
    "Sem permissao": "Sem permissão",
  } as Record<string, string>)[sanitizedMessage] ?? sanitizedMessage;
  return localizedMessage.slice(0, 1000);
}
