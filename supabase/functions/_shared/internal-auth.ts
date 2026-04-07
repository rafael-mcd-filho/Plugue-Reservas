import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";

export function createSupabaseAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

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

export function isAuthorizedInternalJob(req: Request) {
  const secret = Deno.env.get("INTERNAL_JOB_SECRET");
  if (!secret) return false;
  return req.headers.get("x-job-secret") === secret;
}

export async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY nao configurada");
  }

  const supabaseUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error } = await supabaseUser.auth.getUser();
  if (error) {
    throw new Error(error.message);
  }

  return user;
}

export async function getUserRoleRows(
  supabaseAdmin: ReturnType<typeof createClient>,
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
) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    throw new Error("Nao autorizado");
  }

  const supabaseAdmin = createSupabaseAdminClient();
  const roleRows = await getUserRoleRows(supabaseAdmin, user.id);

  const isSuperadmin = roleRows.some((row) => row.role === "superadmin");
  const hasCompanyRole = roleRows.some((row) =>
    row.company_id === companyId && allowedRoles.includes(row.role),
  );

  if (!isSuperadmin && !hasCompanyRole) {
    throw new Error("Sem permissao para esta empresa");
  }

  return { supabaseAdmin, user, roleRows, isSuperadmin };
}

export async function assertSuperadmin(req: Request) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    throw new Error("Nao autorizado");
  }

  const supabaseAdmin = createSupabaseAdminClient();
  const roleRows = await getUserRoleRows(supabaseAdmin, user.id);
  const isSuperadmin = roleRows.some((row) => row.role === "superadmin");

  if (!isSuperadmin) {
    throw new Error("Sem permissao");
  }

  return { supabaseAdmin, user };
}
