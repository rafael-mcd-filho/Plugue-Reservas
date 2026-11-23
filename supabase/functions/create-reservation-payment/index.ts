import { normalizePhoneE164 } from "../_shared/phone.ts";
import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import { getGlobalReservationAsaasConfig } from "../_shared/reservation-asaas-config.ts";
import { isPaymentRequirementDate, publicPaymentRequirement } from "../_shared/reservation-payment-requirement.ts";
import {
  buildPaymentUrl,
  corsHeaders,
  jsonResponse,
  readJson,
  recordPaymentEvent,
  toMoney,
} from "../_shared/reservation-payments.ts";

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function calculateRuleAmount(rule: any, partySize: number, key: "base_amount" | "pix_amount" | "credit_card_amount") {
  const amount = toMoney(rule[key]);
  if (rule.amount_type === "per_person") {
    return toMoney(amount * Math.max(Number(partySize) || 1, 1));
  }
  return amount;
}

async function createConfirmedReservation(
  supabaseAdmin: any,
  companyId: string,
  reservation: Record<string, unknown>,
  reason: "feature_disabled" | "no_rule",
) {
  const { data, error } = await supabaseAdmin.rpc("create_public_reservation", {
    _reservation: {
      ...reservation,
      company_id: companyId,
      status: "confirmed",
    },
    _status: "confirmed",
  });
  if (error) throw new Error(error.message);

  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) throw new Error("Reserva nao criada");

  return jsonResponse({
    requires_payment: false,
    reason,
    reservation_id: created.id,
    reservation_created: true,
  });
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
    const reservation = body.reservation ?? {};
    const dryRun = body.dry_run === true;
    const completeWithoutPayment = body.complete_without_payment === true;
    const preview = body.action === "preview";
    const reservationDate = preview ? body.date : reservation.date;

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);
    if (preview && !isPaymentRequirementDate(reservationDate)) {
      return jsonResponse({ error: "Data da reserva inválida." }, 400);
    }
    if (body.action !== undefined && !preview) return jsonResponse({ error: "Ação inválida." }, 400);
    if (!preview && (!reservation.date || !reservation.time || !reservation.guest_name || !reservation.guest_phone)) {
      return jsonResponse({ error: "Dados da reserva incompletos" }, 400);
    }

    if (!preview) {
      const guestPhone = normalizePhoneE164(String(reservation.guest_phone_e164 ?? reservation.guest_phone ?? ""));
      if (!guestPhone) return jsonResponse({ error: "Telefone invalido para o pais selecionado" }, 400);
      reservation.guest_phone = guestPhone;
    }

    const supabaseAdmin = createSupabaseAdminClient();

    const { data: featureEnabled, error: featureError } = await supabaseAdmin.rpc("company_feature_enabled", {
      _company_id: companyId,
      _feature_key: "reservation_prepayment",
    });
    if (featureError) throw new Error(featureError.message);
    if (featureEnabled !== true) {
      if (preview) return jsonResponse(publicPaymentRequirement(companyId, reservationDate, false, "feature_disabled"));
      if (!dryRun && completeWithoutPayment) {
        return await createConfirmedReservation(
          supabaseAdmin,
          companyId,
          reservation,
          "feature_disabled",
        );
      }
      return jsonResponse({ requires_payment: false, reason: "feature_disabled" });
    }

    const { data: rule, error: ruleError } = await supabaseAdmin
      .from("reservation_payment_rules")
      .select(preview ? "id" : "*")
      .eq("company_id", companyId)
      .eq("enabled", true)
      .is("archived_at", null)
      .lte("date_start", reservationDate)
      .gte("date_end", reservationDate)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ruleError) throw new Error(ruleError.message);
    if (!rule) {
      if (preview) return jsonResponse(publicPaymentRequirement(companyId, reservationDate, false, "no_rule"));
      if (!dryRun && completeWithoutPayment) {
        return await createConfirmedReservation(
          supabaseAdmin,
          companyId,
          reservation,
          "no_rule",
        );
      }
      return jsonResponse({ requires_payment: false, reason: "no_rule" });
    }

    // The preview only changes the CTA label. It neither loads credentials nor
    // claims that a reservation/payment has been created or is ready to charge.
    if (preview) return jsonResponse(publicPaymentRequirement(companyId, reservationDate, true));

    const asaasConfig = await getGlobalReservationAsaasConfig(supabaseAdmin);
    let paymentAccountMetadata: Record<string, unknown> | null = null;
    if (asaasConfig?.status === "configured") {
      paymentAccountMetadata = {
        asaas_account_scope: "platform",
        asaas_account_id: asaasConfig.provider_account_id,
        asaas_environment: asaasConfig.api_environment,
      };
    } else if (!asaasConfig?.provider_account_id && !asaasConfig?.api_token_encrypted) {
      // Keep live company accounts working until the superadmin initializes
      // the central account. Once central is initialized, never silently fall
      // back to another receiving account after a validation/provider failure.
      const { data: legacyConfig, error: legacyError } = await supabaseAdmin
        .from("company_asaas_configs").select("status").eq("company_id", companyId).maybeSingle();
      if (legacyError) throw new Error(legacyError.message);
      if (legacyConfig?.status === "configured") {
        paymentAccountMetadata = { asaas_account_scope: "company" };
      }
    }
    if (!paymentAccountMetadata) {
      return jsonResponse({ error: "Integracao central de pagamentos nao configurada. Fale com o suporte." }, 409);
    }

    if (paymentAccountMetadata.asaas_account_scope === "platform"
      && paymentAccountMetadata.asaas_environment === "production") {
      // Never accept new central funds without a frozen commercial agreement
      // and a payable record. The INSERT trigger rechecks this atomically too.
      const { data: terms, error: termsError } = await supabaseAdmin.from("reservation_settlement_terms")
        .select("id,enabled").eq("company_id", companyId).lte("effective_at", new Date().toISOString())
        .order("effective_at", { ascending: false }).order("created_at", { ascending: false })
        .order("id", { ascending: false }).limit(1).maybeSingle();
      if (termsError) throw new Error(termsError.message);
      if (!terms?.enabled) return jsonResponse({
        error: "Pagamento antecipado temporariamente indisponivel. Fale com o estabelecimento.",
        code: "SETTLEMENT_TERMS_REQUIRED",
      }, 409);
    }

    if (dryRun) {
      return jsonResponse({
        requires_payment: true,
        dry_run: true,
        feature_enabled: true,
        rule: {
          id: rule.id,
          name: rule.name,
          date_start: rule.date_start,
          date_end: rule.date_end,
          enabled: rule.enabled,
          archived_at: rule.archived_at,
        },
        asaas_configured: true,
      });
    }

    const reservationData = {
      id: typeof reservation.id === "string" ? reservation.id : crypto.randomUUID(),
      public_tracking_code: typeof reservation.public_tracking_code === "string"
        ? reservation.public_tracking_code
        : crypto.randomUUID().replaceAll("-", ""),
      company_id: companyId,
      table_id: reservation.table_id ?? null,
      table_map_id: reservation.table_map_id ?? null,
      guest_name: String(reservation.guest_name),
      guest_phone: String(reservation.guest_phone),
      guest_email: reservation.guest_email ?? null,
      guest_birthdate: reservation.guest_birthdate ?? null,
      date: reservation.date,
      time: String(reservation.time).length === 5 ? `${reservation.time}:00` : reservation.time,
      party_size: Number(reservation.party_size || 1),
      duration_minutes: Number(reservation.duration_minutes || 30),
      occasion: reservation.occasion ?? null,
      notes: reservation.notes ?? null,
      visitor_id: reservation.visitor_id ?? reservation.origin_anonymous_id ?? null,
      origin_tracking_session_id: reservation.origin_tracking_session_id ?? null,
      origin_tracking_journey_id: reservation.origin_tracking_journey_id ?? null,
      origin_anonymous_id: reservation.origin_anonymous_id ?? reservation.visitor_id ?? null,
      origin_affiliate_link_id: reservation.origin_affiliate_link_id ?? null,
      origin_affiliate_code: reservation.origin_affiliate_code ?? null,
      origin_affiliate_name: reservation.origin_affiliate_name ?? null,
      origin_fbp: reservation.origin_fbp ?? null,
      origin_fbc: reservation.origin_fbc ?? null,
      attribution_snapshot: reservation.attribution_snapshot ?? {},
      status: "pending_payment",
    };

    const { data: insertedReservation, error: reservationError } = await supabaseAdmin
      .rpc("create_public_reservation", {
        _reservation: reservationData,
        _status: "pending_payment",
      });

    if (reservationError) throw new Error(reservationError.message);
    const createdReservation = Array.isArray(insertedReservation)
      ? insertedReservation[0]
      : insertedReservation;
    if (!createdReservation?.id) throw new Error("Reserva nao criada");

    const now = new Date();
    const deadlineMinutes = Number(rule.payment_deadline_minutes || 10);
    const expiresAt = addMinutes(now, deadlineMinutes).toISOString();
    const baseAmount = calculateRuleAmount(rule, reservationData.party_size, "base_amount");
    const paymentToken = crypto.randomUUID().replaceAll("-", "");
    const ruleSnapshot = {
      ...rule,
      // New reservation card payments are always paid in one installment,
      // including when a legacy rule still carries an older installment cap.
      max_credit_card_installments: rule.credit_card_enabled ? 1 : null,
      base_amount_total: baseAmount,
      pix_amount_total: rule.pix_enabled ? calculateRuleAmount(rule, reservationData.party_size, "pix_amount") : null,
      credit_card_amount_total: rule.credit_card_enabled
        ? calculateRuleAmount(rule, reservationData.party_size, "credit_card_amount")
        : null,
    };

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from("reservation_payments")
      .insert({
        company_id: companyId,
        reservation_id: createdReservation.id,
        rule_id: rule.id,
        rule_snapshot: ruleSnapshot,
        payment_token: paymentToken,
        base_amount: baseAmount,
        status: "awaiting_method",
        expires_at: expiresAt,
        metadata: {
          ...paymentAccountMetadata,
          tracking_event_sent_at: now.toISOString(),
          tracking_rule: "conversion_on_pending_payment_creation",
        },
      })
      .select("*")
      .single();

    if (paymentError) {
      // Do not leave capacity held forever when the payment record could not be
      // persisted. No provider charge has been created at this stage.
      const { error: cleanupError } = await supabaseAdmin.from("reservations")
        .update({ status: "payment_cancelled", updated_at: new Date().toISOString() })
        .eq("id", createdReservation.id).eq("company_id", companyId).eq("status", "pending_payment");
      if (cleanupError) console.error("Failed to release reservation after payment persistence error", createdReservation.id);
      throw new Error(paymentError.message);
    }

    await recordPaymentEvent(supabaseAdmin, payment, "payment_created_awaiting_method", {
      reservation_id: createdReservation.id,
      rule_id: rule.id,
      expires_at: expiresAt,
    });

    return jsonResponse({
      requires_payment: true,
      reservation_id: createdReservation.id,
      payment_token: payment.payment_token,
      payment_url: buildPaymentUrl(payment.payment_token),
      expires_at: payment.expires_at,
      status: payment.status,
    });
  } catch (error: any) {
    console.error("create-reservation-payment error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
