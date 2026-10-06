// Pure authorization rules shared by the Edge Functions and their local tests.
export type SupportImpersonationContext = {
  id: string;
  actorUserId: string;
  companyId: string;
  userId: string;
  effectiveRole: "admin" | "operator";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeSupportCompanyIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => !isUuid(id))) {
    throw new Error("support_company_ids deve ser uma lista de IDs de empresas validos");
  }
  return [...new Set(value)];
}

export function validateSupportImpersonationContext(
  value: unknown,
  actorUserId: string,
  sessionId: string,
): SupportImpersonationContext {
  const context = value as Partial<SupportImpersonationContext> | null;
  if (!context || !isUuid(context.id) || context.id !== sessionId
    || context.actorUserId !== actorUserId || !isUuid(context.userId)
    || !isUuid(context.companyId)
    || (context.effectiveRole !== "admin" && context.effectiveRole !== "operator")) {
    throw new Error("Sem permissao: sessao de suporte invalida ou expirada");
  }
  return context as SupportImpersonationContext;
}

export function assertAssignableManagedRole(role: unknown, isGlobalSuperadmin: boolean) {
  if (role === "support") {
    if (!isGlobalSuperadmin) throw new Error("Sem permissao: apenas superadmins podem gerenciar suporte");
    return;
  }
  if (role !== "admin" && role !== "operator") {
    throw new Error("Perfil invalido: use admin, operator ou support");
  }
}

export function assertSupportCompanyMatches(
  impersonation: SupportImpersonationContext | null,
  companyId: string,
  allowedRoles: readonly string[],
) {
  if (impersonation && (impersonation.companyId !== companyId
    || !allowedRoles.includes(impersonation.effectiveRole))) {
    throw new Error("Sem permissao para esta empresa ou acao na sessao de suporte");
  }
}
