import {
  assertSuperadmin,
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  getClientIpAddress,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";
import {
  getPlatformAsaasCustomer,
  listPlatformAsaasCustomers,
  listAllPlatformAsaasCustomerPayments,
  loadStoredPlatformBillingConfig,
  normalizeAsaasCustomerId,
  paymentDescriptionContainsMarker,
  platformBillingCorsHeaders,
  platformBillingJsonResponse,
  PlatformAsaasApiError,
  readPlatformBillingJson,
  safePlatformBillingError,
  toCompanyBillingInvoiceRow,
} from "../_shared/platform-billing.ts";

const LINK_COLUMNS = [
  "company_id",
  "asaas_customer_id",
  "customer_name",
  "customer_cpf_cnpj",
  "description_marker",
  "billing_enabled",
  "billing_revision",
  "billing_enabled_at",
  "status",
  "last_validated_at",
  "last_sync_attempt_at",
  "last_synced_at",
  "last_sync_error",
  "last_fetched_count",
  "last_matched_count",
  "last_ignored_count",
  "created_at",
  "updated_at",
].join(", ");

const INTERNAL_LINK_COLUMNS =
  `${LINK_COLUMNS}, link_revision, sync_attempt_revision, created_by, updated_by, billing_enabled_by`;

const INVOICE_COLUMNS = [
  "id",
  "company_id",
  "asaas_payment_id",
  "asaas_customer_id",
  "asaas_subscription_id",
  "description",
  "status",
  "value",
  "due_date",
  "payment_date",
  "billing_type",
  "invoice_url",
  "bank_slip_url",
  "external_reference",
  "asaas_created_at",
  "last_synced_at",
  "created_at",
  "updated_at",
].join(", ");

const OPEN_STATUSES = new Set([
  "PENDING",
  "OVERDUE",
  "DUNNING_REQUESTED",
  "AWAITING_RISK_ANALYSIS",
]);

const DEFAULT_MARKER = "[PLUGUEGUEST]";
const ADMIN_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

class SyncCooldownError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Aguarde ${retryAfterSeconds} segundos antes de sincronizar novamente`);
    this.name = "SyncCooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class StaleBillingSnapshotError extends Error {
  constructor() {
    super("A configuracao financeira mudou durante a operacao; recarregue e tente novamente");
    this.name = "StaleBillingSnapshotError";
  }
}

function normalizeCompanyId(value: unknown) {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new Error("Empresa invalida");
  }
  return companyId;
}

function normalizeRevision(value: unknown, label: string) {
  const revision = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision)) {
    throw new Error(`${label} invalida`);
  }
  return revision;
}

function normalizeMarker(value: unknown) {
  const marker = typeof value === "string" ? value.trim() : DEFAULT_MARKER;
  if (marker !== DEFAULT_MARKER) {
    throw new Error(`O marcador deve ser exatamente ${DEFAULT_MARKER}`);
  }
  return DEFAULT_MARKER;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicCustomer(
  customer: any,
  linkedCompany: { company_id?: unknown; billing_enabled?: unknown } | null = null,
) {
  return {
    id: customer.id,
    name: nullableString(customer.name) ?? "Cliente Asaas",
    cpf_cnpj: nullableString(customer.cpfCnpj),
    email: nullableString(customer.email),
    mobile_phone: nullableString(customer.mobilePhone ?? customer.phone),
    external_reference: nullableString(customer.externalReference),
    linked_company_id: nullableString(linkedCompany?.company_id),
    billing_enabled: linkedCompany?.billing_enabled === true,
  };
}

type CustomerSearchFilter = "auto" | "id" | "name" | "email" | "cpf_cnpj" | "external_reference";

function normalizeCustomerSearchFilter(value: unknown): CustomerSearchFilter {
  if (value === undefined || value === null || value === "") return "auto";
  if (
    value === "auto"
    || value === "id"
    || value === "name"
    || value === "email"
    || value === "cpf_cnpj"
    || value === "external_reference"
  ) return value;
  throw new Error("Filtro de clientes Asaas invalido");
}

function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Paginacao de clientes Asaas invalida");
  }
  return parsed;
}

function normalizeCustomerSearch(value: unknown) {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length > 120) throw new Error("Busca de cliente Asaas excede 120 caracteres");
  return query;
}

function resolveCustomerSearch(
  query: string,
  requestedFilter: CustomerSearchFilter,
): {
  filter: Exclude<CustomerSearchFilter, "auto"> | "all";
  providerFilters: {
    name?: string;
    email?: string;
    cpfCnpj?: string;
    externalReference?: string;
  };
} {
  if (!query) return { filter: "all", providerFilters: {} };

  let filter: Exclude<CustomerSearchFilter, "auto">;
  if (requestedFilter !== "auto") {
    filter = requestedFilter;
  } else if (/^cus_[A-Za-z0-9_-]+$/i.test(query)) {
    filter = "id";
  } else if (query.includes("@")) {
    filter = "email";
  } else {
    const digits = query.replace(/\D/g, "");
    filter = (digits.length === 11 || digits.length === 14) ? "cpf_cnpj" : "name";
  }

  if (filter !== "id" && query.length < 2) {
    throw new Error("Digite ao menos 2 caracteres para buscar um cliente Asaas");
  }

  if (filter === "id") return { filter, providerFilters: {} };
  if (filter === "email") return { filter, providerFilters: { email: query } };
  if (filter === "cpf_cnpj") {
    const digits = query.replace(/\D/g, "");
    if (digits.length !== 11 && digits.length !== 14) {
      throw new Error("CPF ou CNPJ invalido para busca no Asaas");
    }
    return { filter, providerFilters: { cpfCnpj: digits } };
  }
  if (filter === "external_reference") {
    return { filter, providerFilters: { externalReference: query } };
  }
  return { filter, providerFilters: { name: query } };
}

async function auditBillingAction(
  supabaseAdmin: any,
  req: Request,
  userId: string,
  action: string,
  companyId: string | null,
  details: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin.from("audit_logs").insert({
    user_id: userId,
    action,
    entity_type: "company_billing",
    entity_id: companyId,
    details,
    ip_address: getClientIpAddress(req),
  });

  if (error) console.warn("Failed to audit platform billing action", error);
}

async function loadLink(supabaseAdmin: any, companyId: string, internal = false) {
  const { data, error } = await supabaseAdmin
    .from("company_billing_links")
    .select(internal ? INTERNAL_LINK_COLUMNS : LINK_COLUMNS)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as Record<string, any> | null;
}

async function loadCustomerLinkMap(supabaseAdmin: any, customerIds: string[]) {
  const uniqueIds = [...new Set(customerIds.filter(Boolean))];
  const linksByCustomer = new Map<string, Record<string, unknown>>();
  if (uniqueIds.length === 0) return linksByCustomer;

  const { data, error } = await supabaseAdmin
    .from("company_billing_links")
    .select("asaas_customer_id, company_id, billing_enabled")
    .in("asaas_customer_id", uniqueIds);
  if (error) throw new Error(error.message);

  for (const link of data ?? []) {
    if (typeof link.asaas_customer_id === "string") {
      linksByCustomer.set(link.asaas_customer_id, link);
    }
  }
  return linksByCustomer;
}

async function loadModuleEnabled(supabaseAdmin: any) {
  const { data, error } = await supabaseAdmin
    .from("platform_billing_config")
    .select("module_enabled, api_token_encrypted, token_validated_at, token_last_error")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.module_enabled === true
    && Boolean(data?.api_token_encrypted)
    && Boolean(data?.token_validated_at)
    && !data?.token_last_error;
}

async function loadAllCompanyInvoices(supabaseAdmin: any, companyId: string) {
  const pageSize = 1000;
  const rows: Array<Record<string, any>> = [];

  for (let from = 0; from < 10000; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("company_billing_invoices")
      .select(INVOICE_COLUMNS)
      .eq("company_id", companyId)
      .order("due_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);

    const page = (data ?? []) as Array<Record<string, any>>;
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }

  throw new Error("Cache financeiro excedeu 10.000 cobrancas para uma empresa");
}

function dateOnlyInFortaleza() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysBetweenDateOnly(later: string, earlier: string) {
  const laterMs = Date.parse(`${later}T00:00:00Z`);
  const earlierMs = Date.parse(`${earlier}T00:00:00Z`);
  if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
  return Math.max(0, Math.floor((laterMs - earlierMs) / 86400000));
}

function calculateSummary(
  globalModuleEnabled: boolean,
  link: Record<string, any> | null,
  invoices: Array<Record<string, any>>,
) {
  const today = dateOnlyInFortaleza();
  const openInvoices = invoices.filter((invoice) =>
    OPEN_STATUSES.has(String(invoice.status || "").toUpperCase())
  );
  const overdueInvoices = openInvoices.filter((invoice) =>
    typeof invoice.due_date === "string" && invoice.due_date < today
  );
  const futureInvoices = openInvoices.filter((invoice) =>
    typeof invoice.due_date === "string" && invoice.due_date >= today
  ).sort((left, right) => String(left.due_date).localeCompare(String(right.due_date)));

  const oldestOverdueDueDate = overdueInvoices
    .map((invoice) => String(invoice.due_date))
    .sort()[0] ?? null;
  const oldestOverdueDays = oldestOverdueDueDate
    ? daysBetweenDateOnly(today, oldestOverdueDueDate)
    : null;
  const nextDueDate = futureInvoices[0]?.due_date ?? null;
  const nextDueAmount = nextDueDate
    ? futureInvoices
      .filter((invoice) => invoice.due_date === nextDueDate)
      .reduce((sum, invoice) => sum + Number(invoice.value || 0), 0)
    : 0;

  return {
    module_enabled: globalModuleEnabled && link?.billing_enabled === true,
    company_billing_enabled: link?.billing_enabled === true,
    link_status: link?.status ?? "not_configured",
    has_link: Boolean(link),
    last_synced_at: link?.last_synced_at ?? null,
    last_sync_error: link?.last_sync_error ?? null,
    open_count: openInvoices.length,
    open_amount: openInvoices.reduce((sum, invoice) => sum + Number(invoice.value || 0), 0),
    overdue_count: overdueInvoices.length,
    overdue_amount: overdueInvoices.reduce((sum, invoice) => sum + Number(invoice.value || 0), 0),
    oldest_overdue_due_date: oldestOverdueDueDate,
    oldest_overdue_days: oldestOverdueDays,
    next_due_date: nextDueDate,
    next_due_amount: nextDueAmount,
    show_overdue_popup: typeof oldestOverdueDays === "number" && oldestOverdueDays >= 6,
  };
}

async function markSyncAttempt(
  supabaseAdmin: any,
  link: Record<string, any>,
  sourceRevision: string,
  options: { bypassCooldown: boolean; allowPendingValidation: boolean },
) {
  const attemptRevision = crypto.randomUUID();
  const { data, error } = await supabaseAdmin.rpc(
    "claim_company_billing_sync_attempt",
    {
      _company_id: link.company_id,
      _asaas_customer_id: link.asaas_customer_id,
      _source_revision: sourceRevision,
      _link_revision: link.link_revision,
      _sync_attempt_revision: attemptRevision,
      _attempted_at: new Date().toISOString(),
      _bypass_cooldown: options.bypassCooldown,
      _allow_pending_validation: options.allowPendingValidation,
      _cooldown_seconds: Math.floor(ADMIN_SYNC_COOLDOWN_MS / 1000),
    },
  );
  if (error) {
    const message = safePlatformBillingError(error);
    if (message.includes("revision changed")) throw new StaleBillingSnapshotError();
    throw new Error(message);
  }

  const claim = (data && typeof data === "object")
    ? data as Record<string, unknown>
    : {};
  if (claim.claimed !== true) {
    const retryAfterSeconds = Number(claim.retry_after_seconds ?? 1);
    throw new SyncCooldownError(
      Number.isFinite(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) : 1,
    );
  }
  return attemptRevision;
}

async function markSyncFailure(
  supabaseAdmin: any,
  link: Record<string, any>,
  sourceRevision: string,
  syncAttemptRevision: string,
  error: unknown,
) {
  const now = new Date().toISOString();
  const message = safePlatformBillingError(error);
  const { error: updateError } = await supabaseAdmin.rpc(
    "mark_company_billing_sync_failure",
    {
      _company_id: link.company_id,
      _asaas_customer_id: link.asaas_customer_id,
      _source_revision: sourceRevision,
      _link_revision: link.link_revision,
      _sync_attempt_revision: syncAttemptRevision,
      _attempted_at: now,
      _error_message: message,
    },
  );
  if (updateError) console.error("Failed to persist fenced platform billing sync error", updateError);
}

async function disableModuleForProviderAuthFailure(
  supabaseAdmin: any,
  link: Record<string, any>,
  sourceRevision: string,
  syncAttemptRevision: string,
  error: PlatformAsaasApiError,
) {
  const { error: disableError } = await supabaseAdmin.rpc(
    "record_platform_billing_auth_failure",
    {
      _company_id: link.company_id,
      _source_revision: sourceRevision,
      _link_revision: link.link_revision,
      _sync_attempt_revision: syncAttemptRevision,
      _failed_at: new Date().toISOString(),
      _error_message: safePlatformBillingError(error),
    },
  );
  if (disableError) {
    console.error("Failed to persist fenced platform Asaas authentication error", disableError);
  }
}

type SyncCompanyOptions = {
  bypassCooldown: boolean;
  allowPendingValidation: boolean;
  requireBillingEnabled: boolean;
  requireGlobalModuleEnabled: boolean;
  expectedSourceRevision?: string;
  expectedLinkRevision?: string;
  expectedCustomerId?: string;
};

async function syncCompanyInvoices(
  supabaseAdmin: any,
  companyId: string,
  options: SyncCompanyOptions,
) {
  const link = await loadLink(supabaseAdmin, companyId, true);
  if (!link) throw new Error("Vinculo financeiro nao configurado");
  if (options.requireBillingEnabled && link.billing_enabled !== true) {
    throw new Error("Financeiro ainda nao foi liberado para esta empresa");
  }
  if (link.status === "disabled") throw new Error("Vinculo financeiro desativado");
  if (link.status === "pending_validation" && !options.allowPendingValidation) {
    throw new Error("Vinculo financeiro requer revalidacao pelo superadmin");
  }

  const config = await loadStoredPlatformBillingConfig(supabaseAdmin);
  if (options.requireGlobalModuleEnabled && !config.moduleEnabled) {
    throw new Error("Modulo financeiro ainda nao esta habilitado");
  }
  if (
    (options.expectedSourceRevision
      && options.expectedSourceRevision !== config.sourceRevision)
    || (options.expectedLinkRevision
      && options.expectedLinkRevision !== link.link_revision)
    || (options.expectedCustomerId
      && options.expectedCustomerId !== link.asaas_customer_id)
  ) {
    throw new StaleBillingSnapshotError();
  }
  const syncAttemptRevision = await markSyncAttempt(
    supabaseAdmin,
    link,
    config.sourceRevision,
    options,
  );

  try {
    const customer = await getPlatformAsaasCustomer(
      config.apiToken,
      config.environment,
      link.asaas_customer_id,
    );
    const allPayments = await listAllPlatformAsaasCustomerPayments(
      config.apiToken,
      config.environment,
      link.asaas_customer_id,
    );

    const fetchedById = new Map<string, any>();
    for (const payment of allPayments) {
      fetchedById.set(payment.id.trim(), payment);
    }

    const matchingById = new Map<string, any>();
    for (const payment of fetchedById.values()) {
      if (
        paymentDescriptionContainsMarker(payment?.description, link.description_marker)
      ) {
        matchingById.set(payment.id.trim(), payment);
      }
    }

    const syncedAt = new Date().toISOString();
    const invoiceRows = [...matchingById.values()].map((payment) =>
      toCompanyBillingInvoiceRow(
        payment,
        companyId,
        link.asaas_customer_id,
        syncedAt,
      )
    );

    const { data: matchedCount, error: replaceError } = await supabaseAdmin.rpc(
      "replace_company_billing_invoice_cache",
      {
        _company_id: companyId,
        _asaas_customer_id: link.asaas_customer_id,
        _source_revision: config.sourceRevision,
        _link_revision: link.link_revision,
        _sync_attempt_revision: syncAttemptRevision,
        _customer_name: nullableString(customer.name),
        _customer_cpf_cnpj: nullableString(customer.cpfCnpj),
        _synced_at: syncedAt,
        _fetched_count: fetchedById.size,
        _rows: invoiceRows,
      },
    );
    if (replaceError) {
      const message = safePlatformBillingError(replaceError);
      if (message.includes("revision changed") || message.includes("superseded")) {
        throw new StaleBillingSnapshotError();
      }
      throw new Error(message);
    }

    return {
      company_id: companyId,
      fetched_count: fetchedById.size,
      matched_count: Number(matchedCount ?? invoiceRows.length),
      ignored_count: Math.max(fetchedById.size - invoiceRows.length, 0),
      last_synced_at: syncedAt,
    };
  } catch (error) {
    if (
      error instanceof PlatformAsaasApiError
      && (error.status === 401 || error.status === 403)
    ) {
      await disableModuleForProviderAuthFailure(
        supabaseAdmin,
        link,
        config.sourceRevision,
        syncAttemptRevision,
        error,
      );
    }
    await markSyncFailure(
      supabaseAdmin,
      link,
      config.sourceRevision,
      syncAttemptRevision,
      error,
    );
    throw error;
  }
}

async function getLinkResponse(supabaseAdmin: any, companyId: string, invoiceLimit = 100) {
  const [globalModuleEnabled, linkResult, allInvoices] = await Promise.all([
    loadModuleEnabled(supabaseAdmin),
    loadLink(supabaseAdmin, companyId),
    loadAllCompanyInvoices(supabaseAdmin, companyId),
  ]);

  return {
    module_enabled: globalModuleEnabled,
    company_billing_enabled: linkResult?.billing_enabled === true,
    effective_billing_enabled:
      globalModuleEnabled && linkResult?.billing_enabled === true,
    link: linkResult,
    summary: calculateSummary(globalModuleEnabled, linkResult, allInvoices),
    invoices: allInvoices.slice(0, invoiceLimit),
  };
}

function statusForError(error: unknown, message: string) {
  if (error instanceof SyncCooldownError) return 429;
  if (error instanceof StaleBillingSnapshotError) return 409;
  if (error instanceof PlatformAsaasApiError) {
    if (error.status === 404) return 404;
    if ([400, 401, 403, 422, 429].includes(error.status)) return 400;
    return 502;
  }
  if (message === "Nao autorizado") return 401;
  if (message.includes("Sem permissao")) return 403;
  if (
    message.includes("duplicate key")
    || message.includes("already linked")
    || message.includes("ja esta vinculado")
  ) return 409;
  if (message.includes("nao encontrado") || message.includes("nao configurado")) return 404;
  if (
    message.includes("requer revalidacao")
    || message.includes("requires superadmin revalidation")
    || message.includes("revision changed")
    || message.includes("superseded")
    || message.includes("ainda nao foi liberado")
    || message.includes("source is not configured or valid")
    || message.includes("link must be active and validated")
  ) return 409;
  if (
    message.includes("invalida")
    || message.includes("invalido")
    || message.includes("obrigatorio")
    || message.includes("desativado")
    || message.includes("is disabled")
    || message.includes("marcador deve ser")
    || message.includes("excede 120 caracteres")
    || message.includes("Digite ao menos")
    || message.includes("enabled state is required")
  ) return 400;
  if (message.includes("link not found")) return 404;
  return 500;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: platformBillingCorsHeaders });
  }
  if (req.method !== "POST") {
    return platformBillingJsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await readPlatformBillingJson(req);
    const action = typeof body.action === "string" ? body.action : "get_link";

    if (action === "sync_all") {
      const isJob = await isAuthorizedInternalJob(req);
      let caller: { supabaseAdmin: any; user: { id: string } } | null = null;
      if (!isJob) caller = await assertSuperadmin(req);
      const supabaseAdmin = caller?.supabaseAdmin ?? createSupabaseAdminClient();

      if (!(await loadModuleEnabled(supabaseAdmin))) {
        return platformBillingJsonResponse({
          ok: true,
          skipped: true,
          reason: "module_disabled",
          synced: 0,
          failed: 0,
          processed_count: 0,
          success_count: 0,
          error_count: 0,
          results: [],
        });
      }

      const { data: links, error: linksError } = await supabaseAdmin
        .from("company_billing_links")
        .select("company_id")
        .eq("billing_enabled", true)
        .in("status", ["active", "error"])
        .order("last_sync_attempt_at", { ascending: true, nullsFirst: true });
      if (linksError) throw new Error(linksError.message);

      const results: Array<Record<string, unknown>> = [];
      const allLinks = links ?? [];
      const concurrency = 4;
      let stoppedEarly = false;
      for (let index = 0; index < allLinks.length; index += concurrency) {
        if (index > 0 && !(await loadModuleEnabled(supabaseAdmin))) {
          stoppedEarly = true;
          break;
        }
        const batch = allLinks.slice(index, index + concurrency);
        const batchResults = await Promise.all(batch.map(async (link: any) => {
          try {
            const sync = await syncCompanyInvoices(supabaseAdmin, link.company_id, {
              bypassCooldown: true,
              allowPendingValidation: false,
              requireBillingEnabled: true,
              requireGlobalModuleEnabled: true,
            });
            return { ok: true, ...sync };
          } catch (error) {
            return {
              ok: false,
              company_id: link.company_id,
              error: safePlatformBillingError(error),
            };
          }
        }));
        results.push(...batchResults);
      }

      const successCount = results.filter((result) => result.ok === true).length;
      const remainingCount = Math.max(allLinks.length - results.length, 0);
      if (caller) {
        await auditBillingAction(
          supabaseAdmin,
          req,
          caller.user.id,
          "sync_all_platform_billing_invoices",
          null,
          {
            processed_count: results.length,
            success_count: successCount,
            error_count: results.length - successCount,
            stopped_early: stoppedEarly,
            remaining_count: remainingCount,
          },
        );
      }

      return platformBillingJsonResponse({
        ok: true,
        skipped: false,
        synced: successCount,
        failed: results.length - successCount,
        processed_count: results.length,
        success_count: successCount,
        error_count: results.length - successCount,
        stopped_early: stoppedEarly,
        remaining_count: remainingCount,
        stop_reason: stoppedEarly ? "module_disabled_during_sync" : null,
        results,
      });
    }

    if (action === "search_customers") {
      const { supabaseAdmin } = await assertSuperadmin(req);
      const query = normalizeCustomerSearch(body.query);
      const requestedFilter = normalizeCustomerSearchFilter(body.filter);
      const search = resolveCustomerSearch(query, requestedFilter);
      const offset = normalizeBoundedInteger(body.offset, 0, 0, 1_000_000);
      const limit = normalizeBoundedInteger(body.limit, 20, 1, 50);
      const config = await loadStoredPlatformBillingConfig(supabaseAdmin);

      let customers: any[];
      let hasMore: boolean;
      let totalCount: number | null;

      if (search.filter === "id") {
        if (offset !== 0) {
          customers = [];
          hasMore = false;
          totalCount = 1;
        } else {
          try {
            customers = [await getPlatformAsaasCustomer(
              config.apiToken,
              config.environment,
              normalizeAsaasCustomerId(query),
            )];
            hasMore = false;
            totalCount = 1;
          } catch (error) {
            if (error instanceof PlatformAsaasApiError && error.status === 404) {
              customers = [];
              hasMore = false;
              totalCount = 0;
            } else {
              throw error;
            }
          }
        }
      } else {
        const page = await listPlatformAsaasCustomers(
          config.apiToken,
          config.environment,
          {
            offset,
            limit,
            ...search.providerFilters,
          },
        );
        customers = page.customers;
        hasMore = page.hasMore;
        totalCount = page.totalCount;
      }

      const linksByCustomer = await loadCustomerLinkMap(
        supabaseAdmin,
        customers.map((customer) => String(customer.id ?? "")),
      );

      return platformBillingJsonResponse({
        ok: true,
        customers: customers.map((customer) =>
          publicCustomer(customer, linksByCustomer.get(customer.id) ?? null)
        ),
        pagination: {
          offset,
          limit,
          has_more: hasMore,
          total_count: totalCount,
        },
        search_filter: search.filter,
      });
    }

    if (action === "validate_customer") {
      const { supabaseAdmin } = await assertSuperadmin(req);
      const customerId = normalizeAsaasCustomerId(body.asaas_customer_id);
      const config = await loadStoredPlatformBillingConfig(supabaseAdmin);
      const customer = await getPlatformAsaasCustomer(
        config.apiToken,
        config.environment,
        customerId,
      );

      return platformBillingJsonResponse({ ok: true, customer: publicCustomer(customer) });
    }

    const companyId = normalizeCompanyId(body.company_id);

    if (action === "get_link") {
      const context = await assertUserCanAccessCompany(req, companyId, ["admin"]);
      if (!context.isSuperadmin) {
        if (!(await loadModuleEnabled(context.supabaseAdmin))) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Modulo financeiro ainda nao esta habilitado",
          }, 409);
        }
        const companyLink = await loadLink(context.supabaseAdmin, companyId);
        if (companyLink?.billing_enabled !== true) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Financeiro ainda nao foi liberado para esta empresa",
            company_billing_enabled: false,
          }, 409);
        }
      }
      const requestedLimit = Number(body.limit);
      const invoiceLimit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
        : 100;
      const payload = await getLinkResponse(context.supabaseAdmin, companyId, invoiceLimit);
      return platformBillingJsonResponse({ ok: true, ...payload });
    }

    if (action === "save_link") {
      const { supabaseAdmin, user } = await assertSuperadmin(req);
      const customerId = normalizeAsaasCustomerId(body.asaas_customer_id);
      const marker = normalizeMarker(body.description_marker);

      const { data: company, error: companyError } = await supabaseAdmin
        .from("companies")
        .select("id, name")
        .eq("id", companyId)
        .maybeSingle();
      if (companyError) throw new Error(companyError.message);
      if (!company) throw new Error("Empresa nao encontrada");

      const { data: duplicate, error: duplicateError } = await supabaseAdmin
        .from("company_billing_links")
        .select("company_id")
        .eq("asaas_customer_id", customerId)
        .neq("company_id", companyId)
        .maybeSingle();
      if (duplicateError) throw new Error(duplicateError.message);
      if (duplicate) throw new Error("Este Customer ID do Asaas ja esta vinculado a outra empresa");

      const config = await loadStoredPlatformBillingConfig(supabaseAdmin);
      const customer = await getPlatformAsaasCustomer(
        config.apiToken,
        config.environment,
        customerId,
      );
      const now = new Date().toISOString();
      const { data: linkMutation, error: linkError } = await supabaseAdmin.rpc(
        "save_company_billing_link",
        {
          _company_id: companyId,
          _asaas_customer_id: customerId,
          _customer_name: nullableString(customer.name),
          _customer_cpf_cnpj: nullableString(customer.cpfCnpj),
          _description_marker: marker,
          _expected_source_revision: config.sourceRevision,
          _actor_id: user.id,
          _validated_at: now,
        },
      );
      if (linkError) {
        const message = safePlatformBillingError(linkError);
        await auditBillingAction(
          supabaseAdmin,
          req,
          user.id,
          "save_company_billing_link",
          companyId,
          {
            success: false,
            requested_customer_id: customerId,
            source_revision_stale: message.includes("source revision changed"),
            error: message,
          },
        );
        throw new Error(message);
      }

      const mutation = (linkMutation && typeof linkMutation === "object")
        ? linkMutation as Record<string, unknown>
        : {};
      const relationshipChanged = mutation.relationship_changed === true;
      const purgedInvoiceCount = Number(mutation.purged_invoice_count ?? 0);
      const savedSourceRevision = typeof mutation.source_revision === "string"
        ? mutation.source_revision
        : config.sourceRevision;
      const savedLinkRevision = typeof mutation.link_revision === "string"
        ? mutation.link_revision
        : "";

      let sync: Record<string, unknown> | null = null;
      let warning: string | null = null;
      try {
        if (!savedLinkRevision) throw new StaleBillingSnapshotError();
        sync = await syncCompanyInvoices(supabaseAdmin, companyId, {
          bypassCooldown: true,
          allowPendingValidation: true,
          requireBillingEnabled: false,
          requireGlobalModuleEnabled: false,
          expectedSourceRevision: savedSourceRevision,
          expectedLinkRevision: savedLinkRevision,
          expectedCustomerId: customerId,
        });
      } catch (error) {
        warning = safePlatformBillingError(error);
      }

      await auditBillingAction(
        supabaseAdmin,
        req,
        user.id,
        "save_company_billing_link",
        companyId,
        {
          company_name: company.name,
          previous_customer_id: mutation.previous_customer_id ?? null,
          asaas_customer_id: customerId,
          previous_marker: mutation.previous_marker ?? null,
          description_marker: marker,
          relationship_changed: relationshipChanged,
          purged_cached_invoice_count: purgedInvoiceCount,
          initial_sync_succeeded: Boolean(sync),
          initial_sync_error: warning,
        },
      );

      return platformBillingJsonResponse({
        ok: true,
        ...(await getLinkResponse(supabaseAdmin, companyId)),
        customer: publicCustomer(customer),
        sync,
        warning,
      });
    }

    if (action === "set_company_enabled") {
      const { supabaseAdmin, user } = await assertSuperadmin(req);
      if (typeof body.enabled !== "boolean") {
        throw new Error("Estado de liberacao financeira invalido");
      }

      const currentLink = await loadLink(supabaseAdmin, companyId, true);
      if (!currentLink) throw new Error("Vinculo financeiro nao configurado");
      const expectedBillingRevision = body.expected_billing_revision === undefined
        ? normalizeRevision(currentLink.billing_revision, "Revisao financeira")
        : normalizeRevision(body.expected_billing_revision, "Revisao financeira");

      const { data: toggleData, error: toggleError } = await supabaseAdmin.rpc(
        "set_company_billing_enabled",
        {
          _company_id: companyId,
          _enabled: body.enabled,
          _expected_billing_revision: expectedBillingRevision,
          _actor_id: user.id,
          _changed_at: new Date().toISOString(),
        },
      );
      if (toggleError) {
        const message = safePlatformBillingError(toggleError);
        await auditBillingAction(
          supabaseAdmin,
          req,
          user.id,
          "set_company_billing_enabled",
          companyId,
          {
            success: false,
            requested_enabled: body.enabled,
            expected_billing_revision: expectedBillingRevision,
            stale_revision: message.includes("revision changed"),
            error: message,
          },
        );
        if (message.includes("revision changed")) throw new StaleBillingSnapshotError();
        throw new Error(message);
      }

      const toggle = toggleData && typeof toggleData === "object"
        ? toggleData as Record<string, unknown>
        : {};
      const updatedLink = await loadLink(supabaseAdmin, companyId);
      if (!updatedLink) throw new Error("Vinculo financeiro nao configurado");

      await auditBillingAction(
        supabaseAdmin,
        req,
        user.id,
        "set_company_billing_enabled",
        companyId,
        {
          success: true,
          previous_enabled: toggle.previous_enabled === true,
          billing_enabled: updatedLink.billing_enabled === true,
          automatic_sync_enabled: updatedLink.billing_enabled === true,
          customer_portal_enabled: updatedLink.billing_enabled === true,
          provider_resource_changed: false,
        },
      );

      return platformBillingJsonResponse({
        ok: true,
        previous_enabled: toggle.previous_enabled === true,
        link: updatedLink,
      });
    }

    if (action === "remove_link") {
      const { supabaseAdmin, user } = await assertSuperadmin(req);
      const [link, configResult] = await Promise.all([
        loadLink(supabaseAdmin, companyId, true),
        supabaseAdmin
          .from("platform_billing_config")
          .select("source_revision")
          .eq("id", true)
          .maybeSingle(),
      ]);
      if (configResult.error) throw new Error(configResult.error.message);
      if (!link) return platformBillingJsonResponse({ ok: true, removed: false });
      const sourceRevision = configResult.data?.source_revision;
      if (typeof sourceRevision !== "string" || !sourceRevision) {
        throw new Error("Revisao da fonte Asaas nao configurada");
      }

      const { data: removalData, error: removalError } = await supabaseAdmin.rpc(
        "remove_company_billing_link_cache",
        {
          _company_id: companyId,
          _expected_source_revision: sourceRevision,
          _expected_asaas_customer_id: link.asaas_customer_id,
          _expected_link_revision: link.link_revision,
        },
      );
      if (removalError) {
        const message = safePlatformBillingError(removalError);
        if (message.includes("revision changed")) throw new StaleBillingSnapshotError();
        throw new Error(message);
      }
      const removal = (removalData && typeof removalData === "object")
        ? removalData as Record<string, unknown>
        : {};
      const removed = removal.removed === true;
      if (!removed) return platformBillingJsonResponse({ ok: true, removed: false });

      await auditBillingAction(
        supabaseAdmin,
        req,
        user.id,
        "remove_company_billing_link",
        companyId,
        {
          asaas_customer_id: removal.asaas_customer_id ?? null,
          description_marker: removal.description_marker ?? null,
          purged_cached_invoice_count: Number(removal.purged_invoice_count ?? 0),
          provider_resource_changed: false,
        },
      );

      return platformBillingJsonResponse({ ok: true, removed });
    }

    if (action === "sync_company") {
      const context = await assertUserCanAccessCompany(req, companyId, ["admin"]);
      if (!context.isSuperadmin) {
        if (!(await loadModuleEnabled(context.supabaseAdmin))) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Modulo financeiro ainda nao esta habilitado",
          }, 409);
        }
        const companyLink = await loadLink(context.supabaseAdmin, companyId);
        if (companyLink?.billing_enabled !== true) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Financeiro ainda nao foi liberado para esta empresa",
            company_billing_enabled: false,
          }, 409);
        }
      }

      try {
        const sync = await syncCompanyInvoices(context.supabaseAdmin, companyId, {
          bypassCooldown: context.isSuperadmin,
          allowPendingValidation: context.isSuperadmin,
          requireBillingEnabled: !context.isSuperadmin,
          requireGlobalModuleEnabled: !context.isSuperadmin,
        });
        await auditBillingAction(
          context.supabaseAdmin,
          req,
          context.user.id,
          "sync_company_billing_invoices",
          companyId,
          { success: true, ...sync },
        );
        return platformBillingJsonResponse({ ok: true, sync });
      } catch (error) {
        const message = safePlatformBillingError(error);
        await auditBillingAction(
          context.supabaseAdmin,
          req,
          context.user.id,
          "sync_company_billing_invoices",
          companyId,
          { success: false, error: message },
        );
        throw error;
      }
    }

    return platformBillingJsonResponse({ ok: false, error: "Acao invalida" }, 400);
  } catch (error) {
    const message = safePlatformBillingError(error);
    const response: Record<string, unknown> = { ok: false, error: message };
    if (error instanceof SyncCooldownError) {
      response.retry_after_seconds = error.retryAfterSeconds;
    }
    return platformBillingJsonResponse(response, statusForError(error, message));
  }
});
