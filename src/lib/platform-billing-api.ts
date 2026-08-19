import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import { fetchAllSupabasePages } from '@/lib/supabase-pagination';
import {
  DEFAULT_PLATFORM_ASAAS_CONFIG,
  PLATFORM_BILLING_DESCRIPTION_MARKER,
  type CompanyBillingInvoice,
  type CompanyBillingInvoicePixQrCode,
  type CompanyBillingInvoiceRow,
  type CompanyBillingLink,
  type CompanyBillingLinkRow,
  type CompanyBillingOverdueWarning,
  type CompanyBillingOverdueWarningRpcRow,
  type CompanyBillingSummary,
  type CompanyBillingSummaryRpcRow,
  type PlatformAsaasConfig,
  type PlatformAsaasConfigResponse,
  type PlatformAsaasTestResponse,
  type PlatformAsaasTestResult,
  type PlatformBillingEnvironment,
  type PlatformBillingGetLinkResponse,
  type PlatformBillingGetInvoicePixQrCodeResponse,
  type PlatformBillingModuleStatus,
  type PlatformBillingModuleStatusRpcRow,
  type PlatformBillingOverview,
  type PlatformBillingCompanyOverview,
  type PlatformBillingRemoveLinkResponse,
  type PlatformBillingSearchCustomersResponse,
  type PlatformBillingSaveLinkResponse,
  type PlatformBillingSetCompanyEnabledResponse,
  type PlatformBillingSyncAllResponse,
  type PlatformBillingSyncAllResult,
  type PlatformBillingSyncCompanyResponse,
  type PlatformBillingSyncResult,
  type PlatformBillingValidateCustomerResponse,
  type PlatformBillingCustomerSearchResult,
  type ValidatedAsaasCustomer,
  DEFAULT_PLATFORM_BILLING_MODULE_STATUS,
  EMPTY_PLATFORM_BILLING_OVERVIEW,
  createEmptyCompanyBillingSummary,
  normalizeAsaasCustomer,
  normalizeCompanyBillingInvoice,
  normalizeCompanyBillingInvoicePixQrCode,
  normalizeCompanyBillingLink,
  normalizeCompanyBillingOverdueWarning,
  normalizeCompanyBillingSummary,
  normalizeCompanyBillingSync,
  normalizePlatformAsaasConfig,
  isPlatformBillingOpenStatus,
} from '@/lib/platform-billing-contracts';

export const PLATFORM_BILLING_CONFIG_FUNCTION = 'platform-billing-config' as const;
export const PLATFORM_BILLING_FUNCTION = 'platform-billing' as const;

type FunctionErrorPayload = {
  error?: string;
  message?: string;
  retry_after_seconds?: number | string | null;
};

export class PlatformBillingFunctionError extends Error {
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'PlatformBillingFunctionError';
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function normalizeRetryAfterSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(3600, Math.ceil(parsed)));
}

function retryAfterHeaderSeconds(value: string | null | undefined) {
  const numericSeconds = normalizeRetryAfterSeconds(value);
  if (numericSeconds) return numericSeconds;
  if (!value) return null;

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return normalizeRetryAfterSeconds((retryAt - Date.now()) / 1000);
}

async function readFunctionErrorPayload(error: any): Promise<FunctionErrorPayload | null> {
  const response = error?.context;
  if (!response || typeof response.clone !== 'function') return null;

  try {
    const payload = await response.clone().json();
    return payload && typeof payload === 'object'
      ? payload as FunctionErrorPayload
      : null;
  } catch {
    return null;
  }
}

export function getPlatformBillingRetryAfterSeconds(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  return normalizeRetryAfterSeconds(
    (error as { retryAfterSeconds?: unknown }).retryAfterSeconds,
  );
}

