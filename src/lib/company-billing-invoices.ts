import type { CompanyBillingInvoice } from '@/lib/platform-billing-contracts';

const PIX_COMPATIBLE_BILLING_TYPES = new Set(['PIX', 'BOLETO', 'UNDEFINED']);
const PIX_PAYABLE_STATUSES = new Set(['PENDING', 'OVERDUE']);

export function canGenerateBillingInvoicePix(
  invoice: Pick<CompanyBillingInvoice, 'billingType' | 'status'>,
) {
  const status = String(invoice.status || '').trim().toUpperCase();
  const billingType = String(invoice.billingType || '').trim().toUpperCase();

  return PIX_PAYABLE_STATUSES.has(status) && PIX_COMPATIBLE_BILLING_TYPES.has(billingType);
}

function compareOptionalDatesDescending(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftTimestamp = left ? Date.parse(left) : Number.NaN;
  const rightTimestamp = right ? Date.parse(right) : Number.NaN;
  const leftIsValid = Number.isFinite(leftTimestamp);
  const rightIsValid = Number.isFinite(rightTimestamp);

  if (!leftIsValid && !rightIsValid) return 0;
  if (!leftIsValid) return 1;
  if (!rightIsValid) return -1;
  return rightTimestamp - leftTimestamp;
}

/**
 * Keeps the newest due date at the top without mutating the query cache.
 * Creation date and id make the order stable when invoices share a due date.
 */
export function sortBillingInvoicesByNewestDueDate(
  invoices: readonly CompanyBillingInvoice[],
) {
  return [...invoices].sort((left, right) => {
    const dueDateOrder = compareOptionalDatesDescending(left.dueDate, right.dueDate);
    if (dueDateOrder !== 0) return dueDateOrder;

    const creationDateOrder = compareOptionalDatesDescending(
      left.asaasCreatedAt ?? left.createdAt,
      right.asaasCreatedAt ?? right.createdAt,
    );
    if (creationDateOrder !== 0) return creationDateOrder;

    return left.id.localeCompare(right.id);
  });
}
