import { normalizeStoredPhoneE164 } from "./phone.ts";

export const PLATFORM_NOTICE_INSTANCE = "RWSL";
export const PLATFORM_NOTICE_BUCKET = "system-assets";
export const PLATFORM_NOTICE_IMAGE_LIMIT = 5 * 1024 * 1024;
export const PLATFORM_NOTICE_CAPTION_LIMIT = 1000;
export const PLATFORM_NOTICE_COLUMNS = "id,batch_id,company_id,company_name,recipient_phone,image_path,caption,status,attempts,error_message,created_at,processed_at";
export const PLATFORM_NOTICE_COMPANY_COLUMNS = "id,name,responsible_phone,responsible_phone_e164,responsible_phone_country,deletion_requested_at";
export const platformNoticeCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret, x-support-impersonation",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class PlatformNoticeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function noticeJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...platformNoticeCors, "Content-Type": "application/json" } });
}

export function requireNoticeUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PlatformNoticeError(`${label} inválido.`);
  }
  return value.toLowerCase();
}

export function requireNoticeCompanyIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new PlatformNoticeError("Selecione entre 1 e 1.000 empresas.");
  return [...new Set(value.map(id => requireNoticeUuid(id, "Empresa")))].sort();
}

export function requireNoticeImagePath(value: unknown): string {
  if (typeof value !== "string" || !/^notification-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|jpeg)$/.test(value)) {
    throw new PlatformNoticeError("Selecione uma imagem PNG ou JPG enviada nesta tela.");
  }
  return value;
}

export function requireNoticeCaption(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > PLATFORM_NOTICE_CAPTION_LIMIT) {
    throw new PlatformNoticeError("Informe uma legenda de até 1.000 caracteres.");
  }
  return value.trim();
}

export function noticeInteger(value: unknown, fallback: number, max: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new PlatformNoticeError("Página inválida.");
  return value;
}

export function requireNoticeProjectUrl(value: string | undefined): string {
  if (!value) throw new PlatformNoticeError("Endereço do projeto indisponível.", 503);
  const parsed = new URL(value);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "kong"].includes(parsed.hostname)))
    || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new PlatformNoticeError("Endereço do projeto inválido.", 503);
  }
  return parsed.origin;
}

export function noticeImageUrl(projectUrl: string, imagePath: string): string {
  return `${requireNoticeProjectUrl(projectUrl)}/storage/v1/object/public/${PLATFORM_NOTICE_BUCKET}/${requireNoticeImagePath(imagePath)}`;
}

export function responsibleNoticeContact(company: Record<string, unknown> | null) {
  if (!company || company.deletion_requested_at) return { phone: null, reason: "Empresa não está disponível para novos avisos." };
  const canonical = typeof company.responsible_phone_e164 === "string" ? company.responsible_phone_e164.trim() : "";
  const raw = typeof company.responsible_phone === "string" ? company.responsible_phone : "";
  // A populated but invalid canonical field must not silently reroute to raw.
  const phone = normalizeStoredPhoneE164(canonical || raw, String(company.responsible_phone_country || "BR"));
  return phone ? { phone, reason: null } : { phone: null, reason: "Telefone do responsável ausente ou inválido no cadastro." };
}

export function noticeSafeRow(row: Record<string, unknown>) {
  return Object.fromEntries(PLATFORM_NOTICE_COLUMNS.split(",").map(key => [key, row[key] ?? null]));
}

export function noticeQuery<T extends { error?: { code?: string; message?: string } | null }>(result: T): T {
  if (result.error) {
    if (["22023", "23514"].includes(result.error.code ?? "")) throw new PlatformNoticeError("Os dados do aviso são inválidos.");
    if (result.error.code === "23505" || result.error.code === "P0001") throw new PlatformNoticeError("Este envio mudou ou já está em processamento. Atualize a lista.", 409);
    throw new PlatformNoticeError("Não foi possível registrar ou consultar os avisos.", 503);
  }
  return result;
}

export async function noticeTimeout<T>(task: PromiseLike<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([Promise.resolve(task), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PlatformNoticeError(message, 503)), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

async function readNoticeImageBytes(admin: any, imagePath: string): Promise<{ mime: "image/png" | "image/jpeg"; size: number }> {
  requireNoticeImagePath(imagePath);
  const { data, error } = await admin.storage.from(PLATFORM_NOTICE_BUCKET).download(imagePath);
  if (error || !data) throw new PlatformNoticeError("A imagem do aviso não está disponível. Envie-a novamente.");
  if (!Number.isFinite(data.size) || data.size < 4 || data.size > PLATFORM_NOTICE_IMAGE_LIMIT) throw new PlatformNoticeError("A imagem deve ter no máximo 5 MB.");
  const mime = String(data.type ?? "").split(";")[0].toLowerCase();
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== data.size || bytes.byteLength > PLATFORM_NOTICE_IMAGE_LIMIT) throw new PlatformNoticeError("Imagem inválida.");
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b,index) => bytes[index] === b);
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (png && imagePath.endsWith(".png") && mime === "image/png") return { mime: "image/png", size: bytes.length };
  if (jpeg && /\.jpe?g$/.test(imagePath) && ["image/jpeg", "image/jpg"].includes(mime)) return { mime: "image/jpeg", size: bytes.length };
  throw new PlatformNoticeError("O arquivo precisa ser uma imagem PNG ou JPG válida.");
}

export function readNoticeImage(admin: any, imagePath: string, timeoutMs = 10_000) {
  // The underlying storage read may finish late, but no caller can continue to
  // dispatch after this bounded preparation has rejected.
  return noticeTimeout(readNoticeImageBytes(admin, imagePath), timeoutMs, "A imagem demorou para carregar. Tente novamente.");
}

export async function readNoticeBody(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await req.text(); } catch { throw new PlatformNoticeError("Requisição inválida."); }
  if (text.length > 100_000) throw new PlatformNoticeError("Requisição muito grande.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new PlatformNoticeError("Requisição inválida."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformNoticeError("Requisição inválida.");
  return value as Record<string, unknown>;
}

export function noticeErrorResponse(error: unknown) {
  if (error instanceof PlatformNoticeError) return noticeJson({ error: error.message }, error.status);
  const message = error instanceof Error ? error.message : "";
  if (/Nao autorizado|Não autorizado/i.test(message)) return noticeJson({ error: "Entre novamente para enviar avisos." }, 401);
  if (/Sem permissao|Sem permissão/i.test(message)) return noticeJson({ error: "Apenas o superadmin pode gerenciar estes avisos." }, 403);
  console.error("Platform WhatsApp notice request failed", { type: error instanceof Error ? error.name : "unknown" });
  return noticeJson({ error: "Não foi possível concluir a solicitação dos avisos." }, 503);
}