async function invokePlatformBillingFunction<T>(
  functionName: typeof PLATFORM_BILLING_CONFIG_FUNCTION | typeof PLATFORM_BILLING_FUNCTION,
  body: Record<string, unknown>,
  fallbackError: string,
) {
  const { data, error } = await supabase.functions.invoke<T & FunctionErrorPayload>(functionName, {
    body,
  });

  if (error || !data || data.error) {
    const responsePayload = error ? await readFunctionErrorPayload(error) : null;
    const response = error?.context;
    const status = Number.isFinite(Number(response?.status)) ? Number(response.status) : null;
    const headerRetryAfter = typeof response?.headers?.get === 'function'
      ? retryAfterHeaderSeconds(response.headers.get('Retry-After'))
      : null;
    const payload = responsePayload ?? data;
    const message = error
      ? await getFunctionErrorMessage(error)
      : payload?.error || payload?.message || fallbackError;
    const retryAfterSeconds = normalizeRetryAfterSeconds(payload?.retry_after_seconds)
      ?? headerRetryAfter;
    throw new PlatformBillingFunctionError(message, { status, retryAfterSeconds });
  }

  return data as T;
}

function firstRpcRow<T>(data: T[] | T | null | undefined): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

export async function getPlatformBillingModuleStatus(): Promise<PlatformBillingModuleStatus> {
  const { data, error } = await (supabase as any).rpc('get_platform_billing_module_status');

  // This RPC is the rollout guard. A missing migration, denied role or temporarily
  // unavailable database must behave exactly like a disabled module.
  if (error) return DEFAULT_PLATFORM_BILLING_MODULE_STATUS;

  const row = firstRpcRow<PlatformBillingModuleStatusRpcRow>(data);
  if (!row) return DEFAULT_PLATFORM_BILLING_MODULE_STATUS;

  return {
    available: true,
    enabled: !!row.module_enabled,
    configured: !!row.configured,
    marker: PLATFORM_BILLING_DESCRIPTION_MARKER,
    syncIntervalHours: 4,
  };
}

export async function getPlatformAsaasConfig(): Promise<PlatformAsaasConfig> {
  const response = await invokePlatformBillingFunction<PlatformAsaasConfigResponse>(
    PLATFORM_BILLING_CONFIG_FUNCTION,
    { action: 'get' },
    'Não foi possível carregar a configuração do Asaas da plataforma.',
  );
  return normalizePlatformAsaasConfig(response.config);
}

export async function savePlatformAsaasConfig(input: {
  token: string;
  environment: PlatformBillingEnvironment;
}): Promise<PlatformAsaasConfig> {
  const token = input.token.trim();
  const response = await invokePlatformBillingFunction<PlatformAsaasConfigResponse>(
    PLATFORM_BILLING_CONFIG_FUNCTION,
    {
      action: 'save',
      environment: input.environment,
      api_token: token,
    },
    'Não foi possível salvar a configuração do Asaas da plataforma.',
  );
  return normalizePlatformAsaasConfig(response.config);
}

