export const PLATFORM_BILLING_DESCRIPTION_MARKER = '[PLUGUEGUEST]' as const;
export const PLATFORM_BILLING_SYNC_INTERVAL_HOURS = 4 as const;
export const PLATFORM_BILLING_OVERDUE_POPUP_DAYS = 6 as const;

export type PlatformBillingEnvironment = 'sandbox' | 'production';
export type CompanyBillingLinkStatus = 'pending_validation' | 'active' | 'error' | 'disabled';
export type CompanyBillingSummaryLinkStatus = CompanyBillingLinkStatus | 'not_configured';

export type KnownAsaasPaymentStatus =
  | 'PENDING'
  | 'RECEIVED'
  | 'CONFIRMED'
  | 'OVERDUE'
  | 'REFUNDED'
  | 'RECEIVED_IN_CASH'
  | 'REFUND_REQUESTED'
  | 'REFUND_IN_PROGRESS'
  | 'CHARGEBACK_REQUESTED'
  | 'CHARGEBACK_DISPUTE'
  | 'AWAITING_CHARGEBACK_REVERSAL'
  | 'DUNNING_REQUESTED'
  | 'DUNNING_RECEIVED'
  | 'AWAITING_RISK_ANALYSIS';

export type AsaasPaymentStatus = KnownAsaasPaymentStatus | (string & {});

export interface PlatformBillingModuleStatusRpcRow {
  module_enabled: boolean | null;
  configured: boolean | null;
}

export interface PlatformBillingModuleStatus {
  /** False when the rollout migration/RPC is not available yet. */
  available: boolean;
  enabled: boolean;
  configured: boolean;
  marker: typeof PLATFORM_BILLING_DESCRIPTION_MARKER;
  syncIntervalHours: typeof PLATFORM_BILLING_SYNC_INTERVAL_HOURS;
}

export interface PlatformAsaasConfigRow {
  module_enabled: boolean | null;
  configured: boolean | null;
  environment: PlatformBillingEnvironment | null;
  token_last_four: string | null;
  token_validated_at: string | null;
  token_last_error: string | null;
  updated_at: string | null;
}

