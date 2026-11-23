import { synchronizeReservationSettlement } from "../_shared/reservation-settlement-sync.ts";
import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import { getGlobalReservationAsaasConfig } from "../_shared/reservation-asaas-config.ts";
import {
  AsaasApiError,
  getAsaasActiveChargebackStatus,
  getAsaasExternalPaymentOutcome,
  getAsaasRefundedValue,
  getAsaasPayment,
  type AsaasPaymentResponse,
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
  recordReservationPaymentInstallment,
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

type WebhookAuthorization = { authorized: boolean; ignored?: boolean; ignoreReason?: string; verifiedPayment?: AsaasPaymentResponse };

async function validateWebhookToken(supabaseAdmin: any, providedToken: string | null, companyId: string | null,
  payment: any, providerPaymentId: string | null, platformScope: boolean): Promise<WebhookAuthorization> {
  const { data: platformConfig, error: platformError } = await supabaseAdmin
    .from("platform_reservation_asaas_config")
    .select("provider_account_id, api_environment, api_token_encrypted, webhook_auth_token")
    .maybeSingle();
  if (platformError) throw new Error(platformError.message);
  const centralTokenMatches = Boolean(platformConfig?.provider_account_id && platformConfig.api_token_encrypted
    && platformConfig.webhook_auth_token && providedToken === platformConfig.webhook_auth_token);
  const centralPayment = payment?.metadata?.asaas_account_scope === "platform";
  if (!payment && centralTokenMatches) return { authorized: true };
  if (centralPayment && centralTokenMatches
    && payment.metadata.asaas_account_id === platformConfig.provider_account_id
    && payment.metadata.asaas_environment === platformConfig.api_environment) {
    return { authorized: true };
  }
  if (centralTokenMatches && payment && !centralPayment) {
    if (!providerPaymentId) return { authorized: true, ignored: true };
    const config = await getGlobalReservationAsaasConfig(supabaseAdmin);
    if (!config?.credentials) throw new Error("Credencial central indisponivel para validar pagamento legado");
    let verifiedPayment: AsaasPaymentResponse;
    try {
      verifiedPayment = await getAsaasPayment(config.credentials, providerPaymentId);
    } catch (error) {
      if (error instanceof AsaasApiError && error.status === 404) return { authorized: true, ignored: true };
      throw error;
    }
    const bindingMatches = verifiedPayment.id === providerPaymentId && (
      payment.asaas_payment_id === verifiedPayment.id
      || (payment.asaas_payment_link_id && payment.asaas_payment_link_id === verifiedPayment.paymentLink)
      || (payment.payment_link_external_reference && payment.payment_link_external_reference === verifiedPayment.externalReference)
    );
    return bindingMatches ? { authorized: true, verifiedPayment } : { authorized: true, ignored: true };
  }
  // A company's legacy token cannot authorize a central-account mutation.
  // On the old destination, acknowledge its out-of-scope events after
  // validating the legacy secret so that its sequential queue can continue.
  if (platformScope || (centralPayment && centralTokenMatches)) return { authorized: false };
  const legacyAuthorization = (): WebhookAuthorization => centralPayment
    ? { authorized: true, ignored: true, ignoreReason: "legacy_webhook_for_central_payment" }
    : { authorized: true };
  const globalToken = Deno.env.get("ASAAS_WEBHOOK_AUTH_TOKEN") || Deno.env.get("ASAAS_WEBHOOK_TOKEN");
  if (globalToken && providedToken === globalToken) return legacyAuthorization();
  if (!companyId) return { authorized: false };

  const { data, error } = await supabaseAdmin
    .from("company_asaas_configs")
    .select("webhook_auth_token")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.webhook_auth_token && providedToken === data.webhook_auth_token
    ? legacyAuthorization() : { authorized: false };
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
  if (!asaasPaymentId || payment.asaas_payment_id) return payment;

  const { data, error } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      asaas_payment_id: asaasPaymentId,
      asaas_status: asaasStatus ?? payment.asaas_status,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .is("asaas_payment_id", null)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) return data;
  const { data: current, error: currentError } = await supabaseAdmin.from("reservation_payments")
    .select("*").eq("id",payment.id).single();
  if (currentError) throw new Error(currentError.message);
  return current;
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
    let asaasStatus = typeof body.payment?.status === "string" ? body.payment.status : null;
    const eventId = buildEventId(body, eventType, asaasPaymentId, asaasPaymentLinkId);
    const providedToken = req.headers.get("asaas-access-token");
    const supabaseAdmin = createSupabaseAdminClient();

    let payment = await findReservationPayment(supabaseAdmin, asaasPaymentId, asaasPaymentLinkId);
    if (payment?.company_id && requestedCompanyId && payment.company_id !== requestedCompanyId) {
      return jsonResponse({ error: "Company mismatch" }, 401);
    }

    const companyId = payment?.company_id ?? requestedCompanyId ?? null;
    const authorization = await validateWebhookToken(supabaseAdmin, providedToken, companyId, payment,
      asaasPaymentId, url.searchParams.get("scope") === "platform");
    if (!authorization.authorized) {
      return jsonResponse({ error: "Unauthorized webhook" }, 401);
    }
    if (authorization.ignored) return jsonResponse({ ok: true, ignored: true,
      reason: authorization.ignoreReason ?? "provider_account_or_binding_mismatch" });
    const providerPayment = authorization.verifiedPayment ?? body.payment;
    // An account-verified legacy event may have waited in a sequential queue.
    // Apply the authoritative current snapshot rather than its stale event.
    const eventForState = authorization.verifiedPayment ? null : eventType;
    if (authorization.verifiedPayment) asaasStatus = authorization.verifiedPayment.status ?? null;

    const processingStartedAt = new Date().toISOString();
    const insertedEvent = await supabaseAdmin
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
        processing_started_at: processingStartedAt,
      })
      .select("id")
      .single();

    let webhookEvent = insertedEvent.data;
    const insertError = insertedEvent.error;

    if (insertError) {
      if (insertError.code !== "23505" && !String(insertError.message || "").includes("duplicate key")) {
        throw new Error(insertError.message);
      }
      const { data: previousEvent, error: previousError } = await supabaseAdmin
        .from("asaas_webhook_events")
        .select("id, company_id, processing_status, processing_started_at, created_at")
        .eq("event_id", eventId)
        .single();
      if (previousError) throw new Error(previousError.message);
      if (previousEvent.company_id && companyId && previousEvent.company_id !== companyId) {
        return jsonResponse({ error: "Company mismatch" }, 401);
      }
      if (previousEvent.processing_status === "processed" || (previousEvent.processing_status === "ignored" && !payment)) {
        return jsonResponse({ ok: true, duplicate: true });
      }
      const leaseStarted = new Date(previousEvent.processing_started_at ?? previousEvent.created_at).getTime();
      if (previousEvent.processing_status === "received" && Date.now() - leaseStarted < 120_000) {
        return jsonResponse({ error: "Evento em processamento; tente novamente" }, 503);
      }
      let claim = supabaseAdmin.from("asaas_webhook_events").update({
        company_id: companyId,
        reservation_payment_id: payment?.id ?? null,
        processing_status: "received",
        processing_started_at: processingStartedAt,
        processed_at: null,
        error_details: null,
      }).eq("id", previousEvent.id).eq("processing_status", previousEvent.processing_status);
      claim = previousEvent.processing_started_at
        ? claim.eq("processing_started_at", previousEvent.processing_started_at)
        : claim.is("processing_started_at", null);
      const { data: claimedEvent, error: claimError } = await claim.select("id").maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimedEvent) return jsonResponse({ error: "Evento em processamento; tente novamente" }, 503);
      webhookEvent = claimedEvent;
    }

    if (!webhookEvent?.id) throw new Error("Evento do webhook nao persistido");

    if (!payment) {
      const { error: ignoredError } = await supabaseAdmin.from("asaas_webhook_events").update({
        processing_status: "ignored",
        processed_at: new Date().toISOString(),
        error_details: "Pagamento local nao encontrado pelo paymentLink/paymentId",
      }).eq("id", webhookEvent.id);
      if (ignoredError) throw new Error(ignoredError.message);
      return jsonResponse({ ok: true, ignored: true });
    }

    try {
      payment = await attachGeneratedPaymentId(supabaseAdmin, payment, asaasPaymentId, asaasStatus);
      payment = await recordReservationPaymentInstallment(supabaseAdmin, payment, providerPayment, "asaas_webhook");

      const providerOutcome = getAsaasExternalPaymentOutcome(eventForState, asaasStatus, providerPayment);
      if (providerOutcome) {
        await markReservationPaymentProviderOutcome(supabaseAdmin, payment, providerOutcome, {
          source: "asaas_webhook",
          asaasStatus: asaasStatus ?? eventType,
          eventType,
          metadata: {
            asaas_payment_id: asaasPaymentId,
            asaas_payment_link_id: asaasPaymentLinkId,
            chargeback_status: getAsaasActiveChargebackStatus(providerPayment),
            refunded_value: getAsaasRefundedValue(providerPayment),
          },
        });
      } else if (
        (isAsaasPaymentApprovalEvent(eventForState) || isAsaasPaidStatus(asaasStatus))
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
        const paidAt = getAsaasPaidAt({ payment: providerPayment });
        await confirmReservationPayment(supabaseAdmin, payment, asaasStatus ?? eventType, "asaas_webhook", paidAt);
      } else if (asaasPaymentId && payment.asaas_payment_id !== asaasPaymentId) {
        await recordPaymentEvent(supabaseAdmin, payment, "asaas_additional_payment_observed", {
          source: "asaas_webhook",
          event_type: eventType,
          asaas_payment_id: asaasPaymentId,
          canonical_asaas_payment_id: payment.asaas_payment_id,
          asaas_payment_link_id: asaasPaymentLinkId,
        });
      }

      await synchronizeReservationSettlement(supabaseAdmin, payment, "asaas_webhook");
      const { error: processedError } = await supabaseAdmin.from("asaas_webhook_events").update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      }).eq("id", webhookEvent.id);
      if (processedError) throw new Error(processedError.message);
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