export async function testPlatformAsaasConfig(input: {
  token?: string;
  environment?: PlatformBillingEnvironment;
} = {}): Promise<PlatformAsaasTestResult> {
  const token = input.token?.trim();
  const response = await invokePlatformBillingFunction<PlatformAsaasTestResponse>(
    PLATFORM_BILLING_CONFIG_FUNCTION,
    {
      action: 'test',
      ...(token ? { api_token: token } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
    },
    'Não foi possível validar o token do Asaas.',
  );

  return {
    valid: !!response.valid,
    environment: response.environment,
    accountName: response.account_name ?? null,
  };
}

export async function setPlatformBillingEnabled(enabled: boolean): Promise<PlatformAsaasConfig> {
  const response = await invokePlatformBillingFunction<PlatformAsaasConfigResponse>(
    PLATFORM_BILLING_CONFIG_FUNCTION,
    { action: 'set_enabled', enabled },
    `Não foi possível ${enabled ? 'ativar' : 'desativar'} o Financeiro.`,
  );
  return normalizePlatformAsaasConfig(response.config);
}

export interface CompanyBillingSnapshot {
  moduleEnabled: boolean;
  link: CompanyBillingLink | null;
  summary: CompanyBillingSummary;
  invoices: CompanyBillingInvoice[];
}

export async function getCompanyBillingSnapshot(companyId: string): Promise<CompanyBillingSnapshot> {
  const response = await invokePlatformBillingFunction<PlatformBillingGetLinkResponse>(
    PLATFORM_BILLING_FUNCTION,
    { action: 'get_link', company_id: companyId },
    'Não foi possível carregar o vínculo financeiro da empresa.',
  );

  return {
    moduleEnabled: !!response.module_enabled,
    link: normalizeCompanyBillingLink(response.link),
    summary: response.summary
      ? normalizeCompanyBillingSummary(response.summary, companyId)
      : createEmptyCompanyBillingSummary(companyId, !!response.module_enabled),
    invoices: (response.invoices ?? []).map(normalizeCompanyBillingInvoice),
  };
}

export async function validateAsaasCustomer(input: {
  companyId?: string;
  customerId: string;
}): Promise<ValidatedAsaasCustomer> {
  const response = await invokePlatformBillingFunction<PlatformBillingValidateCustomerResponse>(
    PLATFORM_BILLING_FUNCTION,
    {
      action: 'validate_customer',
      asaas_customer_id: input.customerId.trim(),
      ...(input.companyId ? { company_id: input.companyId } : {}),
    },
    'Não foi possível validar o cliente no Asaas.',
  );
  return normalizeAsaasCustomer(response.customer);
}

export async function searchAsaasCustomers(input: {
  query: string;
  offset?: number;
  limit?: number;
}): Promise<PlatformBillingCustomerSearchResult> {
  const query = input.query.trim();
  const response = await invokePlatformBillingFunction<PlatformBillingSearchCustomersResponse>(
    PLATFORM_BILLING_FUNCTION,
    {
      action: 'search_customers',
      query,
      offset: Math.max(0, input.offset ?? 0),
      limit: Math.min(50, Math.max(1, input.limit ?? 20)),
    },
    'Não foi possível pesquisar os clientes no Asaas.',
  );

  return {
    customers: (response.customers ?? []).map(normalizeAsaasCustomer),
    pagination: {
      offset: Number(response.pagination?.offset ?? 0),
      limit: Number(response.pagination?.limit ?? 20),
      hasMore: !!response.pagination?.has_more,
      totalCount: Number(response.pagination?.total_count ?? response.customers?.length ?? 0),
    },
  };
}

export async function saveCompanyBillingLink(input: {
  companyId: string;
  customerId: string;
  descriptionMarker?: string;
}) {
  const response = await invokePlatformBillingFunction<PlatformBillingSaveLinkResponse>(
    PLATFORM_BILLING_FUNCTION,
    {
      action: 'save_link',
      company_id: input.companyId,
      asaas_customer_id: input.customerId.trim(),
      description_marker: input.descriptionMarker?.trim() || PLATFORM_BILLING_DESCRIPTION_MARKER,
    },
    'Não foi possível vincular o cliente Asaas à empresa.',
  );

  const link = normalizeCompanyBillingLink(response.link);
  if (!link) throw new Error('O Asaas não retornou o vínculo financeiro salvo.');

  return {
    link,
    customer: normalizeAsaasCustomer(response.customer),
    sync: response.sync ? normalizeCompanyBillingSync(response.sync) : null,
    warning: response.warning ?? null,
  };
}

export async function removeCompanyBillingLink(companyId: string) {
  const response = await invokePlatformBillingFunction<PlatformBillingRemoveLinkResponse>(
    PLATFORM_BILLING_FUNCTION,
    { action: 'remove_link', company_id: companyId },
    'Não foi possível remover o vínculo financeiro da empresa.',
  );
  return response.removed;
}

export async function setCompanyBillingEnabled(input: {
  companyId: string;
  enabled: boolean;
  expectedBillingRevision?: string | null;
}): Promise<CompanyBillingLink> {
  const response = await invokePlatformBillingFunction<PlatformBillingSetCompanyEnabledResponse>(
    PLATFORM_BILLING_FUNCTION,
    {
      action: 'set_company_enabled',
      company_id: input.companyId,
      enabled: input.enabled,
      ...(input.expectedBillingRevision
        ? { expected_billing_revision: input.expectedBillingRevision }
        : {}),
    },
    `Não foi possível ${input.enabled ? 'ativar' : 'desativar'} o Financeiro desta empresa.`,
  );

  const link = normalizeCompanyBillingLink(response.link);
  if (!link) throw new Error('O backend não retornou o vínculo financeiro atualizado.');
  return link;
}

export async function syncCompanyBilling(companyId: string): Promise<PlatformBillingSyncResult> {
  const response = await invokePlatformBillingFunction<PlatformBillingSyncCompanyResponse>(
    PLATFORM_BILLING_FUNCTION,
    { action: 'sync_company', company_id: companyId },
    'Não foi possível sincronizar as cobranças da empresa.',
  );
  return normalizeCompanyBillingSync(response.sync);
}

export async function syncAllCompanyBilling(): Promise<PlatformBillingSyncAllResult> {
  const response = await invokePlatformBillingFunction<PlatformBillingSyncAllResponse>(
    PLATFORM_BILLING_FUNCTION,
    { action: 'sync_all' },
    'Não foi possível sincronizar as cobranças das empresas.',
  );

  return {
    skipped: !!response.skipped,
    reason: response.reason ?? null,
    stoppedEarly: !!response.stopped_early,
    remainingCount: Number(response.remaining_count ?? 0),
    stopReason: response.stop_reason ?? null,
    processedCount: Number(
      response.processed_count
      ?? (Number(response.success_count ?? response.synced ?? 0)
        + Number(response.error_count ?? response.failed ?? 0)),
    ),
    synced: Number(response.success_count ?? response.synced ?? 0),
    failed: Number(response.error_count ?? response.failed ?? 0),
    results: response.results ?? [],
  };
}

export async function getCompanyBillingSummary(companyId: string): Promise<CompanyBillingSummary> {
  const { data, error } = await (supabase as any).rpc('get_company_billing_summary', {
    _company_id: companyId,
  });
  if (error) throw error;

  return normalizeCompanyBillingSummary(
    firstRpcRow(data as CompanyBillingSummaryRpcRow[] | CompanyBillingSummaryRpcRow | null),
    companyId,
  );
}

export async function getCompanyBillingOverdueWarning(
  companyId: string,
): Promise<CompanyBillingOverdueWarning> {
  const { data, error } = await (supabase as any).rpc(
    'get_company_billing_overdue_warning',
    { _company_id: companyId },
  );
  if (error) throw error;

  return normalizeCompanyBillingOverdueWarning(
    firstRpcRow(
      data as CompanyBillingOverdueWarningRpcRow[]
        | CompanyBillingOverdueWarningRpcRow
        | null,
    ),
    companyId,
  );
}

export async function listCompanyBillingInvoices(companyId: string): Promise<CompanyBillingInvoice[]> {
  const rows = await fetchAllSupabasePages<CompanyBillingInvoiceRow>((from, to) => (
    supabase
      .from('company_billing_invoices' as any)
      .select('*')
      .eq('company_id', companyId)
      .order('due_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to) as any
  ));

  return rows.map(normalizeCompanyBillingInvoice);
}

export async function getCompanyBillingInvoicePixQrCode(input: {
  companyId: string;
  invoiceId: string;
}): Promise<CompanyBillingInvoicePixQrCode> {
  const response = await invokePlatformBillingFunction<PlatformBillingGetInvoicePixQrCodeResponse>(
    PLATFORM_BILLING_FUNCTION,
    {
      action: 'get_invoice_pix_qr_code',
      company_id: input.companyId,
      invoice_id: input.invoiceId,
    },
    'Não foi possível gerar o Pix desta fatura.',
  );

  return normalizeCompanyBillingInvoicePixQrCode(response, input.invoiceId);
}

export function unavailablePlatformAsaasConfig() {
  return DEFAULT_PLATFORM_ASAAS_CONFIG;
}

interface BillingOverviewCompanyRow {
  id: string;
  name: string;
  slug: string | null;
  status: string | null;
}

function currentFortalezaDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function utcDayNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function differenceInDateOnlyDays(laterDate: string, earlierDate: string) {
  return Math.max(0, utcDayNumber(laterDate) - utcDayNumber(earlierDate));
}

function buildCompanyOverview(
  company: BillingOverviewCompanyRow,
  link: CompanyBillingLinkRow | undefined,
  invoices: CompanyBillingInvoice[],
  today: string,
): PlatformBillingCompanyOverview {
  const openInvoices = invoices.filter((invoice) => isPlatformBillingOpenStatus(invoice.status));
  const overdueInvoices = openInvoices.filter((invoice) => (
    !!invoice.dueDate && invoice.dueDate < today
  ));
  const futureInvoices = openInvoices
    .filter((invoice) => !!invoice.dueDate && invoice.dueDate >= today)
    .sort((left, right) => (left.dueDate ?? '').localeCompare(right.dueDate ?? ''));
  const oldestOverdue = [...overdueInvoices]
    .sort((left, right) => (left.dueDate ?? '').localeCompare(right.dueDate ?? ''))[0];
  const nextDue = futureInvoices[0] ?? null;
  const nextDueAmount = nextDue?.dueDate
    ? futureInvoices
      .filter((invoice) => invoice.dueDate === nextDue.dueDate)
      .reduce((total, invoice) => total + invoice.value, 0)
    : 0;

  return {
    companyId: company.id,
    companyName: company.name,
    companySlug: company.slug ?? null,
    companyStatus: company.status ?? null,
    configured: !!link,
    billingEnabled: !!link?.billing_enabled,
    billingRevision: link?.billing_revision ?? null,
    linkStatus: link?.status ?? null,
    customerId: link?.asaas_customer_id ?? null,
    customerName: link?.customer_name ?? null,
    customerDocument: link?.customer_cpf_cnpj ?? null,
    lastSyncedAt: link?.last_synced_at ?? null,
    lastSyncError: link?.last_sync_error ?? null,
    lastFetchedCount: Number(link?.last_fetched_count ?? 0),
    lastMatchedCount: Number(link?.last_matched_count ?? 0),
    lastIgnoredCount: Number(link?.last_ignored_count ?? 0),
    openCount: openInvoices.length,
    openTotal: openInvoices.reduce((total, invoice) => total + invoice.value, 0),
    overdueCount: overdueInvoices.length,
    overdueTotal: overdueInvoices.reduce((total, invoice) => total + invoice.value, 0),
    oldestOverdueDueDate: oldestOverdue?.dueDate ?? null,
    oldestOverdueDays: oldestOverdue
      ? differenceInDateOnlyDays(today, oldestOverdue.dueDate!)
      : 0,
    nextDueDate: nextDue?.dueDate ?? null,
    nextDueAmount,
  };
}

export async function getSuperadminBillingOverview(): Promise<PlatformBillingOverview> {
  const [companies, links, invoiceRows] = await Promise.all([
      fetchAllSupabasePages<BillingOverviewCompanyRow>((from, to) => (
        supabase
          .from('companies' as any)
          .select('id, name, slug, status')
          .order('name')
          .order('id')
          .range(from, to) as any
      )),
      fetchAllSupabasePages<CompanyBillingLinkRow>((from, to) => (
        supabase
          .from('company_billing_links' as any)
          .select('*')
          .order('company_id')
          .range(from, to) as any
      )),
      fetchAllSupabasePages<CompanyBillingInvoiceRow>((from, to) => (
        supabase
          .from('company_billing_invoices' as any)
          .select('*')
          .order('company_id')
          .order('due_date', { ascending: false })
          .order('id')
          .range(from, to) as any
      )),
  ]);

  const linksByCompany = new Map(links.map((link) => [link.company_id, link]));
  const invoicesByCompany = new Map<string, CompanyBillingInvoice[]>();
  for (const row of invoiceRows) {
    const invoice = normalizeCompanyBillingInvoice(row);
    const companyInvoices = invoicesByCompany.get(invoice.companyId) ?? [];
    companyInvoices.push(invoice);
    invoicesByCompany.set(invoice.companyId, companyInvoices);
  }

  const today = currentFortalezaDate();
  const companyRows = companies.map((company) => buildCompanyOverview(
    company,
    linksByCompany.get(company.id),
    invoicesByCompany.get(company.id) ?? [],
    today,
  ));

  return {
    available: true,
    totals: companyRows.reduce((totals, company) => ({
      companyCount: totals.companyCount + 1,
      configuredCompanyCount: totals.configuredCompanyCount + (company.configured ? 1 : 0),
      unconfiguredCompanyCount: totals.unconfiguredCompanyCount + (company.configured ? 0 : 1),
      errorCompanyCount: totals.errorCompanyCount + (company.linkStatus === 'error' ? 1 : 0),
      openCount: totals.openCount + company.openCount,
      openTotal: totals.openTotal + company.openTotal,
      overdueCount: totals.overdueCount + company.overdueCount,
      overdueTotal: totals.overdueTotal + company.overdueTotal,
    }), { ...EMPTY_PLATFORM_BILLING_OVERVIEW.totals }),
    companies: companyRows,
  };
}
