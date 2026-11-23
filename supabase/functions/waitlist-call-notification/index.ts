import { assertUserCanAccessCompany, type SupabaseAdminClient } from "../_shared/internal-auth.ts";
import { createWaitlistCallNotificationHandler } from "../_shared/waitlist-call-notification-api.ts";

async function wakeQueue(database: unknown, companyId: string, channel: string, queueId: string) {
  try {
    const supabase = database as SupabaseAdminClient;
    let secret = Deno.env.get("INTERNAL_JOB_SECRET");
    if (!secret) {
      const { data, error } = await supabase.from("system_settings").select("value").eq("key", "internal_job_secret").maybeSingle();
      if (!error && typeof data?.value === "string") secret = data.value;
    }
    const baseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
    if (!secret || !baseUrl) return; // The normal scheduler will process the same queue row.
    const worker = channel === "pluguechat_official" ? "process-pluguechat-message-queue" : "process-message-queue";
    await fetch(`${baseUrl}/functions/v1/${worker}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-job-secret": secret },
      body: JSON.stringify({ company_id: companyId, queue_id: queueId }), signal: AbortSignal.timeout(150_000),
    });
  } catch {
    // A failed wakeup must not insert/requeue another message. The scheduler can resume it.
    console.warn("Could not wake the waitlist notice queue worker.");
  }
}

Deno.serve(createWaitlistCallNotificationHandler({
  authorize: async (req, companyId) => (await assertUserCanAccessCompany(
    req, companyId, ["superadmin", "admin", "operator"], "waitlist_view",
  )).supabaseAdmin,
  wakeQueue,
  schedule: (task) => {
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) runtime.waitUntil(task);
    else task.catch(() => undefined);
  },
}));
