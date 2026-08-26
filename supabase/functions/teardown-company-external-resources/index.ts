import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

// Storage prefixes known to hold company-scoped files in the shared
// "system-assets" bucket. Each is namespaced {prefix}/{company_id}/...
// (see the storage RLS policies added alongside each feature).
const STORAGE_PREFIXES = ["company-logos", "company-notices", "company-hero-media", "whatsapp-broadcasts"];
const STORAGE_BUCKET = "system-assets";

async function teardownWhatsAppInstance(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
) {
  const { data: instance } = await supabaseAdmin
    .from("company_whatsapp_instances")
    .select("instance_name")
    .eq("company_id", companyId)
    .maybeSingle();

  if (!instance?.instance_name) {
    return { status: "ok", note: "no_instance" };
  }

  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("key, value")
    .in("key", ["evolution_api_url", "evolution_api_token"]);

  const evolutionUrl = settings?.find((s) => s.key === "evolution_api_url")?.value?.replace(/\/+$/, "");
  const evolutionToken = settings?.find((s) => s.key === "evolution_api_token")?.value;

  if (!evolutionUrl || !evolutionToken) {
    // Nothing to call; not configured is not this pipeline's failure to
    // surface as blocking -- record and move on.
    return { status: "ok", note: "evolution_api_not_configured" };
  }

  const res = await fetch(`${evolutionUrl}/instance/delete/${instance.instance_name}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", apikey: evolutionToken },
  });

  // 404 means the instance is already gone server-side -- treat as success
  // (idempotent, safe to retry).
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    return { status: "error", http_status: res.status, body: body.slice(0, 500) };
  }

  return { status: "ok", instance_name: instance.instance_name };
}

async function teardownStorageFiles(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  companyId: string,
) {
  const removedByPrefix: Record<string, number> = {};

  for (const prefix of STORAGE_PREFIXES) {
    const folder = `${prefix}/${companyId}`;
    const { data: files, error: listError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).list(folder, {
      limit: 1000,
    });

    if (listError) {
      return { status: "error", prefix, error: listError.message };
    }

    const paths = (files ?? [])
      .filter((file) => file.id !== null) // list() also returns pseudo-folder entries with id=null
      .map((file) => `${folder}/${file.name}`);

    if (paths.length > 0) {
      const { error: removeError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(paths);
      if (removeError) {
        return { status: "error", prefix, error: removeError.message };
      }
    }

    removedByPrefix[prefix] = paths.length;
  }

  return { status: "ok", removed_by_prefix: removedByPrefix };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const requestId = typeof body.request_id === "string" ? body.request_id : null;
    const companyId = typeof body.company_id === "string" ? body.company_id : null;

    if (!requestId || !companyId) {
      return new Response(JSON.stringify({ error: "request_id e company_id sao obrigatorios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createSupabaseAdminClient();

    // Asaas is deliberately excluded: neither the company's own prepayment
    // integration nor Plugue's own SaaS billing customer/charges are
    // touched here. Local rows in company_asaas_configs/company_billing_links
    // are still removed by the SQL engine's ordinary table-by-table sweep --
    // that's just our local cache/credential, not an Asaas API call.
    const [whatsapp, storage] = await Promise.all([
      teardownWhatsAppInstance(supabaseAdmin, companyId),
      teardownStorageFiles(supabaseAdmin, companyId),
    ]);

    const overallStatus = whatsapp.status === "ok" && storage.status === "ok" ? "ok" : "error";

    const { error: updateError } = await supabaseAdmin
      .from("company_deletion_requests")
      .update({
        external_teardown_result: {
          status: overallStatus,
          whatsapp,
          storage,
          completed_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("company_id", companyId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return new Response(JSON.stringify({ ok: true, status: overallStatus, whatsapp, storage }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("teardown-company-external-resources failed", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Erro desconhecido" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
