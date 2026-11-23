import { assertSuperadmin } from "./internal-auth.ts";
import {
  PLATFORM_NOTICE_COLUMNS, PLATFORM_NOTICE_COMPANY_COLUMNS, PLATFORM_NOTICE_INSTANCE,
  PlatformNoticeError, noticeErrorResponse, noticeInteger, noticeJson, noticeQuery,
  noticeSafeRow, platformNoticeCors, readNoticeBody, readNoticeImage,
  requireNoticeCaption, requireNoticeCompanyIds, requireNoticeImagePath,
  requireNoticeProjectUrl, requireNoticeUuid, responsibleNoticeContact,
} from "./platform-whatsapp-notices.ts";
import { processPlatformWhatsAppNotices } from "./platform-whatsapp-notices-worker.ts";

const response = (rows: Record<string, unknown>[], total: number) => ({
  rows: rows.map(noticeSafeRow), total, instance_name: PLATFORM_NOTICE_INSTANCE, contact_kind: "responsible",
});

async function listNotices(admin: any, offset: number, limit: number, batchId?: string) {
  let query = admin.from("platform_whatsapp_notices").select(PLATFORM_NOTICE_COLUMNS, { count: "exact" });
  if (batchId) query = query.eq("batch_id", batchId);
  const result = noticeQuery(await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1));
  return response(result.data ?? [], result.count ?? 0);
}

function assertBodyKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(key => !["action", ...keys].includes(key))) throw new PlatformNoticeError("O aviso contém parâmetros inválidos.");
}

async function assertQueueConfigured(admin: any, projectUrl: string) {
  const result = noticeQuery(await admin.from("system_settings").select("key,value").in("key", ["evolution_api_url", "evolution_api_token", "internal_job_secret"]));
  const settings = result.data ?? [];
  if (["evolution_api_url", "evolution_api_token", "internal_job_secret"].some(key => !settings.find((row: any) => row.key === key)?.value?.trim())) {
    throw new PlatformNoticeError("O envio de avisos pelo WhatsApp ainda não está configurado. Confira as integrações do sistema.", 503);
  }
  // This value is derived from the runtime environment, never a request URL.
  // It enables the inert queue cron only after an explicit superadmin send.
  noticeQuery(await admin.from("system_settings").upsert({ key: "platform_notices_project_url", value: projectUrl }, { onConflict: "key" }));
}

function dispatchInBackground(admin: any, batchId: string, projectUrl: string, deps: ApiDependencies) {
  const task = (deps.process ?? processPlatformWhatsAppNotices)(admin, { batchId, projectUrl, limit: 3 }).catch(() => {
    console.error("Platform notice background processing stopped", { batch_id: batchId });
  });
  const defer = deps.defer ?? (globalThis as any).EdgeRuntime?.waitUntil?.bind((globalThis as any).EdgeRuntime);
  if (defer) { defer(task); return Promise.resolve(); }
  return task;
}

type ApiDependencies = {
  authorize?: typeof assertSuperadmin;
  process?: typeof processPlatformWhatsAppNotices;
  defer?: (promise: Promise<unknown>) => void;
  projectUrl?: string;
};

