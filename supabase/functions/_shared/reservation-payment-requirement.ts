export type PublicPaymentRequirement = {
  schema: "reservation-payment-requirement";
  version: 1;
  company_id: string;
  date: string;
  requires_payment: boolean;
  reason?: "feature_disabled" | "no_rule";
};

export function isPaymentRequirementDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Read-only CTA hint. Creation still checks the current rule and payment readiness. */
export function publicPaymentRequirement(
  companyId: string,
  date: string,
  requiresPayment: boolean,
  reason?: "feature_disabled" | "no_rule",
): PublicPaymentRequirement {
  return {
    schema: "reservation-payment-requirement",
    version: 1,
    company_id: companyId,
    date,
    requires_payment: requiresPayment,
    ...(reason ? { reason } : {}),
  };
}
