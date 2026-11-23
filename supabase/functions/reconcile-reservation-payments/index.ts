import { synchronizeReservationSettlement } from "../_shared/reservation-settlement-sync.ts";
import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { getReservationAsaasCredentials } from "../_shared/reservation-asaas-config.ts";
import {
  AsaasApiError,
  getAsaasActiveChargebackStatus,
  getAsaasExternalPaymentOutcome,
  getAsaasPayment,
  getAsaasPaymentStatus,
  getAsaasRefundedValue,
  isAsaasPaidStatus,
  listAsaasPayments,
} from "../_shared/asaas.ts";
import {
  buildPaymentLinkExternalReference,
  confirmReservationPayment,
  corsHeaders,
  jsonResponse,
  markReservationPaymentProviderOutcome,
  providerTimestampHasExplicitTime,
  readJson,
  recordReservationPaymentInstallment,
} from "../_shared/reservation-payments.ts";

const RECONCILE_STATUSES = [
  "pending",
  "expired",
  "paid",
  "late_paid",
  "refund_pending",
  "refund_denied",
  "refunded",
  "partial_refunded",
  "chargeback",
  "cancelled",
];

const NOT_CONFIRMABLE_STATUSES = new Set([
  "paid",
  "late_paid",
  "refunded",
  "partial_refunded",
  "refund_pending",
  "refund_denied",
  "chargeback",
  "cancelled",
]);

const OUTCOME_STATUSES = new Set([
  "refunded",
  "partial_refunded",
  "refund_pending",
  "refund_denied",
  "chargeback",
  "cancelled",
]);

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPaymentMetadata(payment: any) {
  return payment?.metadata && typeof payment.metadata === "object" && !Array.isArray(payment.metadata)
    ? payment.metadata
    : {};
}

function getAsaasPaidAt(payment: any) {
  const candidates = [
    payment?.confirmedDate,
    payment?.clientPaymentDate,
    payment?.paymentDate,
  ].filter((value) => typeof value === "string" && value.trim());

  return candidates.find(providerTimestampHasExplicitTime) ?? candidates[0] ?? null;
}

type ReservationAsaasCredentials = NonNullable<Awaited<ReturnType<typeof getReservationAsaasCredentials>>>;

async function attachAsaasPaymentIdFromExternalReference(supabaseAdmin: any, payment: any, apiToken: ReservationAsaasCredentials) {
  if (payment.asaas_payment_id) return payment;

  const externalReference = payment.payment_link_external_reference
    ?? (payment.billing_type ? buildPaymentLinkExternalReference(payment.payment_token, payment.billing_type) : null);
  if (!externalReference) return payment;

  const response = await listAsaasPayments(apiToken, { externalReference, limit: 10 });
  const asaasPayment = Array.isArray(response?.data) ? response.data.find((item) => item?.id) : null;
  if (!asaasPayment?.id) return payment;

  const { data: updatedPayment, error } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      asaas_payment_id: asaasPayment.id,
      asaas_status: asaasPayment.status ?? payment.asaas_status,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return updatedPayment;
}

async function getAsaasPaymentSnapshot(apiToken: ReservationAsaasCredentials, paymentId: string) {
  const asaasPayment = await getAsaasPayment(apiToken, paymentId);
  const asaasStatus = asaasPayment.status ?? await getAsaasPaymentStatus(apiToken, paymentId);

  return {
    asaasStatus: asaasPayment?.status ?? asaasStatus,
    asaasPayment,
    chargebackStatus: getAsaasActiveChargebackStatus(asaasPayment),
  };
}