export interface PlatformAsaasConfig {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  environment: PlatformBillingEnvironment;
  maskedToken: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface PlatformAsaasConfigResponse {
  ok: true;
  config: PlatformAsaasConfigRow;
}

export interface PlatformAsaasTestResponse {
  ok: true;
  valid: boolean;
  environment: PlatformBillingEnvironment;
  account_name?: string | null;
}

export interface PlatformAsaasTestResult {
  valid: boolean;
  environment: PlatformBillingEnvironment;
  accountName: string | null;
}

export interface CompanyBillingLinkRow {
  company_id: string;
  asaas_customer_id: string;
  billing_enabled?: boolean | null;
  billing_revision?: string | null;
  customer_name: string | null;
  customer_cpf_cnpj: string | null;
  description_marker: string | null;
  status: CompanyBillingLinkStatus;
  last_validated_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  last_fetched_count?: number | string | null;
  last_matched_count?: number | string | null;
  last_ignored_count?: number | string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyBillingLink {
  companyId: string;
  customerId: string;
  billingEnabled: boolean;
  billingRevision: string | null;
  customerName: string | null;
  customerDocument: string | null;
  descriptionMarker: string;
  status: CompanyBillingLinkStatus;
  lastValidatedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastFetchedCount: number;
  lastMatchedCount: number;
  lastIgnoredCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AsaasCustomerRow {
  id: string;
  name: string | null;
  cpf_cnpj: string | null;
  email: string | null;
  mobile_phone: string | null;
  external_reference?: string | null;
  linked_company_id?: string | null;
  billing_enabled?: boolean | null;
}

export interface ValidatedAsaasCustomer {
  id: string;
  name: string;
  cpfCnpj: string | null;
  email: string | null;
  mobilePhone: string | null;
  externalReference: string | null;
  linkedCompanyId: string | null;
  billingEnabled: boolean;
}

export interface PlatformBillingCustomerSearchPagination {
  offset: number;
  limit: number;
  hasMore: boolean;
  totalCount: number;
}

export interface PlatformBillingCustomerSearchResult {
  customers: ValidatedAsaasCustomer[];
  pagination: PlatformBillingCustomerSearchPagination;
}

export interface PlatformBillingSearchCustomersResponse {
  ok: true;
  customers: AsaasCustomerRow[];
  pagination: {
    offset?: number | string | null;
    limit?: number | string | null;
    has_more?: boolean | null;
    total_count?: number | string | null;
  };
}

export interface CompanyBillingInvoiceRow {
  id: string;
  company_id: string;
  asaas_payment_id: string;
  asaas_customer_id: string;
  asaas_subscription_id: string | null;
  description: string | null;
  status: AsaasPaymentStatus;
  value: number | string;
  due_date: string | null;
  payment_date: string | null;
  billing_type: string | null;
  invoice_url: string | null;
  bank_slip_url: string | null;
  external_reference: string | null;
  asaas_created_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyBillingInvoice {
  id: string;
  companyId: string;
  asaasPaymentId: string;
  asaasCustomerId: string;
  asaasSubscriptionId: string | null;
  description: string;
  status: AsaasPaymentStatus;
  value: number;
  dueDate: string | null;
  paymentDate: string | null;
  billingType: string | null;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  externalReference: string | null;
  asaasCreatedAt: string | null;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyBillingSummaryRpcRow {
  module_enabled: boolean | null;
  company_billing_enabled?: boolean | null;
  link_status: CompanyBillingSummaryLinkStatus | null;
  has_link: boolean | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  open_count: number | string | null;
  open_amount: number | string | null;
  overdue_count: number | string | null;
  overdue_amount: number | string | null;
  oldest_overdue_due_date: string | null;
  oldest_overdue_days: number | string | null;
  show_overdue_popup: boolean | null;
  next_due_date: string | null;
  next_due_amount: number | string | null;
}

export interface CompanyBillingSummary {
  companyId: string | null;
  configured: boolean;
  moduleEnabled: boolean;
  companyBillingEnabled: boolean;
  linkStatus: CompanyBillingSummaryLinkStatus | null;
  hasLink: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  openCount: number;
  openTotal: number;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdueDueDate: string | null;
  oldestOverdueDays: number;
  showOverduePopup: boolean;
  nextDueDate: string | null;
  nextDueAmount: number;
}

export interface CompanyBillingSyncRow {
  company_id: string;
  matched_count: number;
  fetched_count: number;
  ignored_count?: number;
  last_synced_at: string;
}

export interface CompanyBillingSyncResult {
  companyId: string;
  matchedCount: number;
  fetchedCount: number;
  ignoredCount: number;
  lastSyncedAt: string;
}

export type PlatformBillingSyncResult = CompanyBillingSyncResult;

export interface PlatformBillingGetLinkResponse {
  ok: true;
  module_enabled: boolean;
  link: CompanyBillingLinkRow | null;
  summary?: CompanyBillingSummaryRpcRow | null;
  invoices?: CompanyBillingInvoiceRow[];
}

export interface PlatformBillingValidateCustomerResponse {
  ok: true;
  customer: AsaasCustomerRow;
}

export interface PlatformBillingSaveLinkResponse {
  ok: true;
  link: CompanyBillingLinkRow;
  customer: AsaasCustomerRow;
  sync?: CompanyBillingSyncRow | null;
  warning?: string | null;
}

export interface PlatformBillingRemoveLinkResponse {
  ok: true;
  removed: boolean;
}

export interface PlatformBillingSetCompanyEnabledResponse {
  ok: true;
  link: CompanyBillingLinkRow;
  previous_enabled: boolean;
}

export interface PlatformBillingSyncCompanyResponse {
  ok: true;
  sync: CompanyBillingSyncRow;
}

export interface PlatformBillingSyncAllResponse {
  ok: true;
  skipped: boolean;
  reason?: string | null;
  stopped_early?: boolean;
  remaining_count?: number;
  stop_reason?: string | null;
  processed_count?: number;
  success_count?: number;
  error_count?: number;
  synced?: number;
  failed?: number;
  results?: Array<Partial<CompanyBillingSyncRow> & {
    ok: boolean;
    company_id: string;
    error?: string | null;
  }>;
  [key: string]: unknown;
}

export interface PlatformBillingSyncAllResult {
  skipped: boolean;
  reason: string | null;
  stoppedEarly: boolean;
  remainingCount: number;
  stopReason: string | null;
  processedCount: number;
  synced: number;
  failed: number;
  results: NonNullable<PlatformBillingSyncAllResponse['results']>;
}

export interface PlatformBillingCompanyOverview {
  companyId: string;
  companyName: string;
  companySlug: string | null;
  companyStatus: string | null;
  configured: boolean;
  billingEnabled: boolean;
  billingRevision: string | null;
  linkStatus: CompanyBillingLinkStatus | null;
  customerId: string | null;
  customerName: string | null;
  customerDocument: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  lastFetchedCount: number;
  lastMatchedCount: number;
  lastIgnoredCount: number;
  openCount: number;
  openTotal: number;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdueDueDate: string | null;
  oldestOverdueDays: number;
  nextDueDate: string | null;
  nextDueAmount: number;
}

export interface PlatformBillingOverviewTotals {
  companyCount: number;
  configuredCompanyCount: number;
  unconfiguredCompanyCount: number;
  errorCompanyCount: number;
  openCount: number;
  openTotal: number;
  overdueCount: number;
  overdueTotal: number;
}

export interface PlatformBillingOverview {
  available: boolean;
  totals: PlatformBillingOverviewTotals;
  companies: PlatformBillingCompanyOverview[];
}

export const DEFAULT_PLATFORM_BILLING_MODULE_STATUS: PlatformBillingModuleStatus = {
  available: false,
  enabled: false,
  configured: false,
  marker: PLATFORM_BILLING_DESCRIPTION_MARKER,
  syncIntervalHours: PLATFORM_BILLING_SYNC_INTERVAL_HOURS,
};

export const DEFAULT_PLATFORM_ASAAS_CONFIG: PlatformAsaasConfig = {
  available: false,
  configured: false,
  enabled: false,
  environment: 'production',
  maskedToken: null,
  lastTestedAt: null,
  lastError: null,
  updatedAt: null,
};

export const EMPTY_PLATFORM_BILLING_OVERVIEW: PlatformBillingOverview = {
  available: false,
  totals: {
    companyCount: 0,
    configuredCompanyCount: 0,
    unconfiguredCompanyCount: 0,
    errorCompanyCount: 0,
    openCount: 0,
    openTotal: 0,
    overdueCount: 0,
    overdueTotal: 0,
  },
  companies: [],
};

export const PLATFORM_BILLING_OPEN_STATUSES = new Set<AsaasPaymentStatus>([
  'PENDING',
  'OVERDUE',
  'DUNNING_REQUESTED',
  'AWAITING_RISK_ANALYSIS',
]);

export const PLATFORM_BILLING_PAID_STATUSES = new Set<AsaasPaymentStatus>([
  'RECEIVED',
  'CONFIRMED',
  'RECEIVED_IN_CASH',
]);

export function toPlatformBillingNumber(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePlatformAsaasConfig(row?: PlatformAsaasConfigRow | null): PlatformAsaasConfig {
  if (!row) return DEFAULT_PLATFORM_ASAAS_CONFIG;

  const lastFour = row.token_last_four?.trim() || null;
  return {
    available: true,
    configured: !!row.configured,
    enabled: !!row.module_enabled,
    environment: row.environment === 'production' ? 'production' : 'sandbox',
    maskedToken: lastFour ? `•••• ${lastFour}` : null,
    lastTestedAt: row.token_validated_at ?? null,
    lastError: row.token_last_error ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function normalizeCompanyBillingLink(row?: CompanyBillingLinkRow | null): CompanyBillingLink | null {
  if (!row) return null;
  return {
    companyId: row.company_id,
    customerId: row.asaas_customer_id,
    billingEnabled: !!row.billing_enabled,
    billingRevision: row.billing_revision ?? null,
    customerName: row.customer_name ?? null,
    customerDocument: row.customer_cpf_cnpj ?? null,
    descriptionMarker: row.description_marker || PLATFORM_BILLING_DESCRIPTION_MARKER,
    status: row.status,
    lastValidatedAt: row.last_validated_at ?? null,
    lastSyncedAt: row.last_synced_at ?? null,
    lastSyncError: row.last_sync_error ?? null,
    lastFetchedCount: toPlatformBillingNumber(row.last_fetched_count),
    lastMatchedCount: toPlatformBillingNumber(row.last_matched_count),
    lastIgnoredCount: toPlatformBillingNumber(row.last_ignored_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeAsaasCustomer(row: AsaasCustomerRow): ValidatedAsaasCustomer {
  return {
    id: row.id,
    name: row.name || row.id,
    cpfCnpj: row.cpf_cnpj ?? null,
    email: row.email ?? null,
    mobilePhone: row.mobile_phone ?? null,
    externalReference: row.external_reference ?? null,
    linkedCompanyId: row.linked_company_id ?? null,
    billingEnabled: !!row.billing_enabled,
  };
}

export function normalizeCompanyBillingInvoice(row: CompanyBillingInvoiceRow): CompanyBillingInvoice {
  return {
    id: row.id,
    companyId: row.company_id,
    asaasPaymentId: row.asaas_payment_id,
    asaasCustomerId: row.asaas_customer_id,
    asaasSubscriptionId: row.asaas_subscription_id ?? null,
    description: row.description || 'Mensalidade PlugueGuest',
    status: String(row.status || '').toUpperCase() as AsaasPaymentStatus,
    value: toPlatformBillingNumber(row.value),
    dueDate: row.due_date,
    paymentDate: row.payment_date ?? null,
    billingType: row.billing_type ?? null,
    invoiceUrl: row.invoice_url ?? null,
    bankSlipUrl: row.bank_slip_url ?? null,
    externalReference: row.external_reference ?? null,
    asaasCreatedAt: row.asaas_created_at ?? null,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEmptyCompanyBillingSummary(
  companyId: string | null = null,
  moduleEnabled = false,
): CompanyBillingSummary {
  return {
    companyId,
    configured: false,
    moduleEnabled,
    companyBillingEnabled: false,
    linkStatus: null,
    hasLink: false,
    lastSyncedAt: null,
    lastSyncError: null,
    openCount: 0,
    openTotal: 0,
    overdueCount: 0,
    overdueTotal: 0,
    oldestOverdueDueDate: null,
    oldestOverdueDays: 0,
    showOverduePopup: false,
    nextDueDate: null,
    nextDueAmount: 0,
  };
}

export function normalizeCompanyBillingSummary(
  row: CompanyBillingSummaryRpcRow | null | undefined,
  companyId: string | null,
): CompanyBillingSummary {
  if (!row) return createEmptyCompanyBillingSummary(companyId);

  const hasLink = !!row.has_link;
  return {
    companyId,
    configured: hasLink && row.link_status === 'active',
    moduleEnabled: !!row.module_enabled,
    companyBillingEnabled: !!row.company_billing_enabled,
    linkStatus: row.link_status ?? null,
    hasLink,
    lastSyncedAt: row.last_synced_at ?? null,
    lastSyncError: row.last_sync_error ?? null,
    openCount: toPlatformBillingNumber(row.open_count),
    openTotal: toPlatformBillingNumber(row.open_amount),
    overdueCount: toPlatformBillingNumber(row.overdue_count),
    overdueTotal: toPlatformBillingNumber(row.overdue_amount),
    oldestOverdueDueDate: row.oldest_overdue_due_date ?? null,
    oldestOverdueDays: toPlatformBillingNumber(row.oldest_overdue_days),
    showOverduePopup: !!row.show_overdue_popup,
    nextDueDate: row.next_due_date ?? null,
    nextDueAmount: toPlatformBillingNumber(row.next_due_amount),
  };
}

export function normalizeCompanyBillingSync(row: CompanyBillingSyncRow): CompanyBillingSyncResult {
  return {
    companyId: row.company_id,
    matchedCount: toPlatformBillingNumber(row.matched_count),
    fetchedCount: toPlatformBillingNumber(row.fetched_count),
    ignoredCount: toPlatformBillingNumber(row.ignored_count),
    lastSyncedAt: row.last_synced_at,
  };
}

export function isPlatformBillingOpenStatus(status: AsaasPaymentStatus) {
  return PLATFORM_BILLING_OPEN_STATUSES.has(status);
}

export function isPlatformBillingPaidStatus(status: AsaasPaymentStatus) {
  return PLATFORM_BILLING_PAID_STATUSES.has(status);
}
