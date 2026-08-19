export const PLATFORM_BILLING_PIX_COMPATIBLE_TYPES = new Set([
  "PIX",
  "BOLETO",
  "UNDEFINED",
]);

export const PLATFORM_BILLING_PIX_OPEN_STATUSES = new Set([
  "PENDING",
  "OVERDUE",
]);

const MAX_QR_IMAGE_BASE64_LENGTH = 2_000_000;
const MAX_PIX_PAYLOAD_LENGTH = 12_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const EXPIRATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export class PlatformBillingPixValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformBillingPixValidationError";
  }
}

function requiredString(value: unknown, label: string, maximumLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximumLength) {
    throw new PlatformBillingPixValidationError(`${label} inválido retornado pelo Asaas`);
  }
  return normalized;
}

export function normalizePlatformBillingInvoiceId(value: unknown) {
  const invoiceId = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invoiceId)) {
    throw new PlatformBillingPixValidationError("Fatura inválida");
  }
  return invoiceId;
}

export function normalizePlatformAsaasPaymentId(value: unknown) {
  const paymentId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(paymentId)) {
    throw new PlatformBillingPixValidationError("Identificador da cobrança Asaas inválido");
  }
  return paymentId;
}

export interface PlatformBillingLivePaymentForPix {
  id?: unknown;
  customer?: unknown;
  description?: unknown;
  status?: unknown;
  billingType?: unknown;
  value?: unknown;
  dueDate?: unknown;
  deleted?: unknown;
}

export interface PlatformBillingValidatedPixPayment {
  paymentId: string;
  customerId: string;
  status: string;
  billingType: string;
  value: number;
  dueDate: string;
}

function normalizeLivePaymentValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 999_999_999.99) {
    throw new PlatformBillingPixValidationError(
      "Valor da cobrança inválido retornado pelo Asaas",
    );
  }
  return Math.round(parsed * 100) / 100;
}

function normalizeLivePaymentDueDate(value: unknown) {
  const dueDate = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new PlatformBillingPixValidationError(
      "Vencimento da cobrança inválido retornado pelo Asaas",
    );
  }
  const [year, month, day] = dueDate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new PlatformBillingPixValidationError(
      "Vencimento da cobrança inválido retornado pelo Asaas",
    );
  }
  return dueDate;
}

export function validatePlatformBillingPaymentForPix(
  payment: PlatformBillingLivePaymentForPix,
  expected: {
    paymentId: string;
    customerId: string;
    descriptionMarker: string;
  },
): PlatformBillingValidatedPixPayment {
  const paymentId = normalizePlatformAsaasPaymentId(payment?.id);
  if (paymentId !== expected.paymentId || payment.deleted === true) {
    throw new PlatformBillingPixValidationError(
      "A cobrança mudou no Asaas; sincronize o Financeiro e tente novamente",
    );
  }

  const customerId = typeof payment.customer === "string" ? payment.customer.trim() : "";
  if (!customerId || customerId !== expected.customerId) {
    throw new PlatformBillingPixValidationError(
      "A cobrança não pertence mais ao cliente Asaas vinculado a esta empresa",
    );
  }

  const description = typeof payment.description === "string" ? payment.description : "";
  const descriptionMarker = expected.descriptionMarker.trim();
  if (!descriptionMarker) {
    throw new PlatformBillingPixValidationError(
      "Marcador financeiro inválido",
    );
  }
  if (!description.toLocaleLowerCase("pt-BR").includes(
    descriptionMarker.toLocaleLowerCase("pt-BR"),
  )) {
    throw new PlatformBillingPixValidationError(
      "A cobrança não pertence mais ao Financeiro desta empresa",
    );
  }

  const status = typeof payment.status === "string" ? payment.status.trim().toUpperCase() : "";
  if (!PLATFORM_BILLING_PIX_OPEN_STATUSES.has(status)) {
    throw new PlatformBillingPixValidationError(
      "Esta cobrança não está mais aberta para pagamento",
    );
  }

  const billingType = typeof payment.billingType === "string"
    ? payment.billingType.trim().toUpperCase()
    : "";
  if (!PLATFORM_BILLING_PIX_COMPATIBLE_TYPES.has(billingType)) {
    throw new PlatformBillingPixValidationError(
      "Esta cobrança não aceita pagamento via Pix",
    );
  }

  return {
    paymentId,
    customerId,
    status,
    billingType,
    value: normalizeLivePaymentValue(payment.value),
    dueDate: normalizeLivePaymentDueDate(payment.dueDate),
  };
}

export interface PlatformBillingPixQrCode {
  encodedImage: string;
  payload: string;
  expirationDate: string;
}

export function normalizePlatformBillingPixQrCode(
  value: unknown,
): PlatformBillingPixQrCode {
  const response = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (response.success === false) {
    throw new PlatformBillingPixValidationError(
      "O Asaas não confirmou a geração do QR Code Pix",
    );
  }

  const encodedImage = requiredString(
    response.encodedImage,
    "Imagem do QR Code Pix",
    MAX_QR_IMAGE_BASE64_LENGTH,
  ).replace(/\s/g, "");
  if (
    encodedImage.length < 64
    || encodedImage.length % 4 !== 0
    || !BASE64_PATTERN.test(encodedImage)
  ) {
    throw new PlatformBillingPixValidationError(
      "Imagem do QR Code Pix inválida retornada pelo Asaas",
    );
  }

  const payload = requiredString(
    response.payload,
    "Código Pix copia e cola",
    MAX_PIX_PAYLOAD_LENGTH,
  );
  if (payload.length < 20 || !/^[\x20-\x7E]+$/.test(payload)) {
    throw new PlatformBillingPixValidationError(
      "Código Pix copia e cola inválido retornado pelo Asaas",
    );
  }

  const expirationDate = requiredString(response.expirationDate, "Validade do Pix", 64);
  if (
    !EXPIRATION_DATE_PATTERN.test(expirationDate)
    || !Number.isFinite(Date.parse(expirationDate.replace(" ", "T")))
  ) {
    throw new PlatformBillingPixValidationError(
      "Validade do Pix inválida retornada pelo Asaas",
    );
  }

  return { encodedImage, payload, expirationDate };
}
