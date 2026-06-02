import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { deleteAsaasPayment, deleteAsaasPaymentLink, getAsaasPaymentStatus, isAsaasPaidStatus } from "../_shared/asaas.ts";
import {
  confirmReservationPayment,
  corsHeaders,
  jsonResponse,
  recordPaymentEvent,
} from "../_shared/reservation-payments.ts";

async function getApiToken(supabaseAdmin: any, companyId: string) {
  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("api_token, status")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || data.status !== "configured") return null;
  return data.api_token as string;
}

async function recordRetryableFailure(
  supabaseAdmin: any,
  paymentId: string,
  now: string,
  message: string,
) {
  const { error } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      error_details: message,
      last_checked_at: now,
    })
    .eq("id", paymentId)
    .in("status", ["awaiting_method", "pending"]);

  if (error) {
    console.error("Failed to record retryable reservation payment expiration error", paymentId, error);
  }
}

async function expirePaymentLocally(
  supabaseAdmin: any,
  payment: any,
  now: string,
  changes: Record<string, unknown>,
  eventPayload: Record<string, unknown>,
) {
  const { data: expiredPayment, error: paymentError } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      status: "expired",
      cancelled_at: now,
      last_checked_at: now,
      ...changes,
    })
    .eq("id", payment.id)
    .eq("status", payment.status)
    .select("id")
    .maybeSingle();

  if (paymentError) throw new Error(paymentError.message);
  if (!expiredPayment) return false;

  const { error: reservationError } = await supabaseAdmin
    .from("reservations")
    .update({
      status: "payment_expired",
      updated_at: now,
    })
    .eq("id", payment.reservation_id)
    .eq("status", "pending_payment");

  if (reservationError) throw new Error(reservationError.message);

  await recordPaymentEvent(supabaseAdmin, payment, "payment_expired", eventPayload);
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return jsonResponse({ error: "Nao autorizado" }, 401);
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data: payments, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .in("status", ["awaiting_method", "pending"])
      .lte("expires_at", now)
      .order("expires_at", { ascending: true })
      .limit(50);

    if (error) throw new Error(error.message);

    const summary = {
      checked: payments?.length ?? 0,
      expired_without_charge: 0,
      expired_cancelled_in_asaas: 0,
      confirmed: 0,
      failed: 0,
    };

    for (const payment of payments ?? []) {
      try {
        if (payment.status === "awaiting_method") {
          const expired = await expirePaymentLocally(
            supabaseAdmin,
            payment,
            now,
            { error_details: "Prazo expirado sem link Asaas ativo" },
            {
              source: "expire_job",
              reason: "awaiting_method",
            },
          );
          if (expired) summary.expired_without_charge += 1;
          continue;
        }

        const apiToken = await getApiToken(supabaseAdmin, payment.company_id);
        if (!apiToken) {
          await recordRetryableFailure(
            supabaseAdmin,
            payment.id,
            now,
            "Integracao Asaas nao configurada ao expirar pagamento",
          );
          summary.failed += 1;
          continue;
        }

        let asaasStatus: string | null = null;
        if (payment.asaas_payment_id) {
          asaasStatus = await getAsaasPaymentStatus(apiToken, payment.asaas_payment_id);
          if (isAsaasPaidStatus(asaasStatus)) {
            await confirmReservationPayment(supabaseAdmin, payment, asaasStatus, "expire_job");
            summary.confirmed += 1;
            continue;
          }
        }

        const expired = await expirePaymentLocally(
          supabaseAdmin,
          payment,
          now,
          {
            asaas_status: asaasStatus,
            error_details: null,
          },
          {
            source: "expire_job",
            asaas_status: asaasStatus,
          },
        );
        if (!expired) continue;

        if (payment.asaas_payment_link_id) {
          try {
            await deleteAsaasPaymentLink(apiToken, payment.asaas_payment_link_id);
            const { error: deletedLinkError } = await supabaseAdmin
              .from("reservation_payments")
              .update({ payment_link_deleted_at: now })
              .eq("id", payment.id)
              .eq("status", "expired");
            if (deletedLinkError) throw new Error(deletedLinkError.message);
          } catch (deleteLinkError) {
            console.warn("Failed to delete Asaas payment link during expiration", deleteLinkError);
          }
        }

        if (payment.asaas_payment_id) {
          try {
            await deleteAsaasPayment(apiToken, payment.asaas_payment_id);
          } catch (deleteError) {
            console.warn("Failed to delete Asaas payment during expiration", deleteError);
          }
        }

        summary.expired_cancelled_in_asaas += 1;
      } catch (paymentError: any) {
        console.error("Failed to expire reservation payment", payment.id, paymentError);
        await recordRetryableFailure(
          supabaseAdmin,
          payment.id,
          now,
          paymentError?.message || "Erro ao expirar pagamento",
        );
        summary.failed += 1;
      }
    }

    return jsonResponse({ ok: true, summary });
  } catch (error: any) {
    console.error("expire-reservation-payments error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
