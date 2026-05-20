import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  deleteAsaasPayment,
  deleteAsaasPaymentLink,
  getAsaasPaymentLink,
  getAsaasPaymentStatus,
  isAsaasPaidStatus,
} from "../_shared/asaas.ts";
import {
  confirmReservationPayment,
  corsHeaders,
  jsonResponse,
  paymentIsExpired,
  readJson,
  recordPaymentEvent,
  toPublicPaymentSummary,
} from "../_shared/reservation-payments.ts";

async function loadContext(supabaseAdmin: any, paymentToken: string) {
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("reservation_payments")
    .select("*")
    .eq("payment_token", paymentToken)
    .maybeSingle();

  if (paymentError) throw new Error(paymentError.message);
  if (!payment) throw new Error("Pagamento nao encontrado");

  const [{ data: reservation, error: reservationError }, { data: company, error: companyError }] = await Promise.all([
    supabaseAdmin.from("reservations").select("*").eq("id", payment.reservation_id).maybeSingle(),
    supabaseAdmin.from("companies").select("id, name, slug, logo_url, phone, whatsapp").eq("id", payment.company_id).maybeSingle(),
  ]);

  if (reservationError) throw new Error(reservationError.message);
  if (companyError) throw new Error(companyError.message);
  if (!reservation || !company) throw new Error("Dados da reserva nao encontrados");

  return { payment, reservation, company };
}

async function getApiToken(supabaseAdmin: any, companyId: string) {
  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("api_token, status")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || data.status !== "configured") throw new Error("Integracao Asaas nao configurada");
  return data.api_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const body = await readJson(req);
    const paymentToken = typeof body.payment_token === "string" ? body.payment_token : null;
    if (!paymentToken) return jsonResponse({ error: "Token do pagamento obrigatorio" }, 400);

    const supabaseAdmin = createSupabaseAdminClient();
    const { payment, reservation, company } = await loadContext(supabaseAdmin, paymentToken);

    if (payment.status === "awaiting_method") {
      return jsonResponse({
        ...toPublicPaymentSummary(payment, reservation, company),
        message: "Escolha Pix ou cartao antes de consultar o pagamento",
      });
    }

    if (payment.status !== "pending") {
      return jsonResponse(toPublicPaymentSummary(payment, reservation, company));
    }

    const apiToken = await getApiToken(supabaseAdmin, payment.company_id);

    if (paymentIsExpired(payment)) {
      let asaasStatus: string | null = null;
      if (payment.asaas_payment_id) {
        asaasStatus = await getAsaasPaymentStatus(apiToken, payment.asaas_payment_id);
        if (isAsaasPaidStatus(asaasStatus)) {
          const confirmation = await confirmReservationPayment(supabaseAdmin, payment, asaasStatus, "manual_check");
          const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
            await loadContext(supabaseAdmin, paymentToken);
          return jsonResponse({
            ...toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany),
            confirmation,
          });
        }
      }

      if (payment.asaas_payment_link_id) {
        try {
          await deleteAsaasPaymentLink(apiToken, payment.asaas_payment_link_id);
        } catch (error) {
          console.warn("Failed to delete expired Asaas payment link during manual check", error);
        }
      }

      if (payment.asaas_payment_id) {
        try {
          await deleteAsaasPayment(apiToken, payment.asaas_payment_id);
        } catch (error) {
          console.warn("Failed to delete expired Asaas payment during manual check", error);
        }
      }

      const deletedAt = new Date().toISOString();
      const { data: expiredPayment, error: updateError } = await supabaseAdmin
        .from("reservation_payments")
        .update({
          status: "expired",
          asaas_status: asaasStatus,
          cancelled_at: deletedAt,
          payment_link_deleted_at: payment.asaas_payment_link_id ? deletedAt : payment.payment_link_deleted_at,
          last_checked_at: deletedAt,
          error_details: null,
        })
        .eq("id", payment.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message);

      await supabaseAdmin.from("reservations").update({ status: "payment_expired" }).eq("id", reservation.id);
      await recordPaymentEvent(supabaseAdmin, payment, "payment_expired", { source: "manual_check", asaas_status: asaasStatus });

      return jsonResponse(toPublicPaymentSummary(expiredPayment, { ...reservation, status: "payment_expired" }, company));
    }

    if (!payment.asaas_payment_id) {
      if (payment.asaas_payment_link_id) {
        try {
          await getAsaasPaymentLink(apiToken, payment.asaas_payment_link_id);
        } catch (error) {
          console.warn("Failed to retrieve Asaas payment link during manual check", error);
        }
      }

      return jsonResponse({
        ...toPublicPaymentSummary(payment, reservation, company),
        message: "Ainda aguardando o Asaas gerar ou avisar a cobranca deste link",
      });
    }

    const asaasStatus = await getAsaasPaymentStatus(apiToken, payment.asaas_payment_id);

    if (isAsaasPaidStatus(asaasStatus)) {
      const confirmation = await confirmReservationPayment(supabaseAdmin, payment, asaasStatus, "manual_check");
      const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } = await loadContext(
        supabaseAdmin,
        paymentToken,
      );
      return jsonResponse({
        ...toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany),
        confirmation,
      });
    }

    const { data: updatedPayment, error: updateError } = await supabaseAdmin
      .from("reservation_payments")
      .update({
        asaas_status: asaasStatus,
        last_checked_at: new Date().toISOString(),
      })
      .eq("id", payment.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);

    return jsonResponse(toPublicPaymentSummary(updatedPayment, reservation, company));
  } catch (error: any) {
    console.error("check-reservation-payment error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
