import { synchronizeReservationSettlement } from "../_shared/reservation-settlement-sync.ts";
import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import { getReservationAsaasCredentials } from "../_shared/reservation-asaas-config.ts";
import {
  AsaasApiError,
  getAsaasActiveChargebackStatus,
  getAsaasExternalPaymentOutcome,
  getAsaasPayment,
  getAsaasRefundedValue,
  refundAsaasPayment,
} from "../_shared/asaas.ts";
import {
  corsHeaders,
  jsonResponse,
  markReservationPaymentProviderOutcome,
  readJson,
  recordPaymentEvent,
  toPublicPaymentSummary,
} from "../_shared/reservation-payments.ts";

async function loadPaymentContext(supabaseAdmin: any, companyId: string, paymentToken: string) {
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("reservation_payments")
    .select("*")
    .eq("company_id", companyId)
    .eq("payment_token", paymentToken)
    .maybeSingle();

  if (paymentError) throw new Error(paymentError.message);
  if (!payment) throw new Error("Pagamento não encontrado");

  const [{ data: reservation, error: reservationError }, { data: company, error: companyError }] = await Promise.all([
    supabaseAdmin.from("reservations").select("*").eq("id", payment.reservation_id).eq("company_id", payment.company_id).maybeSingle(),
    supabaseAdmin.from("companies").select("id, name, slug, logo_url, phone, whatsapp").eq("id", payment.company_id).maybeSingle(),
  ]);

  if (reservationError) throw new Error(reservationError.message);
  if (companyError) throw new Error(companyError.message);
  if (!reservation || !company) throw new Error("Dados da reserva não encontrados");

  return { payment, reservation, company };
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
    const companyId = typeof body.company_id === "string" ? body.company_id : null;
    const paymentToken = typeof body.payment_token === "string" ? body.payment_token : null;
    const description = typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 255)
      : "Estorno solicitado pelo painel Plug Guest";
    const requestedValue = Number(body.value ?? 0);

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);
    if (!paymentToken) return jsonResponse({ error: "Token do pagamento obrigatorio" }, 400);

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, ["admin"]);
    const { payment, reservation, company } = await loadPaymentContext(supabaseAdmin, companyId, paymentToken);

    if (body.value !== undefined && (
      typeof body.value !== "number" || !Number.isFinite(requestedValue) || requestedValue <= 0
      || Math.abs(requestedValue * 100 - Math.round(requestedValue * 100)) > 0.000001
      || requestedValue > Number(payment.charged_amount ?? payment.base_amount)
    )) {
      return jsonResponse({ error: "Informe um valor de estorno positivo, em centavos, que nao ultrapasse a cobranca." }, 400);
    }

    if (!["paid", "late_paid"].includes(payment.status)) {
      return jsonResponse({ error: "Somente pagamentos recebidos podem ser estornados pelo sistema" }, 409);
    }
    if (!payment.asaas_payment_id) {
      return jsonResponse({ error: "Pagamento sem identificador Asaas" }, 409);
    }

    const apiToken = await getReservationAsaasCredentials(supabaseAdmin, payment);
    // The saved ID may identify just one installment. Refunding that ID alone
    // must never be presented as a refund of the complete reservation amount.
    const providerPayment = await getAsaasPayment(apiToken, payment.asaas_payment_id);
    if (providerPayment.installment) {
      return jsonResponse({
        error: "Este pagamento e parcelado. Estorne o parcelamento completo no painel Asaas e confira todas as parcelas antes de concluir a conciliacao.",
        code: "INSTALLMENT_REFUND_REQUIRES_ASAAS",
      }, 409);
    }
    const refundPayload = Number.isFinite(requestedValue) && requestedValue > 0
      ? { value: requestedValue, description }
      : { description };

    const refundRequestId = crypto.randomUUID();
    const requestedAt = new Date().toISOString();
    const refundRequest = {
      id: refundRequestId,
      requested_at: requestedAt,
      previous_status: payment.status,
      value: refundPayload.value ?? null,
      description,
      result: "submitting",
    };
    // Claim the original version before any irreversible provider request.
    // A second submission or concurrent webhook makes this CAS lose safely.
    const { data: claimedPayment, error: claimError } = await supabaseAdmin.from("reservation_payments")
      .update({
        status: "refund_pending",
        error_details: "Solicitacao de estorno em processamento; nao repita a solicitacao",
        metadata: { ...payment.metadata, refund_request_id: refundRequestId, refund_request: refundRequest },
      })
      .eq("id", payment.id).eq("company_id", companyId).eq("status", payment.status)
      .eq("updated_at", payment.updated_at).select("*").maybeSingle();
    if (claimError) throw new Error(claimError.message);
    if (!claimedPayment) {
      return jsonResponse({ error: "Este pagamento mudou ou ja possui estorno em processamento. Atualize o painel antes de continuar.",
        code: "REFUND_ALREADY_CLAIMED" }, 409);
    }
    await recordPaymentEvent(supabaseAdmin, claimedPayment, "payment_refund_requested", {
      refund_request_id: refundRequestId, requested_value: refundPayload.value ?? null, description,
    });

    try {
      await refundAsaasPayment(apiToken, payment.asaas_payment_id, refundPayload);
    } catch (providerError: any) {
      const definitive = providerError instanceof AsaasApiError
        && providerError.status >= 400 && providerError.status < 500
        && ![408, 409, 425, 429].includes(providerError.status);
      const uncertainMessage = "Resposta do Asaas inconclusiva. Nao repita o estorno; aguarde a conciliacao ou confira o pagamento no Asaas.";
      const result = definitive ? "rejected" : "uncertain";
      const { error: finishError } = await supabaseAdmin.from("reservation_payments").update({
        status: definitive ? payment.status : "refund_pending",
        error_details: definitive ? providerError.message : uncertainMessage,
        metadata: { ...claimedPayment.metadata, refund_request: { ...refundRequest, result,
          finished_at: new Date().toISOString(), provider_error: providerError?.message ?? "Resposta inconclusiva" } },
      }).eq("id", payment.id).eq("company_id", companyId).eq("status", "refund_pending")
        .eq("metadata->>refund_request_id", refundRequestId).eq("updated_at", claimedPayment.updated_at);
      // A webhook may have already completed the refund. Never restore the
      // previous status after a different writer has updated this claim.
      if (finishError) console.error("Failed to finalize reservation refund request", finishError);
      await recordPaymentEvent(supabaseAdmin, claimedPayment, definitive ? "payment_refund_rejected" : "payment_refund_uncertain", {
        refund_request_id: refundRequestId, provider_status: providerError?.status ?? null,
        provider_error: providerError?.message ?? "Resposta inconclusiva",
      });
      if (!definitive || finishError) {
        return jsonResponse({ error: uncertainMessage, code: "REFUND_RESULT_UNCERTAIN", refund_request_id: refundRequestId }, 502);
      }
      return jsonResponse({ error: providerError.message, code: "REFUND_REJECTED", refund_request_id: refundRequestId },
        providerError.status === 400 || providerError.status === 422 ? 400 : 502);
    }

    let asaasPayment = null;
    try {
      asaasPayment = await getAsaasPayment(apiToken, payment.asaas_payment_id);
    } catch (error) {
      console.warn("Failed to retrieve Asaas payment after refund", error);
    }

    const outcome = getAsaasExternalPaymentOutcome("PAYMENT_REFUND_IN_PROGRESS", asaasPayment?.status ?? null, asaasPayment);
    await markReservationPaymentProviderOutcome(supabaseAdmin, claimedPayment, outcome ?? "refund_pending", {
      source: "manual_refund",
      asaasStatus: asaasPayment?.status ?? "PAYMENT_REFUND_IN_PROGRESS",
      eventType: "PAYMENT_REFUND_IN_PROGRESS",
      metadata: {
        description,
        requested_value: Number.isFinite(requestedValue) && requestedValue > 0 ? requestedValue : null,
        provider_payment_status: asaasPayment?.status ?? null,
        refunded_value: getAsaasRefundedValue(asaasPayment),
        chargeback_status: getAsaasActiveChargebackStatus(asaasPayment),
      },
    });

    const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
      await loadPaymentContext(supabaseAdmin, companyId, paymentToken);

    await synchronizeReservationSettlement(supabaseAdmin, refreshedPayment, "manual_refund");

    return jsonResponse({
      ...toPublicPaymentSummary(refreshedPayment, refreshedReservation ?? reservation, refreshedCompany ?? company),
      message: "Estorno solicitado no Asaas.",
    });
  } catch (error: any) {
    const message = error?.message || "Erro interno";
    return jsonResponse({ error: message }, message === "Nao autorizado" || message === "Não autorizado" ? 401 : 500);
  }
});
