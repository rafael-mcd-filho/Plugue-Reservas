import {
  assertSuperadmin,
  assertUserCanAccessCompany,
  createSupabaseAdminClient,
  getClientIpAddress,
  isAuthorizedInternalJob,
} from "../_shared/internal-auth.ts";
import {
  getPlatformAsaasPayment,
  getPlatformAsaasPaymentPixQrCode,
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
import {
  normalizePlatformAsaasPaymentId,
  normalizePlatformBillingInvoiceId,
  normalizePlatformBillingPixQrCode,
  PlatformBillingPixValidationError,
  validatePlatformBillingPaymentForPix,
} from "../_shared/platform-billing-pix.ts";

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
    super(
      `Aguarde ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "segundo" : "segundos"} antes de sincronizar novamente`,
    );
    this.name = "SyncCooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class StaleBillingSnapshotError extends Error {
  constructor() {
    super("A configuração financeira mudou durante a operação; recarregue e tente novamente");
    this.name = "StaleBillingSnapshotError";
  }
}

class BillingInvoiceNotFoundError extends Error {
  constructor() {
    super("Fatura não encontrada");
    this.name = "BillingInvoiceNotFoundError";
  }
}

class InvoicePixUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoicePixUnavailableError";
  }
}

class PlatformPixProviderError extends Error {
  constructor() {
    super("O Asaas não conseguiu gerar o Pix agora; tente novamente em instantes");
    this.name = "PlatformPixProviderError";
  }
}

class PlatformPixRateLimitError extends Error {
  constructor() {
    super("O Asaas limitou temporariamente as solicitações de Pix; tente novamente em instantes");
    this.name = "PlatformPixRateLimitError";
  }
}

