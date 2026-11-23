export const WAITLIST_NOTICE_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-support-impersonation, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Channel = "evolution" | "pluguechat_official";
type State = {
  company_id: string;
  automation_enabled: boolean;
  channel: Channel;
  failures: Array<{ waitlist_id: string; called_at: string; can_retry: boolean }>;
};
type Database = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};
type Dependencies = {
  authorize: (req: Request, companyId: string) => Promise<Database>;
  wakeQueue: (database: Database, companyId: string, channel: Channel, queueId: string) => Promise<unknown>;
  schedule: (task: Promise<unknown>) => void;
};

const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...WAITLIST_NOTICE_CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function parseState(value: unknown, companyId: string): State {
  if (!isRecord(value) || value.company_id !== companyId || typeof value.automation_enabled !== "boolean"
    || !["evolution", "pluguechat_official"].includes(String(value.channel)) || !Array.isArray(value.failures)) {
    throw new Error("invalid_notification_state");
  }
  const failures = value.failures.map((failure: unknown) => {
    if (!isRecord(failure) || !isUuid(failure.waitlist_id) || !isTimestamp(failure.called_at) || typeof failure.can_retry !== "boolean") {
      throw new Error("invalid_notification_state");
    }
    return { waitlist_id: failure.waitlist_id, called_at: failure.called_at, can_retry: failure.can_retry };
  });
  return {
    company_id: companyId, automation_enabled: value.automation_enabled,
    channel: value.channel as Channel, failures: value.automation_enabled ? failures : [],
  };
}

async function stateFor(database: Database, companyId: string) {
  const { data, error } = await database.rpc("get_waitlist_call_notification_state", { _company_id: companyId });
  if (error) throw new Error("notification_state_failed");
  return parseState(data, companyId);
}

/** A retry only requeues an existing, eligible failed notice; it never calls the guest again. */
export function createWaitlistCallNotificationHandler(dependencies: Dependencies) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: WAITLIST_NOTICE_CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "Metodo nao permitido" }, 405);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "Dados invalidos" }, 400); }
    if (!isRecord(body) || !isUuid(body.company_id) || !["list", "retry"].includes(String(body.action))) {
      return json({ error: "Dados invalidos" }, 400);
    }
    if (body.action === "retry" && (!isUuid(body.waitlist_id) || !isTimestamp(body.expected_called_at))) {
      return json({ error: "Dados invalidos" }, 400);
    }

    try {
      const companyId = body.company_id;
      // Access is checked before any service-role read or write, including list.
      const database = await dependencies.authorize(req, companyId);
      if (body.action === "list") return json(await stateFor(database, companyId));

      const { data, error } = await database.rpc("retry_waitlist_call_notification", {
        _company_id: companyId, _waitlist_id: body.waitlist_id, _called_at: body.expected_called_at,
      });
      if (error || !isRecord(data) || typeof data.result !== "string") throw new Error("notification_retry_failed");
      const queued = data.result === "queued";
      if (queued) {
        if (!isUuid(data.queue_id) || !["evolution", "pluguechat_official"].includes(String(data.channel))) throw new Error("notification_retry_failed");
        // The worker checks the automation and original call deadline again before sending.
        dependencies.schedule(dependencies.wakeQueue(database, companyId, data.channel as Channel, data.queue_id));
      }
      return json({ ...await stateFor(database, companyId), retry_queued: queued, result: data.result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "Nao autorizado") return json({ error: "Nao autorizado" }, 401);
      if (message.startsWith("Sem permissao")) return json({ error: "Sem permissao para esta acao" }, 403);
      return json({ error: "Nao foi possivel consultar ou atualizar o aviso da chamada. Tente novamente." }, 500);
    }
  };
}