export async function handlePlatformWhatsAppNotices(req: Request, deps: ApiDependencies = {}) {
  if (req.method === "OPTIONS") return new Response(null, { headers: platformNoticeCors });
  if (req.method !== "POST") return noticeJson({ error: "Método não permitido." }, 405);
  try {
    const { supabaseAdmin: admin, user } = await (deps.authorize ?? assertSuperadmin)(req);
    const body = await readNoticeBody(req);
    const action = body.action;
    if (action === "list") {
      assertBodyKeys(body, ["offset", "limit"]);
      const offset = noticeInteger(body.offset, 0, 1_000_000);
      const limit = noticeInteger(body.limit, 25, 100);
      if (!limit) throw new PlatformNoticeError("Página inválida.");
      return noticeJson(await listNotices(admin, offset, limit));
    }
    if (action === "create") {
      assertBodyKeys(body, ["request_id", "company_ids", "image_path", "caption"]);
      const requestId = requireNoticeUuid(body.request_id, "Solicitação");
      const companyIds = requireNoticeCompanyIds(body.company_ids);
      const imagePath = requireNoticeImagePath(body.image_path);
      const caption = requireNoticeCaption(body.caption);
      const prior = noticeQuery(await admin.from("platform_whatsapp_notice_batches").select("id,company_ids,image_path,caption,created_by").eq("id", requestId).maybeSingle()).data;
      if (prior) {
        if (prior.created_by !== user.id || prior.image_path !== imagePath || prior.caption !== caption
          || JSON.stringify(prior.company_ids) !== JSON.stringify(companyIds)) {
          throw new PlatformNoticeError("Esta solicitação já foi usada com outro aviso. Atualize e tente novamente.", 409);
        }
        return noticeJson(await listNotices(admin, 0, 1000, requestId));
      }
      const projectUrl = requireNoticeProjectUrl(deps.projectUrl ?? Deno.env.get("SUPABASE_URL"));
      await readNoticeImage(admin, imagePath);
      const companies = noticeQuery(await admin.from("companies").select(PLATFORM_NOTICE_COMPANY_COLUMNS).in("id", companyIds)).data ?? [];
      if (companies.length !== companyIds.length) throw new PlatformNoticeError("Uma empresa selecionada não está mais disponível. Atualize a seleção.");
      const byId = new Map(companies.map((company: any) => [company.id, company]));
      const seen = new Set<string>();
      const recipients = companyIds.map(companyId => {
        const company = byId.get(companyId) as Record<string, unknown>;
        const contact = responsibleNoticeContact(company);
        const duplicate = Boolean(contact.phone && seen.has(contact.phone));
        if (contact.phone) seen.add(contact.phone);
        return { company_id: companyId, company_name: company.name, recipient_phone: contact.phone,
          status: contact.phone && !duplicate ? "queued" : "skipped",
          error_message: duplicate ? "O responsável já recebe este aviso por outra empresa selecionada." : contact.reason };
      });
      await assertQueueConfigured(admin, projectUrl);
      noticeQuery(await admin.rpc("create_platform_whatsapp_notice_batch", {
        _request_id: requestId, _company_ids: companyIds, _image_path: imagePath, _caption: caption,
        _actor_id: user.id, _recipients: recipients,
      }));
      await dispatchInBackground(admin, requestId, projectUrl, deps);
      return noticeJson(await listNotices(admin, 0, 1000, requestId));
    }
    if (action === "retry") {
      assertBodyKeys(body, ["notice_id"]);
      const id = requireNoticeUuid(body.notice_id, "Aviso");
      const row = noticeQuery(await admin.from("platform_whatsapp_notices").select(PLATFORM_NOTICE_COLUMNS).eq("id", id).maybeSingle()).data;
      if (!row) throw new PlatformNoticeError("Aviso não encontrado.", 404);
      if (!["failed", "skipped"].includes(row.status)) throw new PlatformNoticeError("Este aviso já foi enviado ou está em processamento. Confira o histórico antes de reenviar.", 409);
      const projectUrl = requireNoticeProjectUrl(deps.projectUrl ?? Deno.env.get("SUPABASE_URL"));
      await readNoticeImage(admin, row.image_path);
      const company = row.company_id
        ? noticeQuery(await admin.from("companies").select(PLATFORM_NOTICE_COMPANY_COLUMNS).eq("id", row.company_id).maybeSingle()).data
        : null;
      const contact = responsibleNoticeContact(company);
      if (contact.phone) await assertQueueConfigured(admin, projectUrl);
      noticeQuery(await admin.rpc("retry_platform_whatsapp_notice", {
        _notice_id: id, _recipient_phone: contact.phone, _error_message: contact.reason,
        _actor_id: user.id, _expected_attempts: row.attempts,
      }));
      if (contact.phone) await dispatchInBackground(admin, row.batch_id, projectUrl, deps);
      return noticeJson(await listNotices(admin, 0, 1000, row.batch_id));
    }
    throw new PlatformNoticeError("Ação de aviso inválida.");
  } catch (error) { return noticeErrorResponse(error); }
}
