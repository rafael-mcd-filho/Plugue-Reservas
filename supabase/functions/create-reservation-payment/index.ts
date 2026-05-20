import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
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

async function hasBlockingReservation(supabaseAdmin: any, reservation: any) {
  if (!reservation.table_id) return false;

  const { data, error } = await supabaseAdmin
    .from("reservations")
    .select("id, status")
    .eq("company_id", reservation.company_id)
    .eq("date", reservation.date)
    .eq("time", reservation.time)
    .eq("table_id", reservation.table_id)
    .not("status", "in", '("cancelled","no-show","no_show","payment_expired","payment_cancelled")')
    .limit(20);

  if (error) throw new Error(error.message);

  for (const candidate of data ?? []) {
    if (candidate.status !== "pending_payment") return true;

    const { data: candidatePayment } = await supabaseAdmin
      .from("reservation_payments")
      .select("id")
      .eq("reservation_id", candidate.id)
      .in("status", ["awaiting_method", "pending"])
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();

    if (candidatePayment) return true;
  }

  return false;
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

    if (!companyId) return jsonResponse({ error: "Empresa obrigatoria" }, 400);
    if (!reservation.date || !reservation.time || !reservation.guest_name || !reservation.guest_phone) {
      return jsonResponse({ error: "Dados da reserva incompletos" }, 400);
    }

    const supabaseAdmin = createSupabaseAdminClient();

    const { data: featureEnabled, error: featureError } = await supabaseAdmin.rpc("company_feature_enabled", {
      _company_id: companyId,
      _feature_key: "reservation_prepayment",
    });
    if (featureError) throw new Error(featureError.message);
    if (featureEnabled !== true) {
      return jsonResponse({ requires_payment: false, reason: "feature_disabled" });
    }

    const { data: rule, error: ruleError } = await supabaseAdmin
      .from("reservation_payment_rules")
      .select("*")
      .eq("company_id", companyId)
      .eq("enabled", true)
      .is("archived_at", null)
      .lte("date_start", reservation.date)
      .gte("date_end", reservation.date)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ruleError) throw new Error(ruleError.message);
    if (!rule) {
      return jsonResponse({ requires_payment: false, reason: "no_rule" });
    }

    const { data: asaasConfig, error: asaasConfigError } = await supabaseAdmin
      .from("company_asaas_configs")
      .select("company_id, status")
      .eq("company_id", companyId)
      .maybeSingle();

    if (asaasConfigError) throw new Error(asaasConfigError.message);
    if (!asaasConfig || asaasConfig.status !== "configured") {
      return jsonResponse({ error: "Integracao Asaas nao configurada para esta empresa" }, 409);
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

    if (await hasBlockingReservation(supabaseAdmin, reservationData)) {
      return jsonResponse({ error: "Mesa indisponivel para este horario" }, 409);
    }

    const { data: insertedReservation, error: reservationError } = await supabaseAdmin
      .from("reservations")
      .insert(reservationData)
      .select("*")
      .single();

    if (reservationError) throw new Error(reservationError.message);

    const now = new Date();
    const deadlineMinutes = Number(rule.payment_deadline_minutes || 10);
    const expiresAt = addMinutes(now, deadlineMinutes).toISOString();
    const baseAmount = calculateRuleAmount(rule, reservationData.party_size, "base_amount");
    const paymentToken = crypto.randomUUID().replaceAll("-", "");
    const ruleSnapshot = {
      ...rule,
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
        reservation_id: insertedReservation.id,
        rule_id: rule.id,
        rule_snapshot: ruleSnapshot,
        payment_token: paymentToken,
        base_amount: baseAmount,
        status: "awaiting_method",
        expires_at: expiresAt,
        metadata: {
          tracking_event_sent_at: now.toISOString(),
          tracking_rule: "conversion_on_pending_payment_creation",
        },
      })
      .select("*")
      .single();

    if (paymentError) throw new Error(paymentError.message);

    await recordPaymentEvent(supabaseAdmin, payment, "payment_created_awaiting_method", {
      reservation_id: insertedReservation.id,
      rule_id: rule.id,
      expires_at: expiresAt,
    });

    return jsonResponse({
      requires_payment: true,
      reservation_id: insertedReservation.id,
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
