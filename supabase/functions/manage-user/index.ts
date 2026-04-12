import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type UserRoleRow = {
  user_id: string;
  role: string;
  company_id: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  is_active: boolean;
  created_at: string | null;
};

type CallerContext = {
  supabaseAdmin: ReturnType<typeof createClient>;
  callerId: string;
  isSuperadmin: boolean;
  adminCompanyIds: string[];
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRAZIL_PHONE_PATTERN = /^[1-9][0-9](?:9?[0-9]{8})$/;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_REQUIREMENTS_ERROR = `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`;
const PASSWORD_POLICY_REJECTED_ERROR = "A senha foi rejeitada pela politica de seguranca. Tente uma senha menos obvia e diferente de dados pessoais.";

function normalizePasswordErrorMessage(message: string | null | undefined) {
  if (!message) return PASSWORD_REQUIREMENTS_ERROR;

  const normalized = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const mentionsPassword = normalized.includes("password") || normalized.includes("senha");
  const mentionsLength = normalized.includes("pelo menos")
    || normalized.includes("at least")
    || normalized.includes("minimum")
    || normalized.includes("minimo");
  const mentionsCharacters = normalized.includes("character") || normalized.includes("caracter");
  const mentionsUppercase = normalized.includes("uppercase") || normalized.includes("maiuscula");
  const mentionsLowercase = normalized.includes("lowercase") || normalized.includes("minuscula");
  const mentionsNumber = normalized.includes("number") || normalized.includes("digit") || normalized.includes("numero");

  const matchesMinLengthRule = mentionsPassword && mentionsLength && mentionsCharacters;
  const matchesRequiredCharacterRule = mentionsPassword && (
    (mentionsUppercase && mentionsLowercase)
    || (mentionsUppercase && mentionsNumber)
    || (mentionsLowercase && mentionsNumber)
  );

  if (normalized === "weak_password") {
    return PASSWORD_POLICY_REJECTED_ERROR;
  }

  return matchesMinLengthRule || matchesRequiredCharacterRule
    ? PASSWORD_REQUIREMENTS_ERROR
    : message;
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeFullNameValue(value: unknown) {
  return normalizeOptionalText(value);
}

function normalizeEmailValue(value: unknown) {
  const normalized = normalizeOptionalText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizePhoneValue(value: unknown) {
  return normalizeOptionalText(value);
}

function normalizePasswordValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isValidEmail(value: string) {
  return EMAIL_PATTERN.test(value);
}

function isValidBrazilPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const localDigits = digits.length > 11 && digits.startsWith("55")
    ? digits.slice(2)
    : digits;

  return BRAZIL_PHONE_PATTERN.test(localDigits);
}

function isStrongPassword(value: string) {
  return value.length >= MIN_PASSWORD_LENGTH;
}

async function verifyCaller(req: Request): Promise<CallerContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Nao autorizado");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user: caller } } = await supabaseUser.auth.getUser();
  if (!caller) throw new Error("Nao autorizado");

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
  const { data: callerRoles, error: callerRolesError } = await supabaseAdmin
    .from("user_roles")
    .select("role, company_id")
    .eq("user_id", caller.id);

  if (callerRolesError) throw new Error(callerRolesError.message);

  const roles = (callerRoles ?? []) as Array<{ role: string; company_id: string | null }>;
  const isSuperadmin = roles.some((role) => role.role === "superadmin");
  const adminCompanyIds = [...new Set(
    roles
      .filter((role) => role.role === "admin" && role.company_id)
      .map((role) => role.company_id as string),
  )];

  return { supabaseAdmin, callerId: caller.id, isSuperadmin, adminCompanyIds };
}

async function getUserContext(supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  const [{ data: roles, error: rolesError }, { data: profile, error: profileError }] = await Promise.all([
    supabaseAdmin
      .from("user_roles")
      .select("user_id, role, company_id")
      .eq("user_id", userId),
    supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, phone, company_id, is_active, created_at")
      .eq("id", userId)
      .maybeSingle(),
  ]);

  if (rolesError) throw new Error(rolesError.message);
  if (profileError) throw new Error(profileError.message);

  return {
    roles: (roles ?? []) as UserRoleRow[],
    profile: (profile as ProfileRow | null) ?? null,
  };
}

function getManagedRole(roles: UserRoleRow[]) {
  return roles.find((role) => role.role === "admin")
    ?? roles.find((role) => role.role === "operator")
    ?? null;
}

function normalizeOptionalCompanyId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeEffectiveRole(value: unknown) {
  return value === "admin" || value === "operator" ? value : null;
}

function sanitizeOrigin(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function getAppOrigin(req: Request) {
  const origin = sanitizeOrigin(req.headers.get("origin"));
  if (origin) return origin;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return sanitizeOrigin(new URL(referer).origin);
    } catch {
      // Ignore invalid referer and fall through to envs.
    }
  }

  return sanitizeOrigin(Deno.env.get("APP_URL"))
    ?? sanitizeOrigin(Deno.env.get("SITE_URL"));
}

