export type AsaasBillingType = "PIX" | "CREDIT_CARD";

export type AsaasPaymentLinkChargeType = "DETACHED" | "RECURRENT" | "INSTALLMENT";

export interface AsaasPaymentLinkPayload {
  name: string;
  description?: string;
  endDate?: string;
  value: number;
  billingType: AsaasBillingType;
  chargeType: AsaasPaymentLinkChargeType;
  maxInstallmentCount?: number;
  dueDateLimitDays?: number;
  externalReference?: string;
  notificationEnabled?: boolean;
  callback?: {
    successUrl?: string;
    autoRedirect?: boolean;
  };
  isAddressRequired?: boolean;
}

export interface AsaasAccountSite {
  id?: string;
  name?: string;
  url?: string;
  mainSite?: boolean;
}

export async function listAsaasAccountSites(apiToken: string) {
  return await asaasRequest<{ data?: AsaasAccountSite[] }>(apiToken, "/myAccount/sites", {
    method: "GET",
  });
}

export async function createAsaasAccountSite(
  apiToken: string,
  payload: { name: string; url: string; mainSite?: boolean },
) {
  return await asaasRequest<AsaasAccountSite>(apiToken, "/myAccount/sites", {
    method: "POST",
    json: payload,
  });
}

function normalizeSiteUrl(value: string | undefined | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`.toLowerCase();
  } catch {
    return null;
  }
}

export async function ensureAsaasAccountSite(
  apiToken: string,
  desiredUrl: string,
  desiredName: string,
) {
  const normalizedDesired = normalizeSiteUrl(desiredUrl);
  if (!normalizedDesired) return false;

  try {
    const existing = await listAsaasAccountSites(apiToken);
    const items = Array.isArray(existing?.data) ? existing.data : [];
    const alreadyExists = items.some((site) => normalizeSiteUrl(site?.url ?? null) === normalizedDesired);
    if (alreadyExists) return true;

    await createAsaasAccountSite(apiToken, {
      name: desiredName.slice(0, 60),
      url: normalizedDesired,
      mainSite: items.length === 0,
    });
    return true;
  } catch (error) {
    console.warn("ensureAsaasAccountSite failed", error);
    return false;
  }
}

export interface AsaasPaymentLinkResponse {
  id: string;
  name?: string;
  url?: string;
  link?: string;
  paymentLinkUrl?: string;
  active?: boolean;
  deleted?: boolean;
  externalReference?: string | null;
}

export class AsaasApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "AsaasApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getAsaasBaseUrl() {
  return (Deno.env.get("ASAAS_API_BASE_URL") || "https://api.asaas.com/v3").replace(/\/+$/, "");
}

function buildUrl(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${getAsaasBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function asaasRequest<T>(
  apiToken: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("access_token", apiToken);
  headers.set("User-Agent", Deno.env.get("ASAAS_USER_AGENT") || "PlugueReservas/1.0");

  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  const response = await fetch(buildUrl(path), {
    ...init,
    headers,
    body,
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
    const message = Array.isArray((payload as any)?.errors)
      ? (payload as any).errors.map((error: any) => error.description || error.code).filter(Boolean).join("; ")
      : `Asaas request failed with status ${response.status}`;
    throw new AsaasApiError(message, response.status, payload);
  }

  return payload as T;
}

export function getAsaasPaymentLinkUrl(paymentLink: AsaasPaymentLinkResponse) {
  return paymentLink.url ?? paymentLink.paymentLinkUrl ?? paymentLink.link ?? null;
}

export async function createAsaasPaymentLink(apiToken: string, payload: AsaasPaymentLinkPayload) {
  return await asaasRequest<AsaasPaymentLinkResponse>(apiToken, "/paymentLinks", {
    method: "POST",
    json: payload,
  });
}

export async function listAsaasPaymentLinks(
  apiToken: string,
  params: {
    offset?: number;
    limit?: number;
    active?: boolean;
    includeDeleted?: boolean;
    name?: string;
    externalReference?: string;
  } = {},
) {
  const query = new URLSearchParams();
  if (typeof params.offset === "number") query.set("offset", String(params.offset));
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (typeof params.active === "boolean") query.set("active", String(params.active));
  if (typeof params.includeDeleted === "boolean") query.set("includeDeleted", String(params.includeDeleted));
  if (params.name) query.set("name", params.name);
  if (params.externalReference) query.set("externalReference", params.externalReference);

  return await asaasRequest<{ data?: AsaasPaymentLinkResponse[] }>(
    apiToken,
    `/paymentLinks${query.toString() ? `?${query.toString()}` : ""}`,
    { method: "GET" },
  );
}

export async function getAsaasPaymentLink(apiToken: string, paymentLinkId: string) {
  return await asaasRequest<AsaasPaymentLinkResponse>(
    apiToken,
    `/paymentLinks/${encodeURIComponent(paymentLinkId)}`,
    {
      method: "GET",
    },
  );
}

export async function deleteAsaasPaymentLink(apiToken: string, paymentLinkId: string) {
  return await asaasRequest<unknown>(apiToken, `/paymentLinks/${encodeURIComponent(paymentLinkId)}`, {
    method: "DELETE",
  });
}

export async function validateAsaasPaymentLinksAccess(apiToken: string) {
  return await asaasRequest<unknown>(apiToken, "/paymentLinks?limit=1", {
    method: "GET",
  });
}

export interface AsaasCustomerPayload {
  name: string;
  cpfCnpj?: string;
  email?: string;
  mobilePhone?: string;
  externalReference?: string;
  notificationDisabled?: boolean;
}

export interface AsaasCustomerResponse {
  id: string;
  name?: string;
  email?: string;
  mobilePhone?: string;
  cpfCnpj?: string;
}

export async function createAsaasCustomer(apiToken: string, payload: AsaasCustomerPayload) {
  return await asaasRequest<AsaasCustomerResponse>(apiToken, "/customers", {
    method: "POST",
    json: payload,
  });
}

export interface AsaasPaymentPayload {
  customer: string;
  billingType: AsaasBillingType;
  value: number;
  dueDate: string;
  description?: string;
  externalReference?: string;
  postalService?: boolean;
}

export interface AsaasPaymentResponse {
  id: string;
  status?: string;
  invoiceUrl?: string;
  confirmedDate?: string;
  clientPaymentDate?: string;
  paymentDate?: string;
  dateCreated?: string;
  dueDate?: string;
  value?: number;
  netValue?: number;
  billingType?: string;
  chargeback?: {
    status?: string;
    reason?: string;
  } | null;
  refunds?: Array<{
    status?: string;
    value?: number;
    description?: string;
    dateCreated?: string;
  }>;
}

export async function createAsaasPayment(apiToken: string, payload: AsaasPaymentPayload) {
  return await asaasRequest<AsaasPaymentResponse>(apiToken, "/payments", {
    method: "POST",
    json: payload,
  });
}

export async function getAsaasPayment(apiToken: string, paymentId: string) {
  return await asaasRequest<AsaasPaymentResponse>(
    apiToken,
    `/payments/${encodeURIComponent(paymentId)}`,
    { method: "GET" },
  );
}

export async function listAsaasPayments(
  apiToken: string,
  params: { externalReference?: string; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (params.externalReference) query.set("externalReference", params.externalReference);
  if (typeof params.limit === "number") query.set("limit", String(params.limit));

  return await asaasRequest<{ data?: AsaasPaymentResponse[] }>(
    apiToken,
    `/payments${query.toString() ? `?${query.toString()}` : ""}`,
    { method: "GET" },
  );
}

export interface AsaasPixQrCodeResponse {
  encodedImage: string;
  payload: string;
  expirationDate?: string;
  success?: boolean;
}

export async function getAsaasPixQrCode(apiToken: string, paymentId: string) {
  return await asaasRequest<AsaasPixQrCodeResponse>(
    apiToken,
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
    { method: "GET" },
  );
}

export async function getAsaasPaymentStatus(apiToken: string, paymentId: string) {
  const response = await asaasRequest<{ status?: string }>(
    apiToken,
    `/payments/${encodeURIComponent(paymentId)}/status`,
    { method: "GET" },
  );

  return typeof response.status === "string" ? response.status : null;
}

export async function deleteAsaasPayment(apiToken: string, paymentId: string) {
  return await asaasRequest<unknown>(apiToken, `/payments/${encodeURIComponent(paymentId)}`, {
    method: "DELETE",
  });
}

export interface AsaasRefundPaymentPayload {
  value?: number;
  description?: string;
}

export async function refundAsaasPayment(
  apiToken: string,
  paymentId: string,
  payload: AsaasRefundPaymentPayload = {},
) {
  return await asaasRequest<AsaasPaymentResponse>(
    apiToken,
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    {
      method: "POST",
      json: payload,
    },
  );
}

export function isAsaasPaidStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "PAID"
    || normalized === "RECEIVED"
    || normalized === "CONFIRMED"
    || normalized === "RECEIVED_IN_CASH";
}

export function isAsaasPaymentApprovalEvent(eventType: string | null | undefined) {
  const normalized = String(eventType || "").toUpperCase();
  return normalized === "PAYMENT_RECEIVED" || normalized === "PAYMENT_CONFIRMED";
}

export function isAsaasPaymentCancelledEvent(eventType: string | null | undefined) {
  const normalized = String(eventType || "").toUpperCase();
  return normalized === "PAYMENT_DELETED"
    || normalized === "PAYMENT_REFUNDED"
    || normalized === "PAYMENT_CHARGEBACK_REQUESTED"
    || normalized === "CHARGEBACK_REQUESTED"
    || normalized === "PAYMENT_CHARGEBACK_DISPUTE"
    || normalized === "CHARGEBACK_DISPUTE"
    || normalized === "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"
    || normalized === "AWAITING_CHARGEBACK_REVERSAL";
}

export function isAsaasRefundedStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "REFUNDED" || normalized === "PAYMENT_REFUNDED";
}

export function isAsaasPartialRefundedStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "PARTIALLY_REFUNDED" || normalized === "PAYMENT_PARTIALLY_REFUNDED";
}

export function isAsaasRefundPendingStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "REFUND_IN_PROGRESS" || normalized === "PAYMENT_REFUND_IN_PROGRESS";
}

export function isAsaasRefundDeniedStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "REFUND_DENIED" || normalized === "PAYMENT_REFUND_DENIED";
}

export function isAsaasCancelledStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "CANCELLED" || normalized === "DELETED" || normalized === "PAYMENT_DELETED";
}

export function isAsaasChargebackStatus(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  return normalized === "PAYMENT_CHARGEBACK_REQUESTED"
    || normalized === "CHARGEBACK_REQUESTED"
    || normalized === "PAYMENT_CHARGEBACK_DISPUTE"
    || normalized === "CHARGEBACK_DISPUTE"
    || normalized === "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"
    || normalized === "AWAITING_CHARGEBACK_REVERSAL";
}

export function getAsaasActiveChargebackStatus(payment: AsaasPaymentResponse | null | undefined) {
  const normalized = String(payment?.chargeback?.status || "").toUpperCase();
  if (!normalized || normalized === "REVERSED") return null;
  return normalized;
}

export function getAsaasRefundedValue(payment: AsaasPaymentResponse | null | undefined) {
  const refunds = Array.isArray(payment?.refunds) ? payment.refunds : [];
  const total = refunds.reduce((sum, refund) => {
    const value = Number(refund?.value ?? 0);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);

  return total > 0 ? total : null;
}

export type AsaasExternalPaymentOutcome =
  | "refunded"
  | "partial_refunded"
  | "refund_pending"
  | "refund_denied"
  | "chargeback"
  | "cancelled";

export function getAsaasExternalPaymentOutcome(
  eventOrStatus: string | null | undefined,
  paymentStatus?: string | null,
  payment?: AsaasPaymentResponse | null,
): AsaasExternalPaymentOutcome | null {
  if (isAsaasRefundedStatus(eventOrStatus) || isAsaasRefundedStatus(paymentStatus) || isAsaasRefundedStatus(payment?.status)) {
    return "refunded";
  }

  if (
    isAsaasPartialRefundedStatus(eventOrStatus)
    || isAsaasPartialRefundedStatus(paymentStatus)
    || isAsaasPartialRefundedStatus(payment?.status)
  ) {
    return "partial_refunded";
  }

  if (
    isAsaasRefundPendingStatus(eventOrStatus)
    || isAsaasRefundPendingStatus(paymentStatus)
    || isAsaasRefundPendingStatus(payment?.status)
  ) {
    return "refund_pending";
  }

  if (
    isAsaasRefundDeniedStatus(eventOrStatus)
    || isAsaasRefundDeniedStatus(paymentStatus)
    || isAsaasRefundDeniedStatus(payment?.status)
  ) {
    return "refund_denied";
  }

  if (
    isAsaasChargebackStatus(eventOrStatus)
    || isAsaasChargebackStatus(paymentStatus)
    || isAsaasChargebackStatus(payment?.status)
    || getAsaasActiveChargebackStatus(payment)
  ) {
    return "chargeback";
  }

  if (isAsaasCancelledStatus(eventOrStatus) || isAsaasCancelledStatus(paymentStatus) || isAsaasCancelledStatus(payment?.status)) {
    return "cancelled";
  }

  return null;
}