async function updateProviderSnapshot(
  supabaseAdmin: any,
  payment: any,
  options: {
    source: string;
    asaasStatus: string | null;
    outcome?: string | null;
    metadata?: Record<string, unknown>;
    errorDetails?: string | null;
  },
) {
  const checkedAtIso = new Date().toISOString();
  const metadata = {
    ...getPaymentMetadata(payment),
    provider_status_check: {
      source: options.source,
      outcome: options.outcome ?? null,
      asaas_status: options.asaasStatus,
      checked_at: checkedAtIso,
      ...(options.metadata ?? {}),
    },
  };

  const changes: Record<string, unknown> = {
    asaas_status: options.asaasStatus,
    last_checked_at: checkedAtIso,
    metadata,
  };

  if ("errorDetails" in options) {
    changes.error_details = options.errorDetails;
  }

  const { data, error } = await supabaseAdmin
    .from("reservation_payments")
    .update(changes)
    .eq("id", payment.id)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function recordReconciliationFailure(supabaseAdmin: any, payment: any, message: string) {
  const { error } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      error_details: message,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (error) {
    console.warn("Failed to record reservation payment reconciliation failure", payment.id, error);
  }
}

async function refreshProviderPaymentState(supabaseAdmin: any, payment: any, apiToken: ReservationAsaasCredentials) {
  const previousStatus = payment.status;
  payment = await attachAsaasPaymentIdFromExternalReference(supabaseAdmin, payment, apiToken);

  if (!payment.asaas_payment_id) {
    await updateProviderSnapshot(supabaseAdmin, payment, {
      source: "scheduled_reconcile",
      asaasStatus: payment.asaas_status ?? null,
      metadata: {
        provider_payment_found: false,
      },
    });
    return { previousStatus, currentStatus: payment.status, changed: false, result: "not_linked" };
  }

  let snapshot;
  try {
    snapshot = await getAsaasPaymentSnapshot(apiToken, payment.asaas_payment_id);
  } catch (error) {
    if (error instanceof AsaasApiError && error.status === 404) {
      await updateProviderSnapshot(supabaseAdmin, payment, {
        source: "scheduled_reconcile",
        asaasStatus: "NOT_FOUND",
        metadata: {
          provider_payment_found: false,
        },
        errorDetails: payment.status === "expired" ? payment.error_details : "Cobranca nao localizada no Asaas",
      });
      return { previousStatus, currentStatus: payment.status, changed: false, result: "not_found" };
    }
    throw error;
  }

  await synchronizeReservationSettlement(supabaseAdmin, payment, "scheduled_reconcile");
  const providerMetadata = {
    provider_payment_status: snapshot.asaasPayment?.status ?? null,
    chargeback_status: snapshot.chargebackStatus,
    refunded_value: getAsaasRefundedValue(snapshot.asaasPayment),
  };
  payment = await recordReservationPaymentInstallment(supabaseAdmin,payment,snapshot.asaasPayment,"scheduled_reconcile");
  const outcome = getAsaasExternalPaymentOutcome(null, snapshot.asaasStatus, snapshot.asaasPayment);

  if (outcome) {
    if (getPaymentMetadata(payment).asaas_installment_id) {
      return { previousStatus,currentStatus:payment.status,changed:false,result:"installment_manual_reconciliation" };
    }
    if (payment.status === "expired" && outcome === "cancelled") {
      await updateProviderSnapshot(supabaseAdmin, payment, {
        source: "scheduled_reconcile",
        asaasStatus: snapshot.asaasStatus,
        outcome,
        metadata: providerMetadata,
      });
      return { previousStatus, currentStatus: payment.status, changed: false, result: "expired_provider_cancelled" };
    }

    if (payment.status === outcome) {
      await updateProviderSnapshot(supabaseAdmin, payment, {
        source: "scheduled_reconcile",
        asaasStatus: snapshot.asaasStatus,
        outcome,
        metadata: providerMetadata,
      });
      return { previousStatus, currentStatus: payment.status, changed: false, result: outcome };
    }

    const updatedPayment = await markReservationPaymentProviderOutcome(supabaseAdmin, payment, outcome, {
      source: "scheduled_reconcile",
      asaasStatus: snapshot.asaasStatus,
      metadata: providerMetadata,
    });
    return {
      previousStatus,
      currentStatus: updatedPayment.status,
      changed: updatedPayment.status !== previousStatus,
      result: outcome,
    };
  }

  if (isAsaasPaidStatus(snapshot.asaasStatus) && !NOT_CONFIRMABLE_STATUSES.has(payment.status)) {
    await confirmReservationPayment(
      supabaseAdmin,
      payment,
      snapshot.asaasStatus,
      "scheduled_reconcile",
      getAsaasPaidAt(snapshot.asaasPayment),
    );
    const { data: refreshedPayment, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("id", payment.id)
      .single();

    if (error) throw new Error(error.message);
    return {
      previousStatus,
      currentStatus: refreshedPayment.status,
      changed: refreshedPayment.status !== previousStatus,
      result: refreshedPayment.status,
    };
  }

  const updatedPayment = await updateProviderSnapshot(supabaseAdmin, payment, {
    source: "scheduled_reconcile",
    asaasStatus: snapshot.asaasStatus,
    outcome: OUTCOME_STATUSES.has(payment.status) ? payment.status : null,
    metadata: providerMetadata,
  });

  return {
    previousStatus,
    currentStatus: updatedPayment.status,
    changed: updatedPayment.status !== previousStatus,
    result: "unchanged",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return jsonResponse({ error: "Nao autorizado" }, 401);
    }

    const body = await readJson(req);
    const companyId = typeof body.company_id === "string" ? body.company_id : null;
    const force = body.force === true;
    const limit = clampNumber(body.limit, 25, 1, 60);
    const batchSize = clampNumber(body.batch_size, 5, 1, 10);
    const delayMs = clampNumber(body.delay_ms, 500, 0, 5000);
    const staleMinutes = clampNumber(body.stale_minutes, 30, 5, 24 * 60);
    const lookbackDays = clampNumber(body.lookback_days, 120, 1, 365);

    const supabaseAdmin = createSupabaseAdminClient();
    const now = new Date();
    const staleIso = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
    const lookbackIso = new Date(now.getTime() - lookbackDays * 24 * 60 * 60_000).toISOString();

    let query = supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .in("status", RECONCILE_STATUSES)
      .or("asaas_payment_id.not.is.null,payment_link_external_reference.not.is.null,asaas_payment_link_id.not.is.null")
      .or(`created_at.gte.${lookbackIso},paid_at.gte.${lookbackIso},cancelled_at.gte.${lookbackIso},expires_at.gte.${lookbackIso}`)
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (companyId) query = query.eq("company_id", companyId);

    if (!force) {
      query = query.or(`last_checked_at.is.null,last_checked_at.lt.${staleIso}`);
    }

    const { data: payments, error } = await query;
    if (error) throw new Error(error.message);

    const summary = {
      eligible_companies: new Set((payments ?? []).map((payment: any) => payment.company_id)).size,
      selected: payments?.length ?? 0,
      checked: 0,
      changed: 0,
      unchanged: 0,
      skipped_without_config: 0,
      failed: 0,
      rate_limited: false,
      results: [] as Array<{
        payment_id: string;
        previous_status: string;
        current_status: string | null;
        changed: boolean;
        result: string;
        error?: string;
      }>,
    };
    const apiTokenCache = new Map<string, Awaited<ReturnType<typeof getReservationAsaasCredentials>>>();

    for (const [index, payment] of (payments ?? []).entries()) {
      try {
        const metadata = getPaymentMetadata(payment);
        const scope = metadata.asaas_account_scope === "platform"
          ? `platform:${metadata.asaas_account_id}:${metadata.asaas_environment}`
          : payment.company_id;
        if (!apiTokenCache.has(scope)) {
          apiTokenCache.set(scope, await getReservationAsaasCredentials(supabaseAdmin, payment));
        }
        const apiToken = apiTokenCache.get(scope);
        if (!apiToken) {
          summary.skipped_without_config += 1;
          await recordReconciliationFailure(supabaseAdmin, payment, "Integracao Asaas nao configurada para conciliacao");
          continue;
        }

        const result = await refreshProviderPaymentState(supabaseAdmin, payment, apiToken);
        summary.checked += 1;
        if (result.changed) {
          summary.changed += 1;
        } else {
          summary.unchanged += 1;
        }
        summary.results.push({
          payment_id: payment.id,
          previous_status: result.previousStatus,
          current_status: result.currentStatus,
          changed: result.changed,
          result: result.result,
        });
      } catch (error: any) {
        if (error instanceof AsaasApiError && error.status === 429) {
          summary.rate_limited = true;
          summary.results.push({
            payment_id: payment.id,
            previous_status: payment.status,
            current_status: null,
            changed: false,
            result: "rate_limited",
            error: error.message,
          });
          break;
        }

        summary.failed += 1;
        const message = error?.message || "Erro ao reconciliar pagamento";
        await recordReconciliationFailure(supabaseAdmin, payment, message);
        summary.results.push({
          payment_id: payment.id,
          previous_status: payment.status,
          current_status: null,
          changed: false,
          result: "failed",
          error: message,
        });
      }

      if (delayMs > 0 && index < (payments?.length ?? 0) - 1 && (index + 1) % batchSize === 0) {
        await sleep(delayMs);
      }
    }

    return jsonResponse({ ok: true, summary });
  } catch (error: any) {
    console.error("reconcile-reservation-payments error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