async function generateRecoveryAccessLink(
  supabaseAdmin: ReturnType<typeof createClient>,
  req: Request,
  email: string,
) {
  const appOrigin = getAppOrigin(req);
  const redirectTo = appOrigin ? `${appOrigin}/redefinir-senha` : undefined;
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: redirectTo ? { redirectTo } : undefined,
  });

  if (error) {
    throw new Error(error.message);
  }

  return ((data as any)?.properties?.action_link ?? (data as any)?.action_link ?? null) as string | null;
}

function getAllowedCompanyIds(context: CallerContext, scopeCompanyId?: string | null) {
  if (context.isSuperadmin) {
    return scopeCompanyId ? [scopeCompanyId] : null;
  }

  return context.adminCompanyIds;
}

function assertCallerCanManageUsers(context: CallerContext) {
  if (!context.isSuperadmin && context.adminCompanyIds.length === 0) {
    throw new Error("Apenas admins e superadmins podem gerenciar usuarios");
  }
}

function withImpersonationAuditDetails(
  details: Record<string, unknown>,
  scopeCompanyId?: string | null,
  impersonatedBySuperadmin?: boolean,
  effectiveRole: "admin" | "operator" | null = "admin",
) {
  if (!impersonatedBySuperadmin || !scopeCompanyId) {
    return details;
  }

  return {
    ...details,
    impersonated_by_superadmin: true,
    scope_company_id: scopeCompanyId,
    effective_role: effectiveRole ?? "admin",
  };
}

function assertCallerCanAccessCompany(
  context: CallerContext,
  companyId: string | null,
  scopeCompanyId?: string | null,
) {
  if (!companyId) return;

  const allowedCompanyIds = getAllowedCompanyIds(context, scopeCompanyId);
  if (!allowedCompanyIds) return;

  if (!allowedCompanyIds.includes(companyId)) {
    throw new Error("Admins so podem gerenciar usuarios da propria empresa");
  }
}

async function buildAuthUserUpdates(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  input: {
    full_name?: string;
    email?: string | null;
    password?: string;
  },
) {
  const authUpdates: Record<string, unknown> = {};

  if (input.email !== undefined) {
    authUpdates.email = input.email;
    authUpdates.email_confirm = true;
  }

  if (input.password !== undefined) {
    authUpdates.password = input.password;
    authUpdates.email_confirm = true;
  }

  if (input.full_name !== undefined) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw new Error(error.message);

    authUpdates.user_metadata = {
      ...(data.user?.user_metadata ?? {}),
      full_name: input.full_name,
    };
  }

  return authUpdates;
}

