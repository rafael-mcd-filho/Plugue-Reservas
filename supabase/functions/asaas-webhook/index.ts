import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  getAsaasActiveChargebackStatus,
  getAsaasExternalPaymentOutcome,
  getAsaasRefundedValue,
  isAsaasPaidStatus,
  isAsaasPaymentApprovalEvent,
} from "../_shared/asaas.ts";
import {
  confirmReservationPayment,
  corsHeaders,
  jsonResponse,
  markReservationPaymentProviderOutcome,
  providerTimestampHasExplicitTime,
  readJson,
  recordPaymentEvent,
} from "../_shared/reservation-payments.ts";

function getAsaasPaymentId(body: any) {
  if (typeof body.payment?.id === "string") return body.payment.id;
  if (typeof body.paymentId === "string") return body.paymentId;
  if (typeof body.payment_id === "string") return body.payment_id;
  return null;
}

function getAsaasPaymentLinkId(body: any) {
  if (typeof body.payment?.paymentLink === "string") return body.payment.paymentLink;
  if (typeof body.paymentLink === "string") return body.paymentLink;
  if (typeof body.paymentLinkId === "string") return body.paymentLinkId;
  if (typeof body.payment_link_id === "string") return body.payment_link_id;
  return null;
}

function buildEventId(body: any, eventType: string, asaasPaymentId: string | null, asaasPaymentLinkId: string | null) {
  const explicitId = body.id ?? body.eventId ?? body.event_id;
  if (explicitId) return String(explicitId);

  const eventDate = body.dateCreated ?? body.createdAt ?? body.payment?.dateCreated ?? body.payment?.clientPaymentDate ?? "";
  return `${eventType || "unknown"}:${asaasPaymentId || asaasPaymentLinkId || "unknown"}:${eventDate || "no-date"}`;
}

function getAsaasPaidAt(body: any) {
  const candidates = [
    body.payment?.confirmedDate,
    body.payment?.clientPaymentDate,
    body.payment?.paymentDate,
  ].filter((value) => typeof value === "string" && value.trim());

  const preciseValue = candidates.find(providerTimestampHasExplicitTime);
  if (preciseValue) return preciseValue;

  return body.payment?.clientPaymentDate
    ?? body.payment?.paymentDate
    ?? body.payment?.confirmedDate
    ?? null;
}

async function validateWebhookToken(supabaseAdmin: any, providedToken: string | null, companyId: string | null) {
  const globalToken = Deno.env.get("ASAAS_WEBHOOK_AUTH_TOKEN") || Deno.env.get("ASAAS_WEBHOOK_TOKEN");
  if (globalToken && providedToken === globalToken) return true;
  if (!companyId) return false;

  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("webhook_auth_token")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.webhook_auth_token && providedToken === data.webhook_auth_token);
}

