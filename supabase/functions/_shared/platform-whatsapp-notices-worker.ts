import { assertSuperadmin, createSupabaseAdminClient, isAuthorizedInternalJob } from "./internal-auth.ts";
import {
  PLATFORM_NOTICE_INSTANCE, PlatformNoticeError, noticeErrorResponse, noticeImageUrl,
  noticeJson, noticeQuery, noticeTimeout, platformNoticeCors, readNoticeBody, readNoticeImage,
  requireNoticeCaption, requireNoticeProjectUrl, requireNoticeUuid,
} from "./platform-whatsapp-notices.ts";

type Outcome = { status: "accepted" | "failed" | "unknown"; providerMessageId?: string; errorMessage?: string };
type WorkerOptions = {
  batchId?: string; limit?: number; projectUrl?: string;
  fetch?: typeof fetch; timeoutMs?: number; preparationTimeoutMs?: number;
};

function providerMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, any>;
  const status = String(body.status ?? body.data?.status ?? "").toLowerCase();
  if (body.error || body.data?.error || ["error", "failed", "rejected"].includes(status)) return null;
  const candidate = body.key?.id ?? body.data?.key?.id ?? body.message?.key?.id;
  return typeof candidate === "string" && candidate.trim() && candidate.length <= 255 ? candidate.trim() : null;
}

export async function dispatchPlatformNotice(
  config: { url: string; token: string }, row: Record<string, any>,
  image: { mime: "image/png" | "image/jpeg"; url: string },
  options: Pick<WorkerOptions, "fetch" | "timeoutMs"> = {},
): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await (options.fetch ?? fetch)(`${config.url}/message/sendMedia/${PLATFORM_NOTICE_INSTANCE}`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", apikey: config.token },
      body: JSON.stringify({
        number: row.recipient_phone.replace(/^\+/, ""), mediatype: "image", mimetype: image.mime,
        caption: row.caption, media: image.url, fileName: image.mime === "image/png" ? "aviso.png" : "aviso.jpg",
      }),
    });
    const raw = await response.text();
    let payload: unknown = null;
    if (raw.length <= 65_536) { try { payload = JSON.parse(raw); } catch { /* No usable provider acknowledgement. */ } }
    const id = providerMessageId(payload);
    if (response.ok && id) return { status: "accepted", providerMessageId: id };
    // Only explicit refusals are safe to offer for retry. An ambiguous answer
    // may follow a successful send, so it must never be retried automatically.
    if ([400,401,403,404,405,413,415,422,429].includes(response.status)) {
      return { status: "failed", errorMessage: response.status === 429
        ? "A instância atingiu o limite de envios. Tente novamente mais tarde."
        : "A instância RWSL recusou o envio. Confira a conexão e o contato do responsável." };
    }
    return { status: "unknown", errorMessage: "Não foi possível confirmar o envio. Confira a conversa na instância RWSL antes de criar outro aviso." };
  } catch {
    return { status: "unknown", errorMessage: "A conexão terminou sem confirmação do envio. Confira a instância RWSL antes de criar outro aviso." };
  } finally { clearTimeout(timer); }
}

