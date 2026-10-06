import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";
import {
  assertSupportCompanyMatches,
  isUuid,
  validateSupportImpersonationContext,
  type SupportImpersonationContext,
} from "./support-authorization.ts";

export function createSupabaseAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export function getClientIpAddress(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const candidates = [
    req.headers.get("cf-connecting-ip"),
    forwardedFor?.split(",")[0]?.trim() || null,
    req.headers.get("x-real-ip"),
    req.headers.get("fly-client-ip"),
    req.headers.get("fastly-client-ip"),
  ];

  return candidates.find((value) => typeof value === "string" && value.length > 0) || null;
}

export async function isAuthorizedInternalJob(req: Request) {
  const providedSecret = req.headers.get("x-job-secret");
  if (!providedSecret) return false;

  const envSecret = Deno.env.get("INTERNAL_JOB_SECRET");
  if (envSecret && providedSecret === envSecret) {
    return true;
  }

  try {
    const supabaseAdmin = createSupabaseAdminClient();
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", "internal_job_secret")
      .maybeSingle();

    if (error) {
      console.error("Failed to load internal job secret from system_settings", error);
      return false;
    }

    return typeof data?.value === "string" && data.value.length > 0 && data.value === providedSecret;
  } catch (error) {
    console.error("Failed to validate internal job secret", error);
    return false;
  }
}

export function createSupabaseRequestClient(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY nao configurada");
  }

  const sessionId = req.headers.get("x-support-impersonation");
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: {
      Authorization: authHeader || "",
      ...(sessionId ? { "x-support-impersonation": sessionId } : {}),
    } },
  });
}

export type SupabaseRequestClient = ReturnType<typeof createSupabaseRequestClient>;

export async function getRequestAuthContext(req: Request) {
  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  if (!token) return null;
  const supabaseAdmin = createSupabaseAdminClient();
  // Edge requests carry a JWT, not a persisted Auth session. Validate that
  // exact JWT with Auth using the same server client as the original handlers.
  // The request client below is reserved for the caller's RLS-scoped RPCs.
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    console.error("Request JWT validation failed", {
      code: error?.code ?? "user_missing", status: error?.status ?? null,
    });
    return null;
  }

  const supabaseUser = createSupabaseRequestClient(req);
  const actorRoleRows = await getUserRoleRows(supabaseAdmin, user.id);
  const isSupport = actorRoleRows.some((row) => row.role === "support");
  const sessionId = req.headers.get("x-support-impersonation");
  let impersonation: SupportImpersonationContext | null = null;
  let effectiveUser = user;
  let roleRows = actorRoleRows;

  if (sessionId) {
    if (!isSupport || !isUuid(sessionId)) {
      throw new Error("Sem permissao: sessao de suporte invalida");
    }
    const { data, error: contextError } = await supabaseUser.rpc("get_support_impersonation_context");
    if (contextError) throw new Error("Sem permissao: sessao de suporte invalida ou expirada");
    impersonation = validateSupportImpersonationContext(data, user.id, sessionId);
    const { data: target, error: targetError } = await supabaseAdmin.auth.admin.getUserById(impersonation.userId);
    if (targetError || !target.user) throw new Error("Sem permissao: usuario impersonado indisponivel");
    effectiveUser = target.user;
    // Never inherit additional companies/global roles from the impersonated user.
    roleRows = [{ role: impersonation.effectiveRole, company_id: impersonation.companyId }];
  }

  return { supabaseAdmin, supabaseUser, user: effectiveUser, actorUser: user,
    roleRows, actorRoleRows, isSupport, impersonation };
}

export async function getAuthenticatedUser(req: Request) {
  return (await getRequestAuthContext(req))?.user ?? null;
}

export function impersonationAuditDetails(impersonation: SupportImpersonationContext | null) {
  return impersonation ? {
    impersonated_by_support: true,
    support_session_id: impersonation.id,
    actor_user_id: impersonation.actorUserId,
    impersonated_user_id: impersonation.userId,
    scope_company_id: impersonation.companyId,
    effective_role: impersonation.effectiveRole,
  } : {};
}

export async function getUserRoleRows(
  supabaseAdmin: SupabaseAdminClient,
  userId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role, company_id")
    .eq("user_id", userId);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as Array<{ role: string; company_id: string | null }>;
}

export async function assertUserCanAccessCompany(
  req: Request,
  companyId: string,
  allowedRoles: string[] = ["superadmin", "admin", "operator"],
  permission?: string,
) {
  const context = await getRequestAuthContext(req);
  if (!context) {
    throw new Error("Nao autorizado");
  }

  const { roleRows, impersonation, isSupport } = context;
  if (isSupport && !impersonation) throw new Error("Sem permissao: inicie uma sessao de suporte");
  assertSupportCompanyMatches(impersonation, companyId, allowedRoles);

  const isSuperadmin = roleRows.some((row) => row.role === "superadmin");
  const hasCompanyRole = roleRows.some((row) =>
    row.company_id === companyId && allowedRoles.includes(row.role),
  );

  if (!isSuperadmin && !hasCompanyRole) {
    throw new Error("Sem permissao para esta empresa");
  }

  if (permission && !isSuperadmin) {
    const { data: permitted, error } = await context.supabaseUser.rpc("has_company_panel_permission", {
      _user_id: context.actorUser.id,
      _company_id: companyId,
      _permission: permission,
    });
    if (error || permitted !== true) throw new Error("Sem permissao para esta acao");
  }

  if (impersonation) {
    // These functions use service_role for provider work, so database triggers
    // cannot infer the authenticated actor. Record the validated delegation here.
    const { error } = await context.supabaseAdmin.from("audit_logs").insert({
      user_id: context.actorUser.id,
      action: "support_api_access",
      entity_type: "company",
      entity_id: companyId,
      details: {
        ...impersonationAuditDetails(impersonation),
        endpoint: new URL(req.url).pathname,
        method: req.method,
        phase: "authorized_request",
      },
      ip_address: getClientIpAddress(req),
    });
    if (error) throw new Error("Nao foi possivel registrar o acesso de suporte");
  }

  return { ...context, isSuperadmin };
}

export async function assertSuperadmin(req: Request) {
  const context = await getRequestAuthContext(req);
  if (!context) {
    throw new Error("Nao autorizado");
  }

  const { supabaseAdmin, actorUser: user, actorRoleRows: roleRows } = context;
  const isSuperadmin = roleRows.some((row) => row.role === "superadmin");

  if (!isSuperadmin || context.isSupport || context.impersonation) {
    throw new Error("Sem permissao");
  }

  return { supabaseAdmin, user };
}
