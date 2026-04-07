import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader || "" } },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "superadmin")
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, any> = {};

    const dbStart = Date.now();
    const { error: dbError } = await adminClient
      .from("system_settings")
      .select("id")
      .limit(1);

    results.database = {
      status: dbError ? "error" : "healthy",
      responseMs: Date.now() - dbStart,
      error: dbError?.message || null,
    };

    const { data: instances } = await adminClient
      .from("company_whatsapp_instances")
      .select("id, instance_name, status, phone_number, company_id, updated_at");

    const { data: companies } = await adminClient
      .from("companies")
      .select("id, name, slug");

    const companyMap = new Map((companies || []).map((company: any) => [company.id, company]));

    results.whatsapp = {
      total: instances?.length || 0,
      connected: instances?.filter((instance: any) => instance.status === "connected").length || 0,
      disconnected: instances?.filter((instance: any) => instance.status !== "connected").length || 0,
      instances: (instances || []).map((instance: any) => ({
        ...instance,
        company_name: companyMap.get(instance.company_id)?.name || "Desconhecida",
      })),
    };

    const queueFailureCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: queueStats } = await adminClient
      .from("whatsapp_message_queue")
      .select("status, company_id, created_at, last_attempt_at");

    const pending = (queueStats || []).filter((item: any) => item.status === "pending").length;
    const processing = (queueStats || []).filter((item: any) => item.status === "processing").length;
    const failed = (queueStats || []).filter((item: any) => {
      if (item.status !== "failed") return false;
      const failureAt = item.last_attempt_at || item.created_at;
      return !!failureAt && failureAt >= queueFailureCutoff;
    }).length;

    results.messageQueue = {
      pending,
      failed,
      processing,
      total: queueStats?.length || 0,
      failureWindowHours: 24,
    };

    const { data: metaQueueStats } = await adminClient
      .from("meta_event_queue")
      .select("status, created_at, last_attempt_at");

    const metaPending = (metaQueueStats || []).filter((item: any) => item.status === "pending").length;
    const metaProcessing = (metaQueueStats || []).filter((item: any) => item.status === "processing").length;
    const metaFailed = (metaQueueStats || []).filter((item: any) => {
      if (item.status !== "failed") return false;
      const failureAt = item.last_attempt_at || item.created_at;
      return !!failureAt && failureAt >= queueFailureCutoff;
    }).length;

    results.metaQueue = {
      pending: metaPending,
      failed: metaFailed,
      processing: metaProcessing,
      total: metaQueueStats?.length || 0,
      failureWindowHours: 24,
    };

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentErrors } = await adminClient
      .from("whatsapp_message_logs")
      .select("id, phone, type, error_details, created_at, company_id")
      .eq("status", "error")
      .gte("created_at", yesterday)
      .order("created_at", { ascending: false })
      .limit(20);

    results.recentErrors = (recentErrors || []).map((item: any) => ({
      ...item,
      company_name: companyMap.get(item.company_id)?.name || "Desconhecida",
    }));

    const { data: recentMetaErrors } = await adminClient
      .from("meta_event_attempts")
      .select("id, company_id, reservation_id, error_message, response_body, created_at")
      .eq("status", "failed")
      .gte("created_at", yesterday)
      .order("created_at", { ascending: false })
      .limit(20);

    results.recentMetaErrors = (recentMetaErrors || []).map((item: any) => ({
      ...item,
      company_name: companyMap.get(item.company_id)?.name || "Desconhecida",
    }));

    results.companies = {
      total: companies?.length || 0,
    };

    const today = new Date().toISOString().split("T")[0];
    const { count: todayReservations } = await adminClient
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("date", today);

    results.reservationsToday = todayReservations || 0;

    const { data: settings } = await adminClient
      .from("system_settings")
      .select("key, value")
      .in("key", ["evolution_api_url", "evolution_api_token"]);

    const evolutionUrl = settings?.find((setting: any) => setting.key === "evolution_api_url")?.value?.replace(/\/+$/, "")
      || Deno.env.get("EVOLUTION_API_URL")?.replace(/\/+$/, "");
    const evolutionKey = settings?.find((setting: any) => setting.key === "evolution_api_token")?.value
      || Deno.env.get("EVOLUTION_API_KEY");

    if (evolutionUrl && evolutionKey) {
      try {
        const evoStart = Date.now();
        const evoRes = await fetch(`${evolutionUrl}/instance/fetchInstances`, {
          headers: { apikey: evolutionKey },
          signal: AbortSignal.timeout(5000),
        });

        results.evolutionApi = {
          status: evoRes.ok ? "healthy" : "error",
          responseMs: Date.now() - evoStart,
          statusCode: evoRes.status,
          source: settings?.length ? "system_settings" : "env",
        };

        await evoRes.text();
      } catch (error: any) {
        results.evolutionApi = {
          status: "unreachable",
          error: error.message,
          source: settings?.length ? "system_settings" : "env",
        };
      }
    } else {
      results.evolutionApi = {
        status: "not_configured",
        error: "Evolution nao encontrada em system_settings nem nas variaveis de ambiente",
      };
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
