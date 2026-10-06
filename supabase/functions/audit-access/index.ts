import { getRequestAuthContext, impersonationAuditDetails } from "../_shared/internal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-support-impersonation, cf-connecting-ip, user-agent",
};

type AuditEventType = "login" | "panel_access";

function getIpAddress(req: Request) {
  return req.headers.get("cf-connecting-ip") || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const context = await getRequestAuthContext(req);
    if (!context) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { supabaseAdmin, actorUser, roleRows, impersonation } = context;

    const body = await req.json().catch(() => ({}));
    const eventType = body.event_type as AuditEventType | undefined;
    const path = typeof body.path === "string" ? body.path : null;
    const companyIdFromBody = typeof body.company_id === "string" ? body.company_id : null;
    const slugFromBody = typeof body.slug === "string" ? body.slug : null;
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};

    if (!eventType || !["login", "panel_access"].includes(eventType)) {
      return new Response(JSON.stringify({ error: "event_type invalido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isSuperadmin = roleRows.some((row: any) => row.role === "superadmin");
    const membershipCompanyIds = [...new Set(
      roleRows
        .map((row: any) => row.company_id)
        .filter((value: string | null) => !!value)
    )];

    let resolvedCompanyId: string | null = null;

    if (companyIdFromBody && (isSuperadmin || membershipCompanyIds.includes(companyIdFromBody))) {
      resolvedCompanyId = companyIdFromBody;
    }

    if (!resolvedCompanyId && slugFromBody) {
      const { data: companyBySlug } = await supabaseAdmin
        .from("companies")
        .select("id")
        .eq("slug", slugFromBody)
        .maybeSingle();

      const slugCompanyId = companyBySlug?.id ?? null;
      if (slugCompanyId && (isSuperadmin || membershipCompanyIds.includes(slugCompanyId))) {
        resolvedCompanyId = slugCompanyId;
      }
    }

    if (!resolvedCompanyId && !isSuperadmin && membershipCompanyIds.length === 1) {
      resolvedCompanyId = membershipCompanyIds[0];
    }

    const { error: insertError } = await supabaseAdmin
      .from("access_audit_logs")
      .insert({
        user_id: actorUser.id,
        company_id: resolvedCompanyId,
        event_type: eventType,
        path,
        ip_address: getIpAddress(req),
        user_agent: req.headers.get("user-agent"),
        metadata: {
          ...metadata,
          impersonated_by_support: !!impersonation,
          support_session_id: impersonation?.id ?? null,
          actor_user_id: actorUser.id,
          impersonated_user_id: impersonation?.userId ?? null,
          ...impersonationAuditDetails(impersonation),
        },
      });

    if (insertError) {
      throw insertError;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.message?.startsWith("Sem permissao") ? 403 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