class PixRequestCooldownError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Aguarde ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "segundo" : "segundos"} antes de gerar outro Pix`,
    );
    this.name = "PixRequestCooldownError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function normalizeCompanyId(value: unknown) {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new Error("Empresa inválida");
  }
  return companyId;
}

function normalizeRevision(value: unknown, label: string) {
  const revision = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revision)) {
    throw new Error(`${label} inválida`);
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
  throw new Error("Filtro de clientes Asaas inválido");
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
    throw new Error("Paginação de clientes Asaas inválida");
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
      throw new Error("CPF ou CNPJ inválido para busca no Asaas");
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

async function loadCompanyBillingInvoice(
  supabaseAdmin: any,
  companyId: string,
  invoiceId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("company_billing_invoices")
    .select(INVOICE_COLUMNS)
    .eq("company_id", companyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Record<string, any> | null;
}

async function claimPlatformBillingPixRequest(
  supabaseAdmin: any,
  companyId: string,
  userId: string,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_platform_billing_pix_request",
    {
      _company_id: companyId,
      _user_id: userId,
      _claimed_at: new Date().toISOString(),
    },
  );
  if (error) throw new Error(error.message);

  const claim = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  if (claim.claimed !== true) {
    const retryAfterSeconds = Number(claim.retry_after_seconds ?? 1);
    throw new PixRequestCooldownError(
      Number.isFinite(retryAfterSeconds)
        ? Math.max(1, Math.min(60, Math.ceil(retryAfterSeconds)))
        : 1,
    );
  }
}

type PlatformBillingPixSnapshot = {
  companyId: string;
  invoiceId: string;
  sourceRevision: string;
  linkRevision: string;
  paymentId: string;
  customerId: string;
  requireBillingEnabled: boolean;
};

async function assertPlatformBillingPixSnapshotCurrent(
  supabaseAdmin: any,
  snapshot: PlatformBillingPixSnapshot,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "assert_platform_billing_pix_snapshot",
    {
      _company_id: snapshot.companyId,
      _invoice_id: snapshot.invoiceId,
      _expected_source_revision: snapshot.sourceRevision,
      _expected_link_revision: snapshot.linkRevision,
      _expected_payment_id: snapshot.paymentId,
      _expected_customer_id: snapshot.customerId,
      _require_billing_enabled: snapshot.requireBillingEnabled,
    },
  );
  if (error) {
    if (safePlatformBillingError(error).includes("Pix snapshot changed")) {
      throw new StaleBillingSnapshotError();
    }
    throw new Error(error.message);
  }

  const current = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  try {
    validatePlatformBillingPaymentForPix({
      id: current.asaas_payment_id,
      customer: current.asaas_customer_id,
      description: current.description,
      status: current.status,
      billingType: current.billing_type,
      value: current.value,
      dueDate: current.due_date,
    }, {
      paymentId: snapshot.paymentId,
      customerId: snapshot.customerId,
      descriptionMarker: typeof current.description_marker === "string"
        ? current.description_marker
        : "",
    });
  } catch (error) {
    if (error instanceof PlatformBillingPixValidationError) {
      throw new StaleBillingSnapshotError();
    }
    throw error;
  }
}

function mapPixProviderError(error: unknown) {
  if (!(error instanceof PlatformAsaasApiError)) return error;
  if (error.status === 404 || error.status === 400 || error.status === 422) {
    return new InvoicePixUnavailableError(
      "Não foi possível gerar um Pix para esta fatura; sincronize o Financeiro e tente novamente",
    );
  }
  if (error.status === 429) return new PlatformPixRateLimitError();
  return new PlatformPixProviderError();
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

  throw new Error("O cache financeiro excedeu 10.000 cobranças para uma empresa");
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
  if (!link) throw new Error("Vínculo financeiro não configurado");
  if (options.requireBillingEnabled && link.billing_enabled !== true) {
    throw new Error("Financeiro ainda não foi liberado para esta empresa");
  }
  if (link.status === "disabled") throw new Error("Vínculo financeiro desativado");
  if (link.status === "pending_validation" && !options.allowPendingValidation) {
    throw new Error("Vínculo financeiro requer revalidação pelo superadmin");
  }

  const config = await loadStoredPlatformBillingConfig(supabaseAdmin);
  if (options.requireGlobalModuleEnabled && !config.moduleEnabled) {
    throw new Error("Módulo financeiro ainda não está habilitado");
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
  const comparableMessage = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (error instanceof SyncCooldownError) return 429;
  if (error instanceof PixRequestCooldownError) return 429;
  if (error instanceof PlatformPixRateLimitError) return 429;
  if (error instanceof PlatformPixProviderError) return 502;
  if (error instanceof BillingInvoiceNotFoundError) return 404;
  if (error instanceof InvoicePixUnavailableError) return 409;
  if (error instanceof StaleBillingSnapshotError) return 409;
  if (error instanceof PlatformAsaasApiError) {
    if (error.status === 404) return 404;
    if ([400, 401, 403, 422, 429].includes(error.status)) return 400;
    return 502;
  }
  if (comparableMessage === "nao autorizado") return 401;
  if (comparableMessage.includes("sem permissao")) return 403;
  if (
    comparableMessage.includes("duplicate key")
    || comparableMessage.includes("already linked")
    || comparableMessage.includes("ja esta vinculado")
  ) return 409;
  if (
    comparableMessage.includes("nao encontrado")
    || comparableMessage.includes("nao configurado")
  ) return 404;
  if (
    comparableMessage.includes("requer revalidacao")
    || comparableMessage.includes("requires superadmin revalidation")
    || comparableMessage.includes("revision changed")
    || comparableMessage.includes("superseded")
    || comparableMessage.includes("ainda nao foi liberado")
    || comparableMessage.includes("source is not configured or valid")
    || comparableMessage.includes("link must be active and validated")
  ) return 409;
  if (
    comparableMessage.includes("invalida")
    || comparableMessage.includes("invalido")
    || comparableMessage.includes("obrigatorio")
    || comparableMessage.includes("desativado")
    || comparableMessage.includes("is disabled")
    || comparableMessage.includes("marcador deve ser")
    || comparableMessage.includes("excede 120 caracteres")
    || comparableMessage.includes("digite ao menos")
    || comparableMessage.includes("enabled state is required")
  ) return 400;
  if (comparableMessage.includes("link not found")) return 404;
  return 500;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: platformBillingCorsHeaders });
  }
  if (req.method !== "POST") {
    return platformBillingJsonResponse({ ok: false, error: "Método não permitido" }, 405);
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
            error: "Módulo financeiro ainda não está habilitado",
          }, 409);
        }
        const companyLink = await loadLink(context.supabaseAdmin, companyId);
        if (companyLink?.billing_enabled !== true) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Financeiro ainda não foi liberado para esta empresa",
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

    if (action === "get_invoice_pix_qr_code") {
      const context = await assertUserCanAccessCompany(req, companyId, ["admin"]);
      const invoiceId = normalizePlatformBillingInvoiceId(body.invoice_id);
      let auditedPaymentId: string | null = null;

      try {
        const [link, invoice] = await Promise.all([
          loadLink(context.supabaseAdmin, companyId, true),
          loadCompanyBillingInvoice(context.supabaseAdmin, companyId, invoiceId),
        ]);

        if (!invoice || !link || invoice.asaas_customer_id !== link.asaas_customer_id) {
          throw new BillingInvoiceNotFoundError();
        }
        if (link.status !== "active") {
          throw new InvoicePixUnavailableError(
            "O vínculo financeiro precisa estar ativo para gerar o Pix",
          );
        }
        if (!context.isSuperadmin) {
          if (!(await loadModuleEnabled(context.supabaseAdmin))) {
            throw new InvoicePixUnavailableError(
              "Módulo financeiro ainda não está habilitado",
            );
          }
          if (link.billing_enabled !== true) {
            throw new InvoicePixUnavailableError(
              "Financeiro ainda não foi liberado para esta empresa",
            );
          }
        }

        let paymentId: string;
        try {
          paymentId = normalizePlatformAsaasPaymentId(invoice.asaas_payment_id);
          validatePlatformBillingPaymentForPix({
            id: paymentId,
            customer: invoice.asaas_customer_id,
            description: invoice.description,
            status: invoice.status,
            billingType: invoice.billing_type,
            value: invoice.value,
            dueDate: invoice.due_date,
          }, {
            paymentId,
            customerId: link.asaas_customer_id,
            descriptionMarker: link.description_marker,
          });
        } catch (error) {
          if (error instanceof PlatformBillingPixValidationError) {
            throw new InvoicePixUnavailableError(error.message);
          }
          throw error;
        }
        auditedPaymentId = paymentId;

        // The database claim atomically approves global, company and user Pix
        // generation buckets. A rejected bucket consumes none of the others.
        await claimPlatformBillingPixRequest(
          context.supabaseAdmin,
          companyId,
          context.user.id,
        );

        const config = await loadStoredPlatformBillingConfig(context.supabaseAdmin);
        if (!context.isSuperadmin && !config.moduleEnabled) {
          throw new InvoicePixUnavailableError(
            "Módulo financeiro ainda não está habilitado",
          );
        }

        const livePayment = await getPlatformAsaasPayment(
          config.apiToken,
          config.environment,
          paymentId,
        );
        let validatedPayment;
        try {
          validatedPayment = validatePlatformBillingPaymentForPix(livePayment, {
            paymentId,
            customerId: link.asaas_customer_id,
            descriptionMarker: link.description_marker,
          });
        } catch (error) {
          if (error instanceof PlatformBillingPixValidationError) {
            throw new InvoicePixUnavailableError(error.message);
          }
          throw error;
        }

        const pixSnapshot: PlatformBillingPixSnapshot = {
          companyId,
          invoiceId,
          sourceRevision: config.sourceRevision,
          linkRevision: normalizeRevision(link.link_revision, "Revisão do vínculo financeiro"),
          paymentId,
          customerId: link.asaas_customer_id,
          requireBillingEnabled: !context.isSuperadmin,
        };

        const providerPix = await getPlatformAsaasPaymentPixQrCode(
          config.apiToken,
          config.environment,
          paymentId,
        );
        let pix;
        try {
          pix = normalizePlatformBillingPixQrCode(providerPix);
        } catch (error) {
          if (error instanceof PlatformBillingPixValidationError) {
            throw new PlatformPixProviderError();
          }
          throw error;
        }

        // First post-provider fence catches changes made while either Asaas GET
        // was in flight.
        await assertPlatformBillingPixSnapshotCurrent(
          context.supabaseAdmin,
          pixSnapshot,
        );

        await auditBillingAction(
          context.supabaseAdmin,
          req,
          context.user.id,
          "get_company_billing_invoice_pix_qr_code",
          companyId,
          {
            success: true,
            invoice_id: invoiceId,
            asaas_payment_id: paymentId,
            billing_type: validatedPayment.billingType,
            payment_status: validatedPayment.status,
          },
        );

        // This must remain the final await on the success path. Database state
        // can still change after this statement's snapshot and before the HTTP
        // bytes leave the process; no non-transactional provider flow can
        // eliminate that final interval, but a second fence minimizes it.
        await assertPlatformBillingPixSnapshotCurrent(
          context.supabaseAdmin,
          pixSnapshot,
        );

        return platformBillingJsonResponse({
          ok: true,
          invoice_id: invoiceId,
          asaas_payment_id: paymentId,
          payment: {
            value: validatedPayment.value,
            due_date: validatedPayment.dueDate,
          },
          pix: {
            encoded_image: pix.encodedImage,
            payload: pix.payload,
            expiration_date: pix.expirationDate,
          },
        });
      } catch (error) {
        const providerHttpStatus = error instanceof PlatformAsaasApiError
          ? error.status
          : null;
        const mappedError = mapPixProviderError(error);
        await auditBillingAction(
          context.supabaseAdmin,
          req,
          context.user.id,
          "get_company_billing_invoice_pix_qr_code",
          companyId,
          {
            success: false,
            invoice_id: invoiceId,
            asaas_payment_id: auditedPaymentId,
            provider_http_status: providerHttpStatus,
            error: safePlatformBillingError(mappedError),
          },
        );
        throw mappedError;
      }
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
      if (!company) throw new Error("Empresa não encontrada");

      const { data: duplicate, error: duplicateError } = await supabaseAdmin
        .from("company_billing_links")
        .select("company_id")
        .eq("asaas_customer_id", customerId)
        .neq("company_id", companyId)
        .maybeSingle();
      if (duplicateError) throw new Error(duplicateError.message);
      if (duplicate) throw new Error("Este Customer ID do Asaas já está vinculado a outra empresa");

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
        throw new Error("Estado de liberação financeira inválido");
      }

      const currentLink = await loadLink(supabaseAdmin, companyId, true);
      if (!currentLink) throw new Error("Vínculo financeiro não configurado");
      const expectedBillingRevision = body.expected_billing_revision === undefined
        ? normalizeRevision(currentLink.billing_revision, "Revisão financeira")
        : normalizeRevision(body.expected_billing_revision, "Revisão financeira");

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
      if (!updatedLink) throw new Error("Vínculo financeiro não configurado");

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
        throw new Error("Revisão da fonte Asaas não configurada");
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
            error: "Módulo financeiro ainda não está habilitado",
          }, 409);
        }
        const companyLink = await loadLink(context.supabaseAdmin, companyId);
        if (companyLink?.billing_enabled !== true) {
          return platformBillingJsonResponse({
            ok: false,
            error: "Financeiro ainda não foi liberado para esta empresa",
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

    return platformBillingJsonResponse({ ok: false, error: "Ação inválida" }, 400);
  } catch (error) {
    const message = safePlatformBillingError(error);
    const response: Record<string, unknown> = { ok: false, error: message };
    if (error instanceof SyncCooldownError) {
      response.retry_after_seconds = error.retryAfterSeconds;
    }
    if (error instanceof PixRequestCooldownError) {
      response.retry_after_seconds = error.retryAfterSeconds;
    }
    return platformBillingJsonResponse(response, statusForError(error, message));
  }
});
