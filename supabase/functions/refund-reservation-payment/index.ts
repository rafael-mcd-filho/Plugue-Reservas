import { assertUserCanAccessCompany } from "../_shared/internal-auth.ts";
import {
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
    supabaseAdmin.from("reservations").select("*").eq("id", payment.reservation_id).maybeSingle(),
    supabaseAdmin.from("companies").select("id, name, slug, logo_url, phone, whatsapp").eq("id", payment.company_id).maybeSingle(),
  ]);

  if (reservationError) throw new Error(reservationError.message);
  if (companyError) throw new Error(companyError.message);
  if (!reservation || !company) throw new Error("Dados da reserva não encontrados");

  return { payment, reservation, company };
}

async function getApiToken(supabaseAdmin: any, companyId: string) {
  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("api_token, status")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || data.status !== "configured") throw new Error("Integração Asaas não configurada");
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
    const companyId = typeof body.company_id === "string" ? body.company_id : null;
    const paymentToken = typeof body.payment_token === "string" ? body.payment_token : null;
    const description = typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, 255)
      : "Estorno solicitado pelo painel Plugue Guest";
    const requestedValue = Number(body.value ?? 0);

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);
    if (!paymentToken) return jsonResponse({ error: "Token do pagamento obrigatorio" }, 400);

    const { supabaseAdmin } = await assertUserCanAccessCompany(req, companyId, ["admin"]);
    const { payment, reservation, company } = await loadPaymentContext(supabaseAdmin, companyId, paymentToken);

    if (!["paid", "late_paid"].includes(payment.status)) {
      return jsonResponse({ error: "Somente pagamentos recebidos podem ser estornados pelo sistema" }, 409);
    }
    if (!payment.asaas_payment_id) {
      return jsonResponse({ error: "Pagamento sem identificador Asaas" }, 409);
    }

    const apiToken = await getApiToken(supabaseAdmin, companyId);
    const refundPayload = Number.isFinite(requestedValue) && requestedValue > 0
      ? { value: requestedValue, description }
      : { description };

    await refundAsaasPayment(apiToken, payment.asaas_payment_id, refundPayload);

    let asaasPayment = null;
    try {
      asaasPayment = await getAsaasPayment(apiToken, payment.asaas_payment_id);
    } catch (error) {
      console.warn("Failed to retrieve Asaas payment after refund", error);
    }

    const outcome = getAsaasExternalPaymentOutcome("PAYMENT_REFUND_IN_PROGRESS", asaasPayment?.status ?? null, asaasPayment);
    await markReservationPaymentProviderOutcome(supabaseAdmin, payment, outcome ?? "refund_pending", {
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

    return jsonResponse({
      ...toPublicPaymentSummary(refreshedPayment, refreshedReservation ?? reservation, refreshedCompany ?? company),
      message: "Estorno solicitado no Asaas.",
    });
  } catch (error: any) {
    const message = error?.message || "Erro interno";
    return jsonResponse({ error: message }, message === "Nao autorizado" || message === "Não autorizado" ? 401 : 500);
  }
});
