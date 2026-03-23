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
    // Verify caller is superadmin
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // User client to check role
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

    // Check superadmin role
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

    // 1. Database health
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

    // 2. WhatsApp instances status
    const { data: instances } = await adminClient
      .from("company_whatsapp_instances")
      .select("id, instance_name, status, phone_number, company_id, updated_at");
    
    const { data: companies } = await adminClient
      .from("companies")
      .select("id, name, slug");
    
    const companyMap = new Map((companies || []).map((c: any) => [c.id, c]));
    
    results.whatsapp = {
      total: instances?.length || 0,
      connected: instances?.filter((i: any) => i.status === "connected").length || 0,
      disconnected: instances?.filter((i: any) => i.status !== "connected").length || 0,
      instances: (instances || []).map((i: any) => ({
        ...i,
        company_name: companyMap.get(i.company_id)?.name || "Desconhecida",
      })),
    };

    // 3. Message queue stats
    const { data: queueStats } = await adminClient
      .from("whatsapp_message_queue")
      .select("status, company_id");
    
    const pending = (queueStats || []).filter((q: any) => q.status === "pending").length;
    const failed = (queueStats || []).filter((q: any) => q.status === "failed").length;
    const processing = (queueStats || []).filter((q: any) => q.status === "processing").length;

    results.messageQueue = {
      pending,
      failed,
      processing,
      total: queueStats?.length || 0,
    };

    // 4. Recent message errors (last 24h)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentErrors } = await adminClient
      .from("whatsapp_message_logs")
      .select("id, phone, type, error_details, created_at, company_id")
      .eq("status", "error")
      .gte("created_at", yesterday)
      .order("created_at", { ascending: false })
      .limit(20);

    results.recentErrors = (recentErrors || []).map((e: any) => ({
      ...e,
      company_name: companyMap.get(e.company_id)?.name || "Desconhecida",
    }));

    // 5. Companies overview
    const activeCompanies = (companies || []).filter((c: any) => true).length;
    results.companies = {
      total: companies?.length || 0,
    };

    // 6. Reservations today
    const today = new Date().toISOString().split("T")[0];
    const { count: todayReservations } = await adminClient
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("date", today);

    results.reservationsToday = todayReservations || 0;

    // 7. Evolution API check (try fetching instances)
    const evolutionUrl = Deno.env.get("EVOLUTION_API_URL");
    const evolutionKey = Deno.env.get("EVOLUTION_API_KEY");
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
        };
        await evoRes.text();
      } catch (e: any) {
        results.evolutionApi = {
          status: "unreachable",
          error: e.message,
        };
      }
    } else {
      results.evolutionApi = {
        status: "not_configured",
        error: "EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados",
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
