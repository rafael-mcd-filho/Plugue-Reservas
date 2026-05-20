import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  createAsaasPaymentLink,
  deleteAsaasPaymentLink,
  getAsaasPaymentLinkUrl,
  type AsaasBillingType,
  type AsaasPaymentLinkPayload,
} from "../_shared/asaas.ts";
import {
  buildPaymentLinkDescription,
  buildPaymentLinkExternalReference,
  buildPaymentLinkName,
  buildPaymentUrl,
  calculateMethodAmount,
  corsHeaders,
  getAvailableBillingTypes,
  getMaxInstallments,
  jsonResponse,
  paymentIsExpired,
  readJson,
  recordPaymentEvent,
  toPublicPaymentSummary,
} from "../_shared/reservation-payments.ts";

async function resolvePaymentContext(supabaseAdmin: any, paymentToken: string) {
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("reservation_payments")
    .select("*")
    .eq("payment_token", paymentToken)
    .maybeSingle();

  if (paymentError) throw new Error(paymentError.message);
  if (!payment) throw new Error("Pagamento nao encontrado");

  const [{ data: reservation, error: reservationError }, { data: company, error: companyError }] = await Promise.all([
    supabaseAdmin.from("reservations").select("*").eq("id", payment.reservation_id).maybeSingle(),
    supabaseAdmin.from("companies").select("id, name, slug, logo_url").eq("id", payment.company_id).maybeSingle(),
  ]);

  if (reservationError) throw new Error(reservationError.message);
  if (companyError) throw new Error(companyError.message);
  if (!reservation || !company) throw new Error("Dados da reserva nao encontrados");

  return { payment, reservation, company };
}

async function getAsaasConfig(supabaseAdmin: any, companyId: string) {
  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("api_token, status")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || data.status !== "configured") {
    throw new Error("Integracao Asaas nao configurada");
  }

  return data;
}

function getPaymentLinkPayload(
  payment: any,
  reservation: any,
  billingType: AsaasBillingType,
  chargedAmount: number,
  maxInstallments: number,
): AsaasPaymentLinkPayload {
  const isInstallmentCard = billingType === "CREDIT_CARD" && maxInstallments > 1;
  const payload: AsaasPaymentLinkPayload = {
    name: buildPaymentLinkName(payment, reservation, billingType),
    description: buildPaymentLinkDescription(payment, reservation),
    value: chargedAmount,
    billingType,
    chargeType: isInstallmentCard ? "INSTALLMENT" : "DETACHED",
    externalReference: buildPaymentLinkExternalReference(payment.payment_token, billingType),
    notificationEnabled: false,
    isAddressRequired: false,
    callback: {
      successUrl: buildPaymentUrl(payment.payment_token),
      autoRedirect: true,
    },
  };

  if (isInstallmentCard) {
    payload.maxInstallmentCount = maxInstallments;
  }

  return payload;
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
    const billingType = String(body.billing_type || "").toUpperCase() as AsaasBillingType;

    if (!paymentToken) return jsonResponse({ error: "Token do pagamento obrigatorio" }, 400);
    if (billingType !== "PIX" && billingType !== "CREDIT_CARD") {
      return jsonResponse({ error: "Metodo de pagamento invalido" }, 400);
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const { payment, reservation, company } = await resolvePaymentContext(supabaseAdmin, paymentToken);

    if (paymentIsExpired(payment)) {
      await supabaseAdmin.from("reservation_payments").update({
        status: "expired",
        error_details: "Prazo local expirado antes da escolha do metodo",
      }).eq("id", payment.id);
      await supabaseAdmin.from("reservations").update({ status: "payment_expired" }).eq("id", reservation.id);
      return jsonResponse({ error: "Prazo de pagamento expirado" }, 410);
    }

    if (payment.status === "pending") {
      if (payment.billing_type !== billingType) {
        return jsonResponse({ error: "Ja existe um link ativo com outro metodo" }, 409);
      }

      return jsonResponse(toPublicPaymentSummary(payment, reservation, company));
    }

    if (payment.status !== "awaiting_method") {
      return jsonResponse(toPublicPaymentSummary(payment, reservation, company));
    }

    const availableBillingTypes = getAvailableBillingTypes(payment);
    if (!availableBillingTypes.includes(billingType)) {
      return jsonResponse({ error: "Metodo nao habilitado para esta regra" }, 400);
    }

    const asaasConfig = await getAsaasConfig(supabaseAdmin, payment.company_id);
    const chargedAmount = calculateMethodAmount(payment, reservation, billingType);
    const maxInstallments = billingType === "CREDIT_CARD" ? getMaxInstallments(payment) : 1;
    const externalReference = buildPaymentLinkExternalReference(payment.payment_token, billingType);
    const asaasPaymentLink = await createAsaasPaymentLink(
      asaasConfig.api_token,
      getPaymentLinkPayload(payment, reservation, billingType, chargedAmount, maxInstallments),
    );
    const paymentLinkUrl = getAsaasPaymentLinkUrl(asaasPaymentLink);

    if (!paymentLinkUrl) {
      throw new Error("Asaas nao retornou URL do link de pagamento");
    }

    const { data: updatedPayment, error: updateError } = await supabaseAdmin
      .from("reservation_payments")
      .update({
        status: "pending",
        billing_type: billingType,
        charged_amount: chargedAmount,
        max_installments: maxInstallments,
        asaas_payment_link_id: asaasPaymentLink.id,
        payment_link_url: paymentLinkUrl,
        payment_link_external_reference: asaasPaymentLink.externalReference ?? externalReference,
        selected_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
        error_details: null,
      })
      .eq("id", payment.id)
      .eq("status", "awaiting_method")
      .select("*")
      .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    if (!updatedPayment) {
      try {
        await deleteAsaasPaymentLink(asaasConfig.api_token, asaasPaymentLink.id);
      } catch (deleteError) {
        console.warn("Failed to delete duplicate Asaas payment link", deleteError);
      }

      const { payment: currentPayment, reservation: currentReservation, company: currentCompany } =
        await resolvePaymentContext(supabaseAdmin, paymentToken);
      return jsonResponse(toPublicPaymentSummary(currentPayment, currentReservation, currentCompany));
    }

    await recordPaymentEvent(supabaseAdmin, updatedPayment, "payment_link_created", {
      billing_type: billingType,
      charged_amount: chargedAmount,
      max_installments: maxInstallments,
      asaas_payment_link_id: asaasPaymentLink.id,
      payment_link_external_reference: asaasPaymentLink.externalReference ?? externalReference,
    });

    return jsonResponse(toPublicPaymentSummary(updatedPayment, reservation, company));
  } catch (error: any) {
    console.error("select-reservation-payment-method error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
