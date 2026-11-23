import { getRequestAuthContext } from "./internal-auth.ts";

export const PAYOUT_RECEIPTS_BUCKET = "reservation-payout-receipts";
export const MAX_PAYOUT_RECEIPT_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SettlementApiError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID.test(value)) throw new SettlementApiError(`${label} inválido.`);
  return value;
}

// Parse the decimal representation before doing any arithmetic. Never round an
// imprecise amount, accept exponent syntax, or turn a missing amount into full balance.
export function parseWithdrawalCents(value: unknown) {
  const decimal = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(decimal)) throw new SettlementApiError("Informe um valor positivo com até duas casas decimais.");
  const [integer, fraction = ""] = decimal.split(".");
  const cents = Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new SettlementApiError("Valor de saque inválido.");
  return cents;
}

export function requireInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SettlementApiError(`${label} inválido.`);
  }
  return value;
}

export function optionalText(value: unknown, maxLength: number, label: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength || Array.from(value).some(character => character.charCodeAt(0) < 32)) throw new SettlementApiError(`${label} inválido.`);
  return value.trim() || null;
}

export function requireIsoDate(value: unknown, label: string) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!match) throw new SettlementApiError(`${label} inválida.`);
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, zone] = match;
  const [year, month, day, hour, minute, second] = [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond ?? "0"].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 14 || zoneMinute > 59
    || (zoneHour === 14 && zoneMinute !== 0) || !Number.isFinite(Date.parse(value as string))) {
    throw new SettlementApiError(`${label} inválida.`);
  }
  return new Date(value as string).toISOString();
}

export function validatePayoutDestination(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettlementApiError("Informe os dados do favorecido.");
  const source = input as Record<string, unknown>;
  const holderName = optionalText(source.holder_name, 120, "Nome do favorecido");
  const document = typeof source.holder_document === "string" ? source.holder_document.replace(/[.\-/\s]/g, "") : "";
  if (!holderName || holderName.length < 3 || !/^(?:\d{11}|\d{14})$/.test(document)) throw new SettlementApiError("Informe nome e CPF/CNPJ válidos do favorecido.");
  const common = { kind: source.kind, holder_name: holderName, holder_document: document };
  if (source.kind === "pix") {
    const keyType = source.pix_key_type;
    let key = optionalText(source.pix_key, 254, "Chave Pix");
    if (!key || !["cpf", "cnpj", "email", "phone", "random"].includes(String(keyType))) throw new SettlementApiError("Informe o tipo e a chave Pix.");
    if (keyType === "cpf" || keyType === "cnpj") {
      key = key.replace(/[.\-/\s]/g, "");
      if (!(keyType === "cpf" ? /^\d{11}$/ : /^\d{14}$/).test(key)) throw new SettlementApiError("Chave Pix de CPF/CNPJ inválida.");
    }
    if (keyType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) throw new SettlementApiError("Chave Pix de e-mail inválida.");
    if (keyType === "phone") {
      key = key.replace(/[\s()-]/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(key)) throw new SettlementApiError("Informe a chave Pix de telefone com código do país, como +5511999999999.");
    }
    if (keyType === "random" && !UUID.test(key)) throw new SettlementApiError("Chave Pix aleatória inválida.");
    return { ...common, kind: "pix", pix_key_type: keyType, pix_key: key };
  }
  if (source.kind === "bank") {
    const bankCode = optionalText(source.bank_code, 8, "Banco");
    const agency = optionalText(source.agency, 10, "Agência");
    const account = optionalText(source.account_number, 24, "Conta");
    if (!bankCode || !/^(?:\d{3}|\d{8})$/.test(bankCode) || !agency || !/^[\d-]{1,10}$/.test(agency)
      || !account || !/^[\dXx-]{1,24}$/.test(account) || !["checking", "savings"].includes(String(source.account_type))) {
      throw new SettlementApiError("Informe banco, agência, conta e tipo de conta válidos.");
    }
    return { ...common, kind: "bank", bank_code: bankCode, bank_name: optionalText(source.bank_name, 120, "Nome do banco"),
      agency, account_number: account, account_type: source.account_type };
  }
  throw new SettlementApiError("Tipo de destino inválido.");
}

export async function assertSettlementAccess(req: Request, companyId?: string, superadminOnly = false) {
  const context = await getRequestAuthContext(req);
  if (!context) throw new SettlementApiError("Não autorizado.", 401);
  // Payout authority always belongs to the real actor. Never inherit it from
  // a company user while operating a support/impersonation session.
  if (context.isSupport || context.impersonation || req.headers.has("x-support-impersonation")) {
    throw new SettlementApiError("Movimentações e dados de repasse não estão disponíveis durante impersonação.", 403);
  }
  const roles = context.actorRoleRows;
  const isSuperadmin = roles.some(row => row.role === "superadmin");
  const companyAdmin = companyId && roles.some(row => row.role === "admin" && row.company_id === companyId);
  if ((superadminOnly && !isSuperadmin) || (!superadminOnly && !isSuperadmin && !companyAdmin)) {
    throw new SettlementApiError("Sem permissão para os repasses desta empresa.", 403);
  }
  return { ...context, isSuperadmin };
}

export function decodePayoutReceipt(base64: unknown, mime: unknown) {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > Math.ceil(MAX_PAYOUT_RECEIPT_BYTES / 3) * 4
    || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new SettlementApiError("Comprovante inválido ou maior que 5 MB.");
  }
  let decoded: string;
  try { decoded = atob(base64); } catch { throw new SettlementApiError("Comprovante inválido."); }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  validatePayoutReceiptBytes(bytes, mime);
  return bytes;
}

export function validatePayoutReceiptBytes(bytes: Uint8Array, mime: unknown) {
  if (!bytes.length || bytes.length > MAX_PAYOUT_RECEIPT_BYTES) throw new SettlementApiError("Comprovante inválido ou maior que 5 MB.");
  const isPdf = bytes.length > 8 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  const isPng = bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const isJpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!((mime === "application/pdf" && isPdf) || (mime === "image/png" && isPng) || (mime === "image/jpeg" && isJpeg))) {
    throw new SettlementApiError("Anexe um comprovante PDF, PNG ou JPEG válido.");
  }
  return mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg";
}

export function validateReceiptPath(path: unknown, companyId: string, withdrawalId: string) {
  if (typeof path !== "string" || !path.startsWith(`${companyId}/${withdrawalId}/`)
    || !/^[0-9a-f-]{36}\/(?:[0-9a-f-]{36})\/[0-9a-f-]{36}\.(?:pdf|png|jpg)$/.test(path)) {
    throw new SettlementApiError("O comprovante não pertence a este pedido de saque.");
  }
  return path;
}

export function companySafeSettlementSummary(summary: Record<string, any>) {
  const { provider_cost_cents: _providerCost, ...safe } = summary;
  safe.ledger = (summary.ledger ?? []).map((entry: Record<string, any>) => {
    const { provider_cost_delta_cents: _providerDelta, metadata: _metadata, ...publicEntry } = entry;
    return publicEntry;
  });
  return safe;
}
