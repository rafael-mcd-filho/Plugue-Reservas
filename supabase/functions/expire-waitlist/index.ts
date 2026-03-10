import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Find entries called more than 10 minutes ago
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: expired, error } = await supabase
    .from("waitlist")
    .update({ status: "expired", expired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("status", "called")
    .lt("called_at", tenMinAgo)
    .select("id, guest_name");

  if (error) {
    console.error("Error expiring waitlist entries:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  console.log(`Expired ${expired?.length || 0} waitlist entries`);

  return new Response(JSON.stringify({ expired: expired?.length || 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