async function findReservationPayment(supabaseAdmin: any, asaasPaymentId: string | null, asaasPaymentLinkId: string | null) {
  if (asaasPaymentId) {
    const { data, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("asaas_payment_id", asaasPaymentId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (data) return data;
  }

  if (asaasPaymentLinkId) {
    const { data, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("asaas_payment_link_id", asaasPaymentLinkId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (data) return data;
  }

  return null;
}

async function attachGeneratedPaymentId(supabaseAdmin: any, payment: any, asaasPaymentId: string | null, asaasStatus: string | null) {
  if (!asaasPaymentId || payment.asaas_payment_id === asaasPaymentId) return payment;

  const { data, error } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      asaas_payment_id: asaasPaymentId,
      asaas_status: asaasStatus ?? payment.asaas_status,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const url = new URL(req.url);
    const requestedCompanyId = url.searchParams.get("company_id");
    const body = await readJson(req);
    const eventType = String(body.event || body.eventType || "").toUpperCase();
    const asaasPaymentId = getAsaasPaymentId(body);
    const asaasPaymentLinkId = getAsaasPaymentLinkId(body);
    const asaasStatus = typeof body.payment?.status === "string" ? body.payment.status : null;
    const eventId = buildEventId(body, eventType, asaasPaymentId, asaasPaymentLinkId);
    const providedToken = req.headers.get("asaas-access-token");
    const supabaseAdmin = createSupabaseAdminClient();

    let payment = await findReservationPayment(supabaseAdmin, asaasPaymentId, asaasPaymentLinkId);
    if (payment?.company_id && requestedCompanyId && payment.company_id !== requestedCompanyId) {
      return jsonResponse({ error: "Company mismatch" }, 401);
    }

    const companyId = payment?.company_id ?? requestedCompanyId ?? null;
    const authorized = await validateWebhookToken(supabaseAdmin, providedToken, companyId);
    if (!authorized) {
      return jsonResponse({ error: "Unauthorized webhook" }, 401);
    }

    const { data: webhookEvent, error: insertError } = await supabaseAdmin
      .from("asaas_webhook_events")
      .insert({
        company_id: companyId,
        event_id: eventId,
        event_type: eventType || "UNKNOWN",
        asaas_payment_link_id: asaasPaymentLinkId,
        asaas_payment_id: asaasPaymentId,
        reservation_payment_id: payment?.id ?? null,
        payload: body,
        processing_status: "received",
      })
      .select("id")
      .single();

    if (insertError) {
      if (String(insertError.message || "").includes("duplicate key")) {
        return jsonResponse({ ok: true, duplicate: true });
      }
      throw new Error(insertError.message);
    }

    if (!payment) {
      await supabaseAdmin.from("asaas_webhook_events").update({
        processing_status: "ignored",
        processed_at: new Date().toISOString(),
        error_details: "Pagamento local nao encontrado pelo paymentLink/paymentId",
      }).eq("id", webhookEvent.id);
      return jsonResponse({ ok: true, ignored: true });
    }

    try {
      payment = await attachGeneratedPaymentId(supabaseAdmin, payment, asaasPaymentId, asaasStatus);

      const providerOutcome = getAsaasExternalPaymentOutcome(eventType, asaasStatus, body.payment);
      if (providerOutcome) {
        await markReservationPaymentProviderOutcome(supabaseAdmin, payment, providerOutcome, {
          source: "asaas_webhook",
          asaasStatus: asaasStatus ?? eventType,
          eventType,
          metadata: {
            asaas_payment_id: asaasPaymentId,
            asaas_payment_link_id: asaasPaymentLinkId,
            chargeback_status: getAsaasActiveChargebackStatus(body.payment),
            refunded_value: getAsaasRefundedValue(body.payment),
          },
        });
      } else if (
        (isAsaasPaymentApprovalEvent(eventType) || isAsaasPaidStatus(asaasStatus))
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
        const paidAt = getAsaasPaidAt(body);
        await confirmReservationPayment(supabaseAdmin, payment, asaasStatus ?? eventType, "asaas_webhook", paidAt);
      } else if (asaasPaymentId && payment.asaas_payment_id !== asaasPaymentId) {
        await recordPaymentEvent(supabaseAdmin, payment, "asaas_payment_id_attached", {
          source: "asaas_webhook",
          event_type: eventType,
          asaas_payment_id: asaasPaymentId,
          asaas_payment_link_id: asaasPaymentLinkId,
        });
      }

      await supabaseAdmin.from("asaas_webhook_events").update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      }).eq("id", webhookEvent.id);
    } catch (error: any) {
      await supabaseAdmin.from("asaas_webhook_events").update({
        processing_status: "failed",
        error_details: error?.message || "Erro ao processar webhook",
        processed_at: new Date().toISOString(),
      }).eq("id", webhookEvent.id);
      throw error;
    }

    return jsonResponse({ ok: true });
  } catch (error: any) {
    console.error("asaas-webhook error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
