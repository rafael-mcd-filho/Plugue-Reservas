import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  deleteAsaasPayment,
  deleteAsaasPaymentLink,
  getAsaasActiveChargebackStatus,
  getAsaasExternalPaymentOutcome,
  getAsaasPayment,
  getAsaasRefundedValue,
  getAsaasPaymentLink,
  getAsaasPaymentStatus,
  isAsaasPaidStatus,
  listAsaasPayments,
} from "../_shared/asaas.ts";
import {
  buildPaymentLinkExternalReference,
  confirmReservationPayment,
  corsHeaders,
  jsonResponse,
  markReservationPaymentProviderOutcome,
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

async function getAsaasPaymentSnapshot(apiToken: string, paymentId: string) {
  const asaasStatus = await getAsaasPaymentStatus(apiToken, paymentId);
  let asaasPayment = null;

  try {
    asaasPayment = await getAsaasPayment(apiToken, paymentId);
  } catch (error) {
    console.warn("Failed to retrieve full Asaas payment during manual check", error);
  }

  return {
    asaasStatus: asaasPayment?.status ?? asaasStatus,
    asaasPayment,
    chargebackStatus: getAsaasActiveChargebackStatus(asaasPayment),
  };
}

async function attachAsaasPaymentIdFromExternalReference(supabaseAdmin: any, payment: any, apiToken: string) {
  if (payment.asaas_payment_id) return payment;

  const externalReference = payment.payment_link_external_reference
    ?? (payment.billing_type ? buildPaymentLinkExternalReference(payment.payment_token, payment.billing_type) : null);
  if (!externalReference) return payment;

  try {
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
  } catch (error) {
    console.warn("Failed to attach Asaas payment by external reference", error);
    return payment;
  }
}

async function refreshProviderPaymentState(
  supabaseAdmin: any,
  payment: any,
  apiToken: string,
) {
  payment = await attachAsaasPaymentIdFromExternalReference(supabaseAdmin, payment, apiToken);

  if (!payment.asaas_payment_id) {
    return { payment, asaasStatus: payment.asaas_status as string | null };
  }

  const { asaasStatus, asaasPayment, chargebackStatus } = await getAsaasPaymentSnapshot(
    apiToken,
    payment.asaas_payment_id,
  );
  const outcome = getAsaasExternalPaymentOutcome(null, asaasStatus, asaasPayment);

  if (outcome) {
    const updatedPayment = await markReservationPaymentProviderOutcome(supabaseAdmin, payment, outcome, {
      source: "manual_check",
      asaasStatus,
      metadata: {
        provider_payment_status: asaasPayment?.status ?? null,
        chargeback_status: chargebackStatus,
        refunded_value: getAsaasRefundedValue(asaasPayment),
      },
    });

    return { payment: updatedPayment, asaasStatus };
  }

  if (
    isAsaasPaidStatus(asaasStatus)
    && ![
      "paid",
      "late_paid",
      "refunded",
      "partial_refunded",
      "refund_pending",
      "refund_denied",
      "chargeback",
      "cancelled",
    ].includes(payment.status)
  ) {
    await confirmReservationPayment(supabaseAdmin, payment, asaasStatus, "manual_check");
    const { data: refreshedPayment, error: refreshError } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("id", payment.id)
      .single();

    if (refreshError) throw new Error(refreshError.message);
    return { payment: refreshedPayment, asaasStatus };
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

  return { payment: updatedPayment, asaasStatus };
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
      if (paymentIsExpired(payment)) {
        const nowIso = new Date().toISOString();
        const { data: expiredPayment, error: expireError } = await supabaseAdmin
          .from("reservation_payments")
          .update({
            status: "expired",
            error_details: "Prazo expirado sem escolha de metodo",
            cancelled_at: nowIso,
            last_checked_at: nowIso,
          })
          .eq("id", payment.id)
          .eq("status", "awaiting_method")
          .select("*")
          .maybeSingle();

        if (expireError) throw new Error(expireError.message);

        if (!expiredPayment) {
          const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
            await loadContext(supabaseAdmin, paymentToken);
          return jsonResponse(toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany));
        }

        const { error: reservationExpireError } = await supabaseAdmin
          .from("reservations")
          .update({ status: "payment_expired" })
          .eq("id", reservation.id)
          .eq("status", "pending_payment");
        if (reservationExpireError) throw new Error(reservationExpireError.message);

        await recordPaymentEvent(supabaseAdmin, payment, "payment_expired", {
          source: "manual_check",
          reason: "awaiting_method",
        });

        return jsonResponse(
          toPublicPaymentSummary(expiredPayment, { ...reservation, status: "payment_expired" }, company),
        );
      }

      return jsonResponse({
        ...toPublicPaymentSummary(payment, reservation, company),
        message: "Escolha Pix ou cartao antes de consultar o pagamento",
      });
    }

    if (payment.status !== "pending") {
      const apiToken = await getApiToken(supabaseAdmin, payment.company_id);
      await refreshProviderPaymentState(supabaseAdmin, payment, apiToken);
      const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
        await loadContext(supabaseAdmin, paymentToken);

      return jsonResponse(toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany));
    }

    const apiToken = await getApiToken(supabaseAdmin, payment.company_id);
    const providerLinkedPayment = await attachAsaasPaymentIdFromExternalReference(supabaseAdmin, payment, apiToken);

    if (paymentIsExpired(providerLinkedPayment)) {
      let asaasStatus: string | null = null;
      if (providerLinkedPayment.asaas_payment_id) {
        const snapshot = await getAsaasPaymentSnapshot(apiToken, providerLinkedPayment.asaas_payment_id);
        asaasStatus = snapshot.asaasStatus;
        const providerOutcome = getAsaasExternalPaymentOutcome(null, asaasStatus, snapshot.asaasPayment);

        if (providerOutcome) {
          await markReservationPaymentProviderOutcome(supabaseAdmin, providerLinkedPayment, providerOutcome, {
            source: "manual_check",
            asaasStatus,
            metadata: {
              provider_payment_status: snapshot.asaasPayment?.status ?? null,
              chargeback_status: snapshot.chargebackStatus,
              refunded_value: getAsaasRefundedValue(snapshot.asaasPayment),
            },
          });
          const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
            await loadContext(supabaseAdmin, paymentToken);
          return jsonResponse(toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany));
        }

        if (isAsaasPaidStatus(asaasStatus)) {
          const confirmation = await confirmReservationPayment(supabaseAdmin, providerLinkedPayment, asaasStatus, "manual_check");
          const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
            await loadContext(supabaseAdmin, paymentToken);
          return jsonResponse({
            ...toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany),
            confirmation,
          });
        }
      }

      const deletedAt = new Date().toISOString();
      const { data: expiredPayment, error: updateError } = await supabaseAdmin
        .from("reservation_payments")
        .update({
          status: "expired",
          asaas_status: asaasStatus,
          cancelled_at: deletedAt,
          last_checked_at: deletedAt,
          error_details: null,
        })
        .eq("id", providerLinkedPayment.id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();
      if (updateError) throw new Error(updateError.message);

      if (!expiredPayment) {
        const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
          await loadContext(supabaseAdmin, paymentToken);
        return jsonResponse(toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany));
      }

      const { error: reservationExpireError } = await supabaseAdmin
        .from("reservations")
        .update({ status: "payment_expired" })
        .eq("id", reservation.id)
        .eq("status", "pending_payment");
      if (reservationExpireError) throw new Error(reservationExpireError.message);

      await recordPaymentEvent(supabaseAdmin, providerLinkedPayment, "payment_expired", {
        source: "manual_check",
        asaas_status: asaasStatus,
      });

      if (providerLinkedPayment.asaas_payment_link_id) {
        try {
          await deleteAsaasPaymentLink(apiToken, providerLinkedPayment.asaas_payment_link_id);
          const { error: deletedLinkError } = await supabaseAdmin
            .from("reservation_payments")
            .update({ payment_link_deleted_at: deletedAt })
            .eq("id", providerLinkedPayment.id)
            .eq("status", "expired");
          if (deletedLinkError) throw new Error(deletedLinkError.message);
        } catch (error) {
          console.warn("Failed to delete expired Asaas payment link during manual check", error);
        }
      }

      if (providerLinkedPayment.asaas_payment_id) {
        try {
          await deleteAsaasPayment(apiToken, providerLinkedPayment.asaas_payment_id);
        } catch (error) {
          console.warn("Failed to delete expired Asaas payment during manual check", error);
        }
      }

      return jsonResponse(toPublicPaymentSummary(expiredPayment, { ...reservation, status: "payment_expired" }, company));
    }

    if (!providerLinkedPayment.asaas_payment_id) {
      if (providerLinkedPayment.asaas_payment_link_id) {
        try {
          await getAsaasPaymentLink(apiToken, providerLinkedPayment.asaas_payment_link_id);
        } catch (error) {
          console.warn("Failed to retrieve Asaas payment link during manual check", error);
        }
      }

      return jsonResponse({
        ...toPublicPaymentSummary(providerLinkedPayment, reservation, company),
        message: "Ainda nao recebemos a confirmacao do pagamento",
      });
    }

    const { asaasStatus, asaasPayment, chargebackStatus } = await getAsaasPaymentSnapshot(
      apiToken,
      providerLinkedPayment.asaas_payment_id,
    );
    const providerOutcome = getAsaasExternalPaymentOutcome(null, asaasStatus, asaasPayment);

    if (providerOutcome) {
      await markReservationPaymentProviderOutcome(supabaseAdmin, providerLinkedPayment, providerOutcome, {
        source: "manual_check",
        asaasStatus,
        metadata: {
          provider_payment_status: asaasPayment?.status ?? null,
          chargeback_status: chargebackStatus,
          refunded_value: getAsaasRefundedValue(asaasPayment),
        },
      });
      const { payment: refreshedPayment, reservation: refreshedReservation, company: refreshedCompany } =
        await loadContext(supabaseAdmin, paymentToken);
      return jsonResponse(toPublicPaymentSummary(refreshedPayment, refreshedReservation, refreshedCompany));
    }

    if (isAsaasPaidStatus(asaasStatus)) {
      const confirmation = await confirmReservationPayment(supabaseAdmin, providerLinkedPayment, asaasStatus, "manual_check");
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
      .eq("id", providerLinkedPayment.id)
      .select("*")
      .single();
    if (updateError) throw new Error(updateError.message);

    return jsonResponse(toPublicPaymentSummary(updatedPayment, reservation, company));
  } catch (error: any) {
    console.error("check-reservation-payment error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
