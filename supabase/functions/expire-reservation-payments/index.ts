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
          await supabaseAdmin.from("reservation_payments").update({
            status: "expired",
            error_details: "Prazo expirado sem link Asaas ativo",
            cancelled_at: now,
          }).eq("id", payment.id);

          await supabaseAdmin.from("reservations").update({
            status: "payment_expired",
            updated_at: now,
          }).eq("id", payment.reservation_id);

          await recordPaymentEvent(supabaseAdmin, payment, "payment_expired", {
            source: "expire_job",
            reason: "awaiting_method",
          });
          summary.expired_without_charge += 1;
          continue;
        }

        const apiToken = await getApiToken(supabaseAdmin, payment.company_id);
        if (!apiToken) {
          await supabaseAdmin.from("reservation_payments").update({
            status: "failed",
            error_details: "Integracao Asaas nao configurada ao expirar pagamento",
            last_checked_at: now,
          }).eq("id", payment.id);
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

        if (payment.asaas_payment_link_id) {
          try {
            await deleteAsaasPaymentLink(apiToken, payment.asaas_payment_link_id);
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

        await supabaseAdmin.from("reservation_payments").update({
          status: "expired",
          asaas_status: asaasStatus,
          cancelled_at: now,
          payment_link_deleted_at: payment.asaas_payment_link_id ? now : payment.payment_link_deleted_at,
          last_checked_at: now,
          error_details: null,
        }).eq("id", payment.id);

        await supabaseAdmin.from("reservations").update({
          status: "payment_expired",
          updated_at: now,
        }).eq("id", payment.reservation_id);

        await recordPaymentEvent(supabaseAdmin, payment, "payment_expired", {
          source: "expire_job",
          asaas_status: asaasStatus,
        });

        summary.expired_cancelled_in_asaas += 1;
      } catch (paymentError: any) {
        console.error("Failed to expire reservation payment", payment.id, paymentError);
        await supabaseAdmin.from("reservation_payments").update({
          status: "failed",
          error_details: paymentError?.message || "Erro ao expirar pagamento",
          last_checked_at: now,
        }).eq("id", payment.id);
        summary.failed += 1;
      }
    }

    return jsonResponse({ ok: true, summary });
  } catch (error: any) {
    console.error("expire-reservation-payments error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