async function syncProfileAndAuth(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  currentProfile: ProfileRow | null,
  input: {
    full_name?: string;
    email?: string | null;
    phone?: string | null;
    company_id?: string | null;
    password?: string;
  },
) {
  const profileUpdates: Record<string, unknown> = {};
  const rollbackUpdates: Record<string, unknown> = {};
  let shouldUpdateProfile = false;

  if (input.full_name !== undefined) {
    profileUpdates.full_name = input.full_name;
    rollbackUpdates.full_name = currentProfile?.full_name ?? "";
    shouldUpdateProfile = true;
  }

  if (input.email !== undefined) {
    profileUpdates.email = input.email;
    rollbackUpdates.email = currentProfile?.email ?? null;
    shouldUpdateProfile = true;
  }

  if (input.phone !== undefined) {
    profileUpdates.phone = input.phone;
    rollbackUpdates.phone = currentProfile?.phone ?? null;
    shouldUpdateProfile = true;
  }

  if (input.company_id !== undefined) {
    profileUpdates.company_id = input.company_id;
    rollbackUpdates.company_id = currentProfile?.company_id ?? null;
    shouldUpdateProfile = true;
  }

  if (shouldUpdateProfile) {
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        ...profileUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (profileError) throw new Error(profileError.message);
  }

  const authUpdates = await buildAuthUserUpdates(supabaseAdmin, userId, {
    full_name: input.full_name,
    email: input.email,
    password: input.password,
  });

  if (Object.keys(authUpdates).length === 0) {
    return;
  }

  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdates);
  if (!authError) {
    return;
  }

  if (shouldUpdateProfile) {
    const { error: rollbackError } = await supabaseAdmin
      .from("profiles")
      .update({
        ...rollbackUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (rollbackError) {
      console.error("Failed to rollback profile after auth update error", rollbackError);
    }
  }

  throw new Error(normalizePasswordErrorMessage(authError.message));
}

async function assertCallerCanManageTarget(
  context: CallerContext,
  targetRoles: UserRoleRow[],
  targetProfile: ProfileRow | null,
  explicitCompanyId?: string | null,
  scopeCompanyId?: string | null,
) {
  const allowedCompanyIds = getAllowedCompanyIds(context, scopeCompanyId);
  const isScopedSuperadmin = context.isSuperadmin && !!scopeCompanyId;

  if (context.isSuperadmin && !isScopedSuperadmin) return;

  if (targetRoles.some((role) => role.role === "superadmin")) {
    throw new Error("Admins nao podem gerenciar superadmins");
  }

  const companyIds = [...new Set([
    explicitCompanyId,
    targetProfile?.company_id ?? null,
    ...targetRoles.map((role) => role.company_id),
  ].filter(Boolean) as string[])];

  if (!allowedCompanyIds || companyIds.length === 0 || companyIds.some((companyId) => !allowedCompanyIds.includes(companyId))) {
    throw new Error("Admins so podem gerenciar usuarios da propria empresa");
  }
}

async function countOtherActiveAdmins(
  supabaseAdmin: ReturnType<typeof createClient>,
  companyId: string,
  excludedUserId: string,
) {
  const { data: adminRoles, error: adminRolesError } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("role", "admin");

  if (adminRolesError) throw new Error(adminRolesError.message);

  const adminIds = [...new Set(
    (adminRoles ?? [])
      .map((row: any) => row.user_id as string)
      .filter((userId: string) => userId !== excludedUserId),
  )];

  if (adminIds.length === 0) return 0;

  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("id, is_active")
    .in("id", adminIds);

  if (profilesError) throw new Error(profilesError.message);

  return (profiles ?? []).filter((profile: any) => profile.is_active !== false).length;
}

async function ensureCompanyRetainsActiveAdmin(
  supabaseAdmin: ReturnType<typeof createClient>,
  companyId: string | null,
  userId: string,
) {
  if (!companyId) return;

  const otherActiveAdmins = await countOtherActiveAdmins(supabaseAdmin, companyId, userId);
  if (otherActiveAdmins === 0) {
    throw new Error("Cada empresa precisa ter pelo menos um admin ativo");
  }
}

async function writeAuditLog(
  supabaseAdmin: ReturnType<typeof createClient>,
  callerId: string,
  action: string,
  userId: string,
  details: Record<string, unknown>,
) {
  await supabaseAdmin.from("audit_logs").insert({
    user_id: callerId,
    action,
    entity_type: "user",
    entity_id: userId,
    details,
  });
}

async function rollbackCreatedUser(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("Failed to rollback created user", error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const context = await verifyCaller(req);
    const body = await req.json();
    const { action } = body;
    const scopeCompanyId = normalizeOptionalCompanyId(body.scope_company_id);
    const impersonatedBySuperadmin = context.isSuperadmin && body.impersonated_by_superadmin === true;
    const impersonationEffectiveRole = impersonatedBySuperadmin
      ? normalizeEffectiveRole(body.effective_role)
      : null;

    if (impersonatedBySuperadmin && scopeCompanyId && impersonationEffectiveRole !== "admin") {
      throw new Error("Operadores impersonados nao podem gerenciar usuarios");
    }

    switch (action) {
      case "list_users": {
        assertCallerCanManageUsers(context);

        const requestedCompanyId = normalizeOptionalCompanyId(body.company_id);
        const listCompanyId = requestedCompanyId ?? scopeCompanyId;
        assertCallerCanAccessCompany(context, listCompanyId, scopeCompanyId);

        const shouldListAllUsers = context.isSuperadmin && !listCompanyId && !scopeCompanyId;
        const allowedCompanyIds = getAllowedCompanyIds(context, scopeCompanyId);

        let rolesQuery = context.supabaseAdmin
          .from("user_roles")
          .select("user_id, role, company_id");

        if (!shouldListAllUsers) {
          if (listCompanyId) {
            rolesQuery = rolesQuery.eq("company_id", listCompanyId);
          } else if (allowedCompanyIds && allowedCompanyIds.length > 0) {
            rolesQuery = rolesQuery.in("company_id", allowedCompanyIds);
          }
        }

        const rolesResult = await rolesQuery;
        if (rolesResult.error) throw new Error(rolesResult.error.message);

        const roles = (rolesResult.data ?? []) as UserRoleRow[];
        const roleMap = roles.reduce((acc, role) => {
          if (!acc.has(role.user_id)) acc.set(role.user_id, []);
          acc.get(role.user_id)!.push(role);
          return acc;
        }, new Map<string, UserRoleRow[]>());

        let userIds = [...new Set(roles.map((role) => role.user_id))];

        if (!shouldListAllUsers) {
          userIds = userIds.filter((userId) => {
            const userRoles = roleMap.get(userId) ?? [];

            if (userRoles.some((role) => role.role === "superadmin")) {
              return false;
            }

            if (listCompanyId) {
              return userRoles.some((role) => role.company_id === listCompanyId);
            }

            if (allowedCompanyIds && allowedCompanyIds.length > 0) {
              return userRoles.some((role) => role.company_id && allowedCompanyIds.includes(role.company_id));
            }

            return false;
          });
        }

        let profiles: ProfileRow[] = [];
        if (userIds.length > 0) {
          const profilesResult = await context.supabaseAdmin
            .from("profiles")
            .select("id, full_name, email, phone, company_id, is_active, created_at")
            .in("id", userIds);

          if (profilesResult.error) throw new Error(profilesResult.error.message);
          profiles = (profilesResult.data ?? []) as ProfileRow[];
        }

        const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

        const users = userIds
          .map((uid) => {
            const profile = profileMap.get(uid) ?? null;
            const userRoles = roleMap.get(uid) ?? [];
            const managedRole = getManagedRole(userRoles);

            return {
              id: uid,
              full_name: profile?.full_name || "",
              email: profile?.email || "",
              phone: profile?.phone || "",
              company_id: managedRole?.company_id ?? profile?.company_id ?? null,
              roles: [...new Set(userRoles.map((role) => role.role))],
              is_banned: profile?.is_active === false,
              last_sign_in: null,
              created_at: profile?.created_at || "",
            };
          })
          .filter((user) => user.roles.length > 0)
          .sort((userA, userB) => {
            const nameA = (userA.full_name || userA.email || "").toLowerCase();
            const nameB = (userB.full_name || userB.email || "").toLowerCase();
            return nameA.localeCompare(nameB);
          });

        return new Response(JSON.stringify({ users }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "toggle_ban": {
        assertCallerCanManageUsers(context);

        const { user_id, ban } = body;
        if (!user_id) throw new Error("user_id e obrigatorio");

        const { roles, profile } = await getUserContext(context.supabaseAdmin, user_id);
        await assertCallerCanManageTarget(context, roles, profile, undefined, scopeCompanyId);

        const managedRole = getManagedRole(roles);
        if (ban && profile?.is_active !== false && managedRole?.role === "admin") {
          await ensureCompanyRetainsActiveAdmin(context.supabaseAdmin, managedRole.company_id, user_id);
        }

        const { error } = await context.supabaseAdmin.auth.admin.updateUserById(user_id, {
          ban_duration: ban ? "876000h" : "none",
        });
        if (error) throw new Error(error.message);

        const { error: profileError } = await context.supabaseAdmin
          .from("profiles")
          .update({
            is_active: !ban,
            updated_at: new Date().toISOString(),
          })
          .eq("id", user_id);

        if (profileError) throw new Error(profileError.message);

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          ban ? "block_user" : "unblock_user",
          user_id,
          withImpersonationAuditDetails(
            {
              target_user_id: user_id,
              target_name: profile?.full_name ?? null,
              target_email: profile?.email ?? null,
              company_id: managedRole?.company_id ?? profile?.company_id ?? null,
              role: managedRole?.role ?? null,
              is_active: !ban,
            },
            scopeCompanyId,
            impersonatedBySuperadmin,
            impersonationEffectiveRole,
          ),
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "update_user": {
        assertCallerCanManageUsers(context);

        const { user_id, full_name, email, phone, company_id, role } = body;
        if (!user_id) throw new Error("user_id e obrigatorio");

        const normalizedFullName = full_name !== undefined ? normalizeFullNameValue(full_name) : undefined;
        const normalizedEmail = email !== undefined ? normalizeEmailValue(email) : undefined;
        const normalizedPhone = phone !== undefined ? normalizePhoneValue(phone) : undefined;

        if (full_name !== undefined && !normalizedFullName) {
          throw new Error("Informe um nome");
        }

        if (email !== undefined) {
          if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
            throw new Error("Informe um email valido");
          }
        }

        if (normalizedPhone && !isValidBrazilPhone(normalizedPhone)) {
          throw new Error("Informe um telefone valido com DDD");
        }

        const { roles, profile } = await getUserContext(context.supabaseAdmin, user_id);
        await assertCallerCanManageTarget(context, roles, profile, company_id, scopeCompanyId);

        const currentRole = getManagedRole(roles);
        const currentCompanyId = currentRole?.company_id ?? profile?.company_id ?? null;
        const nextRole = role ?? currentRole?.role ?? "operator";
        const nextCompanyId = company_id !== undefined ? (company_id || null) : currentCompanyId;

        if (role === "superadmin") {
          throw new Error("Este fluxo nao gerencia superadmins");
        }

        if (!context.isSuperadmin && company_id !== undefined && nextCompanyId !== currentCompanyId) {
          throw new Error("Admins so podem manter usuarios na propria empresa");
        }

        if ((nextRole === "admin" || nextRole === "operator") && !nextCompanyId) {
          throw new Error("Admins e operadores precisam estar vinculados a uma empresa");
        }

        if (profile?.is_active !== false && currentRole?.role === "admin" && (
          nextRole !== "admin" || nextCompanyId !== currentCompanyId
        )) {
          await ensureCompanyRetainsActiveAdmin(context.supabaseAdmin, currentCompanyId, user_id);
        }

        await syncProfileAndAuth(
          context.supabaseAdmin,
          user_id,
          profile,
          {
            full_name: normalizedFullName,
            email: normalizedEmail,
            phone: normalizedPhone,
            company_id: company_id !== undefined ? nextCompanyId : undefined,
          },
        );

        if (role !== undefined) {
          const { error: deleteRolesError } = await context.supabaseAdmin
            .from("user_roles")
            .delete()
            .eq("user_id", user_id)
            .in("role", ["admin", "operator"]);

          if (deleteRolesError) throw new Error(deleteRolesError.message);

          const { error: insertRoleError } = await context.supabaseAdmin
            .from("user_roles")
            .insert({
              user_id,
              role: nextRole,
              company_id: nextCompanyId,
            });

          if (insertRoleError) throw new Error(insertRoleError.message);
        } else if (company_id !== undefined) {
          const { error: companyRolesError } = await context.supabaseAdmin
            .from("user_roles")
            .update({ company_id: nextCompanyId })
            .eq("user_id", user_id)
            .in("role", ["admin", "operator"]);

          if (companyRolesError) throw new Error(companyRolesError.message);
        }

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          "update_user",
          user_id,
          withImpersonationAuditDetails(
            {
              target_user_id: user_id,
              target_name: normalizedFullName ?? profile?.full_name ?? null,
              target_email: normalizedEmail ?? profile?.email ?? null,
              previous_company_id: currentCompanyId,
              company_id: nextCompanyId,
              role: nextRole,
              phone: normalizedPhone ?? profile?.phone ?? null,
            },
            scopeCompanyId,
            impersonatedBySuperadmin,
            impersonationEffectiveRole,
          ),
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "reset_password": {
        assertCallerCanManageUsers(context);

        const { user_id } = body;
        if (!user_id) throw new Error("user_id e obrigatorio");

        const { roles, profile } = await getUserContext(context.supabaseAdmin, user_id);
        await assertCallerCanManageTarget(context, roles, profile, undefined, scopeCompanyId);

        const { data: { user } } = await context.supabaseAdmin.auth.admin.getUserById(user_id);
        if (!user?.email) throw new Error("Usuario nao encontrado");

        const accessLink = await generateRecoveryAccessLink(context.supabaseAdmin, req, user.email);

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          "reset_password",
          user_id,
          withImpersonationAuditDetails(
            {
              target_user_id: user_id,
              target_name: profile?.full_name ?? null,
              target_email: user.email,
              company_id: getManagedRole(roles)?.company_id ?? profile?.company_id ?? null,
            },
            scopeCompanyId,
            impersonatedBySuperadmin,
            impersonationEffectiveRole,
          ),
        );

        return new Response(
          JSON.stringify({ success: true, email: user.email, access_link: accessLink }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      case "set_user_password": {
        assertCallerCanManageUsers(context);

        const { user_id, password } = body;
        if (!user_id) throw new Error("user_id e obrigatorio");

        const normalizedPassword = normalizePasswordValue(password);
        if (!normalizedPassword || !isStrongPassword(normalizedPassword)) {
          throw new Error(PASSWORD_REQUIREMENTS_ERROR);
        }

        const { roles, profile } = await getUserContext(context.supabaseAdmin, user_id);
        await assertCallerCanManageTarget(context, roles, profile, undefined, scopeCompanyId);

        const { error: passwordError } = await context.supabaseAdmin.auth.admin.updateUserById(user_id, {
          password: normalizedPassword,
          email_confirm: true,
        });
        if (passwordError) throw new Error(normalizePasswordErrorMessage(passwordError.message));

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          "set_user_password",
          user_id,
          withImpersonationAuditDetails(
            {
              target_user_id: user_id,
              target_name: profile?.full_name ?? null,
              target_email: profile?.email ?? null,
              company_id: getManagedRole(roles)?.company_id ?? profile?.company_id ?? null,
            },
            scopeCompanyId,
            impersonatedBySuperadmin,
            impersonationEffectiveRole,
          ),
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "update_my_account": {
        const { full_name, email, password } = body;

        const normalizedFullName = full_name !== undefined ? normalizeFullNameValue(full_name) : undefined;
        const normalizedEmail = email !== undefined ? normalizeEmailValue(email) : undefined;
        const normalizedPassword = password !== undefined ? normalizePasswordValue(password) : undefined;

        if (full_name !== undefined && !normalizedFullName) {
          throw new Error("Informe um nome");
        }

        if (email !== undefined) {
          if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
            throw new Error("Informe um email valido");
          }
        }

        if (password !== undefined) {
          if (!normalizedPassword || !isStrongPassword(normalizedPassword)) {
            throw new Error(PASSWORD_REQUIREMENTS_ERROR);
          }
        }

        if (full_name === undefined && email === undefined && password === undefined) {
          throw new Error("Nenhum dado foi informado para atualizacao");
        }

        const { profile } = await getUserContext(context.supabaseAdmin, context.callerId);
        if (!profile) {
          throw new Error("Usuario nao encontrado");
        }

        await syncProfileAndAuth(
          context.supabaseAdmin,
          context.callerId,
          profile,
          {
            full_name: normalizedFullName,
            email: normalizedEmail,
            password: normalizedPassword ?? undefined,
          },
        );

        const emailChanged = normalizedEmail !== undefined && normalizedEmail !== (profile.email ?? null);
        const passwordChanged = normalizedPassword !== undefined;
        const auditAction = passwordChanged && full_name === undefined && email === undefined
          ? "change_own_password"
          : "update_own_profile";

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          auditAction,
          context.callerId,
          {
            target_user_id: context.callerId,
            target_name: normalizedFullName ?? profile.full_name ?? null,
            target_email: normalizedEmail ?? profile.email ?? null,
            email_changed: emailChanged,
            password_changed: passwordChanged,
          },
        );

        return new Response(JSON.stringify({
          success: true,
          email_changed: emailChanged,
          password_changed: passwordChanged,
          requires_reauth: emailChanged || passwordChanged,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "delete_user": {
        assertCallerCanManageUsers(context);

        const { user_id } = body;
        if (!user_id) throw new Error("user_id e obrigatorio");

        const { roles, profile } = await getUserContext(context.supabaseAdmin, user_id);
        await assertCallerCanManageTarget(context, roles, profile, undefined, scopeCompanyId);

        if (roles.some((role) => role.role === "superadmin")) {
          throw new Error("Este fluxo nao exclui superadmins");
        }

        const managedRole = getManagedRole(roles);
        if (profile?.is_active !== false && managedRole?.role === "admin") {
          await ensureCompanyRetainsActiveAdmin(context.supabaseAdmin, managedRole.company_id, user_id);
        }

        const { error: deleteError } = await context.supabaseAdmin.auth.admin.deleteUser(user_id);
        if (deleteError) throw new Error(deleteError.message);

        await writeAuditLog(
          context.supabaseAdmin,
          context.callerId,
          "delete_user",
          user_id,
          withImpersonationAuditDetails(
            {
              target_user_id: user_id,
              target_name: profile?.full_name ?? null,
              target_email: profile?.email ?? null,
              company_id: managedRole?.company_id ?? profile?.company_id ?? null,
              role: managedRole?.role ?? null,
            },
            scopeCompanyId,
            impersonatedBySuperadmin,
            impersonationEffectiveRole,
          ),
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "seed_users": {
        assertCallerCanManageUsers(context);

        const { users: seedUsers } = body;
        if (!seedUsers || !Array.isArray(seedUsers)) throw new Error("users array required");

        const results = [];

        for (const userPayload of seedUsers) {
          const normalizedEmail = normalizeEmailValue(userPayload.email);
          const normalizedPhone = normalizePhoneValue(userPayload.phone);
          const normalizedPassword = normalizePasswordValue(userPayload.password);

          if (!userPayload.company_id) {
            results.push({ email: userPayload.email, error: "company_id e obrigatorio" });
            continue;
          }

          if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
            results.push({ email: userPayload.email, error: "Informe um email valido" });
            continue;
          }

          if (normalizedPhone && !isValidBrazilPhone(normalizedPhone)) {
            results.push({ email: normalizedEmail, error: "Informe um telefone valido com DDD" });
            continue;
          }

          if (normalizedPassword && !isStrongPassword(normalizedPassword)) {
            results.push({ email: normalizedEmail, error: PASSWORD_REQUIREMENTS_ERROR });
            continue;
          }

          try {
            assertCallerCanAccessCompany(context, userPayload.company_id, scopeCompanyId);
          } catch (error: any) {
            results.push({ email: userPayload.email, error: error.message });
            continue;
          }

          if (!context.isSuperadmin && !context.adminCompanyIds.includes(userPayload.company_id)) {
            results.push({ email: userPayload.email, error: "Admins so podem criar usuarios na propria empresa" });
            continue;
          }

          if (userPayload.role === "superadmin") {
            results.push({ email: userPayload.email, error: "Este fluxo nao cria superadmins" });
            continue;
          }

          const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
          const initialPassword = normalizedPassword ?? tempPassword;
          const { data: newUser, error: userError } = await context.supabaseAdmin.auth.admin.createUser({
            email: normalizedEmail,
            password: initialPassword,
            email_confirm: true,
            user_metadata: { full_name: userPayload.full_name },
          });

          if (userError) {
            results.push({ email: normalizedEmail, error: normalizePasswordErrorMessage(userError.message) });
            continue;
          }

          const { error: profileError } = await context.supabaseAdmin
            .from("profiles")
            .update({
              company_id: userPayload.company_id,
              phone: normalizedPhone,
              full_name: userPayload.full_name,
              is_active: true,
            })
            .eq("id", newUser.user.id);

          if (profileError) {
            await rollbackCreatedUser(context.supabaseAdmin, newUser.user.id);
            results.push({ email: normalizedEmail, error: profileError.message });
            continue;
          }

          const { error: roleError } = await context.supabaseAdmin
            .from("user_roles")
            .insert({
              user_id: newUser.user.id,
              role: userPayload.role || "admin",
              company_id: userPayload.company_id,
            });

          if (roleError) {
            await rollbackCreatedUser(context.supabaseAdmin, newUser.user.id);
            results.push({ email: normalizedEmail, error: roleError.message });
            continue;
          }

          try {
            await writeAuditLog(
              context.supabaseAdmin,
              context.callerId,
              "create_user",
              newUser.user.id,
              withImpersonationAuditDetails(
                {
                  target_user_id: newUser.user.id,
                  target_name: userPayload.full_name,
                  email: normalizedEmail,
                  role: userPayload.role || "admin",
                  company_id: userPayload.company_id,
                },
                scopeCompanyId,
                impersonatedBySuperadmin,
                impersonationEffectiveRole,
              ),
            );
          } catch (auditError) {
            console.error("Failed to audit create_user", auditError);
          }

          let accessLink: string | null = null;
          let warning: string | null = null;

          if (!normalizedPassword) {
            try {
              accessLink = await generateRecoveryAccessLink(context.supabaseAdmin, req, normalizedEmail);
            } catch (linkError: any) {
              warning = `Usuario criado, mas o link de acesso nao foi gerado automaticamente: ${linkError.message}`;
            }
          }

          results.push({
            email: normalizedEmail,
            id: newUser.user.id,
            access_link: accessLink,
            warning,
          });
        }

        return new Response(JSON.stringify({ results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: "Acao invalida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (err: any) {
    const message = err.message || "Erro interno";
    const status = message.includes("Nao autorizado") ? 401
      : message.includes("Apenas admins e superadmins") ? 403
      : message.includes("Admins nao podem") || message.includes("Admins so podem") ? 403
      : message.includes("Este fluxo nao exclui superadmins") ? 403
      : message.includes("Informe um") || message.includes("A senha deve") || message.includes("Nenhum dado foi informado") ? 400
      : message.includes("Cada empresa precisa") ? 409
      : 500;

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
