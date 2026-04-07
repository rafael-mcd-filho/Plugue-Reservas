import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!isAuthorizedInternalJob(req)) {
    return new Response(JSON.stringify({ error: "Nao autorizado" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createSupabaseAdminClient();

  // Find entries called more than 5 minutes ago
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: expired, error } = await supabase
    .from("waitlist")
    .update({ status: "expired", expired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("status", "called")
    .lt("called_at", fiveMinutesAgo)
    .select("id, guest_name");

  if (error) {
    console.error("Error expiring waitlist entries:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  console.log(`Expired ${expired?.length || 0} waitlist entries`);

  return new Response(JSON.stringify({ expired: expired?.length || 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