async function evolutionConfig(admin: any) {
  const result = noticeQuery(await admin.from("system_settings").select("key,value").in("key", ["evolution_api_url", "evolution_api_token"]));
  const settings = result.data ?? [];
  const url = settings.find((s: any) => s.key === "evolution_api_url")?.value?.trim()?.replace(/\/+$/, "");
  const token = settings.find((s: any) => s.key === "evolution_api_token")?.value?.trim();
  if (!url || !token) throw new PlatformNoticeError("A integração Evolution não está configurada para os avisos.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PlatformNoticeError("O endereço da integração Evolution não está configurado corretamente."); }
  if (!["http:","https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PlatformNoticeError("O endereço da integração Evolution não está configurado corretamente.");
  }
  return { url, token };
}

async function hasCurrentNoticeLease(admin: any, row: Record<string, any>, sendTimeoutMs: number) {
  if (!row.company_id) return false;
  const [noticeResult, companyResult] = await noticeTimeout(Promise.all([
    admin.from("platform_whatsapp_notices").select("id,status,company_id,lease_token,lease_expires_at").eq("id", row.id).maybeSingle(),
    admin.from("companies").select("id,deletion_requested_at").eq("id", row.company_id).maybeSingle(),
  ]), 10_000, "Não foi possível verificar o envio. Tente novamente.");
  const notice = noticeQuery(noticeResult).data;
  const company = noticeQuery(companyResult).data;
  // Leave enough time for the whole provider request. A worker whose claim
  // expired while preparing storage must never contact Evolution afterwards.
  return Boolean(notice && company && !company.deletion_requested_at
    && notice.company_id === row.company_id && company.id === row.company_id
    && notice.status === "processing" && notice.lease_token === row.lease_token
    && Date.parse(notice.lease_expires_at) > Date.now() + sendTimeoutMs + 1000);
}

export async function processPlatformWhatsAppNotices(admin: any, options: WorkerOptions = {}) {
  const projectUrl = requireNoticeProjectUrl(options.projectUrl ?? Deno.env.get("SUPABASE_URL"));
  const limit = Math.max(1, Math.min(3, Math.trunc(options.limit ?? 3)));
  const claims = noticeQuery(await admin.rpc("claim_platform_whatsapp_notices", {
    _limit: limit, _batch_id: options.batchId ?? null,
  })).data ?? [];
  const summary = { claimed: claims.length, accepted: 0, failed: 0, unknown: 0, persistence_errors: 0 };
  if (!claims.length) return summary;
  let config: { url: string; token: string } | null = null;
  let configFailure: string | null = null;
  try { config = await evolutionConfig(admin); }
  catch (error) { configFailure = error instanceof PlatformNoticeError ? error.message : "A configuração de envio não está disponível. Tente novamente mais tarde."; }
  const images = new Map<string, { mime: "image/png" | "image/jpeg"; size: number }>();
  for (const row of claims) {
    let result: Outcome;
    if (!config) result = { status: "failed", errorMessage: configFailure! };
    else {
      try {
        requireNoticeCaption(row.caption);
        if (typeof row.recipient_phone !== "string" || !/^\+[1-9][0-9]{6,14}$/.test(row.recipient_phone)) throw new PlatformNoticeError("Telefone do responsável inválido.");
        let image = images.get(row.image_path);
        if (!image) { image = await readNoticeImage(admin, row.image_path, options.preparationTimeoutMs ?? 10_000); images.set(row.image_path, image); }
        if (!await hasCurrentNoticeLease(admin, row, options.timeoutMs ?? 20_000)) {
          // Another worker/cron owns the outcome now, or the company became
          // unavailable. Do not mutate/requeue a stale lease or send anything.
          summary.unknown++;
          continue;
        }
        result = await dispatchPlatformNotice(config, row, { mime: image.mime, url: noticeImageUrl(projectUrl, row.image_path) }, options);
      } catch (error) {
        // All errors above dispatch happen before contacting Evolution. The
        // dispatch adapter itself converts transport ambiguity into unknown.
        result = { status: "failed", errorMessage: error instanceof PlatformNoticeError ? error.message : "Não foi possível preparar a imagem do aviso. Tente novamente." };
      }
    }
    let final;
    try {
      final = await admin.rpc("finish_platform_whatsapp_notice", {
        _notice_id: row.id, _lease_token: row.lease_token, _status: result.status,
        _provider_message_id: result.providerMessageId ?? null, _error_message: result.errorMessage ?? null,
      });
    } catch { final = { error: true, data: false }; }
    if (final.error || final.data !== true) {
      summary.persistence_errors++;
      console.error("Platform notice result could not be persisted", { notice_id: row.id });
      // A lost DB acknowledgement must not lead to a second provider call. If
      // the first finish committed, the token guard makes this a harmless no-op.
      try {
        await admin.rpc("finish_platform_whatsapp_notice", {
          _notice_id: row.id, _lease_token: row.lease_token, _status: "unknown",
          _provider_message_id: result.providerMessageId ?? null,
          _error_message: "A confirmação do envio não pôde ser registrada. Confira a instância RWSL.",
        });
      } catch { /* The expired lease will become unknown, never queued. */ }
      // Stop contacting the provider while the database cannot preserve its
      // acknowledgements. Other leases expire conservatively as unknown.
      break;
    } else summary[result.status]++;
  }
  return summary;
}

export async function handleProcessPlatformWhatsAppNotices(req: Request, deps: {
  isInternal?: typeof isAuthorizedInternalJob; authorize?: typeof assertSuperadmin;
  admin?: () => any; process?: typeof processPlatformWhatsAppNotices;
} = {}) {
  if (req.method === "OPTIONS") return new Response(null, { headers: platformNoticeCors });
  if (req.method !== "POST") return noticeJson({ error: "Método não permitido." }, 405);
  try {
    let admin: any;
    if (await (deps.isInternal ?? isAuthorizedInternalJob)(req)) admin = (deps.admin ?? createSupabaseAdminClient)();
    else admin = (await (deps.authorize ?? assertSuperadmin)(req)).supabaseAdmin;
    const body = await readNoticeBody(req);
    if (Object.keys(body).some(key => !["batch_id", "limit"].includes(key))) throw new PlatformNoticeError("Parâmetro de processamento inválido.");
    const batchId = body.batch_id == null ? undefined : requireNoticeUuid(body.batch_id, "Lote");
    const limit = body.limit == null ? 3 : body.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 3) throw new PlatformNoticeError("Lote de processamento inválido.");
    return noticeJson(await (deps.process ?? processPlatformWhatsAppNotices)(admin, { batchId, limit }));
  } catch (error) { return noticeErrorResponse(error); }
}
