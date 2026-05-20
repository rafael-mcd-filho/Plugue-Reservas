import type { AsaasBillingType } from "./asaas.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-job-secret, asaas-access-token, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export interface ReservationPaymentRecord {
  id: string;
  company_id: string;
  reservation_id: string;
  rule_id: string | null;
  rule_snapshot: Record<string, unknown>;
  asaas_payment_link_id: string | null;
  asaas_payment_id: string | null;
  payment_token: string;
  billing_type: AsaasBillingType | null;
  base_amount: number;
  charged_amount: number | null;
  max_installments: number | null;
  status: string;
  asaas_status: string | null;
  payment_link_url: string | null;
  payment_link_external_reference: string | null;
  payment_link_deleted_at: string | null;
  expires_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  last_checked_at: string | null;
  error_details: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReservationRecord {
  id: string;
  company_id: string;
  table_id: string | null;
  table_map_id?: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  guest_birthdate?: string | null;
  date: string;
  time: string;
  party_size: number;
  duration_minutes?: number;
  status: string;
  occasion: string | null;
  notes: string | null;
  visitor_id?: string | null;
  public_tracking_code?: string | null;
  created_at?: string | null;
}

export interface CompanyRecord {
  id: string;
  name: string;
  slug?: string | null;
  logo_url?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export function cleanDigits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

export function toMoney(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

export function dateOnlyInTimeZone(date = new Date(), timeZone = "America/Fortaleza") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function buildPaymentUrl(paymentToken: string) {
  const appUrl = (Deno.env.get("APP_URL") || Deno.env.get("SITE_URL") || "").replace(/\/+$/, "");
  return appUrl ? `${appUrl}/pagamento/${paymentToken}` : `/pagamento/${paymentToken}`;
}

export function buildPaymentLinkExternalReference(paymentToken: string, billingType: AsaasBillingType) {
  return `PR-${paymentToken}-${billingType}`;
}

export function formatReservationDateTime(reservation: Pick<ReservationRecord, "date" | "time">) {
  const time = String(reservation.time || "").slice(0, 5);
  return `${reservation.date}${time ? ` ${time}` : ""}`;
}

export function buildPaymentLinkName(
  payment: Pick<ReservationPaymentRecord, "payment_token">,
  reservation: Pick<ReservationRecord, "public_tracking_code" | "date" | "time">,
  billingType: AsaasBillingType,
) {
  const method = billingType === "CREDIT_CARD" ? "Cartao" : "Pix";
  const reference = reservation.public_tracking_code || payment.payment_token.slice(0, 10);
  return `Reserva ${reference} - ${formatReservationDateTime(reservation)} - ${method}`;
}

export function buildPaymentLinkDescription(
  payment: Pick<ReservationPaymentRecord, "payment_token" | "rule_snapshot">,
  reservation: Pick<ReservationRecord, "guest_name" | "party_size" | "public_tracking_code" | "date" | "time">,
) {
  const snapshot = getRuleSnapshot(payment);
  const reference = reservation.public_tracking_code || payment.payment_token.slice(0, 10);
  const ruleName = snapshot.name ? ` | ${snapshot.name}` : "";
  return `Sinal de reserva${ruleName} | ${reservation.party_size} pessoas | ${reservation.guest_name} | ${formatReservationDateTime(reservation)} | Ref ${reference}`;
}

export function paymentIsExpired(payment: Pick<ReservationPaymentRecord, "expires_at">) {
  return new Date(payment.expires_at).getTime() <= Date.now();
}

export function getRuleSnapshot(payment: Pick<ReservationPaymentRecord, "rule_snapshot">) {
  return (payment.rule_snapshot || {}) as Record<string, any>;
}

function calculateByAmountType(amount: number, amountType: string, partySize: number) {
  return amountType === "per_person" ? amount * Math.max(Number(partySize) || 1, 1) : amount;
}

export function calculateMethodAmount(
  payment: Pick<ReservationPaymentRecord, "rule_snapshot" | "base_amount">,
  reservation: Pick<ReservationRecord, "party_size">,
  billingType: AsaasBillingType,
) {
  const snapshot = getRuleSnapshot(payment);
  const amountType = String(snapshot.amount_type || "fixed_per_reservation");
  const amountKey = billingType === "PIX" ? "pix_amount" : "credit_card_amount";
  const configuredAmount = toMoney(snapshot[amountKey]);

  if (configuredAmount > 0) {
    return toMoney(calculateByAmountType(configuredAmount, amountType, reservation.party_size));
  }

  return toMoney(payment.base_amount);
}

export function getAvailableBillingTypes(payment: Pick<ReservationPaymentRecord, "rule_snapshot">) {
  const snapshot = getRuleSnapshot(payment);
  const types: AsaasBillingType[] = [];
  if (snapshot.pix_enabled === true) types.push("PIX");
  if (snapshot.credit_card_enabled === true) types.push("CREDIT_CARD");
  return types;
}

export function getMaxInstallments(payment: Pick<ReservationPaymentRecord, "rule_snapshot">) {
  const snapshot = getRuleSnapshot(payment);
  const installments = Number(snapshot.max_credit_card_installments || 1);
  return Number.isFinite(installments) ? Math.max(1, Math.min(21, Math.floor(installments))) : 1;
}

export async function recordPaymentEvent(
  supabaseAdmin: any,
  payment: Pick<ReservationPaymentRecord, "id" | "company_id" | "reservation_id">,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  const { error } = await supabaseAdmin.from("reservation_payment_events").insert({
    company_id: payment.company_id,
    reservation_payment_id: payment.id,
    reservation_id: payment.reservation_id,
    event_type: eventType,
    payload,
  });

  if (error) {
    console.warn("Failed to record reservation payment event", error);
  }
}

async function reservationHasBlockingConflict(
  supabaseAdmin: any,
  reservation: ReservationRecord,
) {
  if (!reservation.table_id) return false;

  const { data, error } = await supabaseAdmin
    .from("reservations")
    .select("id, status")
    .eq("company_id", reservation.company_id)
    .eq("date", reservation.date)
    .eq("time", reservation.time)
    .eq("table_id", reservation.table_id)
    .neq("id", reservation.id)
    .not("status", "in", '("cancelled","no-show","no_show","payment_expired","payment_cancelled")')
    .limit(10);

  if (error) throw new Error(error.message);

  const candidates = data ?? [];
  for (const candidate of candidates) {
    if (candidate.status !== "pending_payment") {
      return true;
    }

    const { data: candidatePayment } = await supabaseAdmin
      .from("reservation_payments")
      .select("id, status, expires_at")
      .eq("reservation_id", candidate.id)
      .in("status", ["awaiting_method", "pending"])
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();

    if (candidatePayment) {
      return true;
    }
  }

  return false;
}

async function triggerReservationConfirmationEvent(reservation: ReservationRecord) {
  if (!reservation.visitor_id) return;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return;

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/functions/v1/reservation-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "reservation_created",
        reservation: {
          id: reservation.id,
          visitor_id: reservation.visitor_id,
        },
      }),
    });

    if (!response.ok) {
      console.warn("Reservation confirmation automation was not triggered", await response.text());
    }
  } catch (error) {
    console.warn("Failed to trigger reservation confirmation automation", error);
  }
}

export async function confirmReservationPayment(
  supabaseAdmin: any,
  payment: ReservationPaymentRecord,
  asaasStatus: string | null,
  source: string,
  paidAt: string | null = null,
) {
  const { data: reservation, error: reservationError } = await supabaseAdmin
    .from("reservations")
    .select("*")
    .eq("id", payment.reservation_id)
    .maybeSingle();

  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error("Reserva nao encontrada");

  const typedReservation = reservation as ReservationRecord;

  const paidAtDate = paidAt ? new Date(paidAt) : new Date();
  const paidAtIso = Number.isNaN(paidAtDate.getTime()) ? new Date().toISOString() : paidAtDate.toISOString();
  const paidAfterLocalExpiration = new Date(payment.expires_at).getTime() <= new Date(paidAtIso).getTime();

  if (paidAfterLocalExpiration) {
    const hasConflict = await reservationHasBlockingConflict(supabaseAdmin, typedReservation);
    if (hasConflict) {
      await supabaseAdmin
        .from("reservation_payments")
        .update({
          status: "late_paid",
          asaas_status: asaasStatus,
          paid_at: paidAtIso,
          last_checked_at: new Date().toISOString(),
          error_details: "Pagamento detectado apos expiracao e mesa indisponivel",
        })
        .eq("id", payment.id);

      await supabaseAdmin
        .from("reservations")
        .update({ status: "paid_after_expiration", updated_at: new Date().toISOString() })
        .eq("id", payment.reservation_id);

      await recordPaymentEvent(supabaseAdmin, payment, "payment_late_paid", { source, asaas_status: asaasStatus });
      return { status: "late_paid" as const };
    }
  }

  await supabaseAdmin
    .from("reservation_payments")
    .update({
      status: "paid",
      asaas_status: asaasStatus,
      paid_at: paidAtIso,
      last_checked_at: new Date().toISOString(),
      error_details: null,
    })
    .eq("id", payment.id);

  await supabaseAdmin
    .from("reservations")
    .update({ status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", payment.reservation_id);

  await recordPaymentEvent(supabaseAdmin, payment, "payment_paid", { source, asaas_status: asaasStatus });
  await triggerReservationConfirmationEvent(typedReservation);
  return { status: "paid" as const };
}

export function toPublicPaymentSummary(
  payment: ReservationPaymentRecord,
  reservation: ReservationRecord,
  company: CompanyRecord,
) {
  const pixEnabled = getAvailableBillingTypes(payment).includes("PIX");
  const cardEnabled = getAvailableBillingTypes(payment).includes("CREDIT_CARD");
  const pixAmount = pixEnabled ? calculateMethodAmount(payment, reservation, "PIX") : null;
  const cardAmount = cardEnabled ? calculateMethodAmount(payment, reservation, "CREDIT_CARD") : null;
  const snapshot = getRuleSnapshot(payment);

  return {
    payment_token: payment.payment_token,
    status: payment.status,
    amount: payment.charged_amount ?? payment.base_amount,
    base_amount: payment.base_amount,
    pix_amount: pixAmount,
    credit_card_amount: cardAmount,
    max_credit_card_installments: cardEnabled ? getMaxInstallments(payment) : null,
    billing_type: payment.billing_type,
    available_billing_types: getAvailableBillingTypes(payment),
    expires_at: payment.expires_at,
    paid_at: payment.paid_at,
    payment_link_url: payment.payment_link_url,
    payment_link_external_reference: payment.payment_link_external_reference,
    rule_name: snapshot.name ?? "Pagamento antecipado",
    customer_notice: snapshot.customer_notice ?? null,
    cancellation_policy: snapshot.cancellation_policy ?? null,
    reservation: {
      id: reservation.id,
      guest_name: reservation.guest_name,
      date: reservation.date,
      time: reservation.time,
      party_size: reservation.party_size,
      status: reservation.status,
    },
    company: {
      id: company.id,
      name: company.name,
      logo_url: company.logo_url ?? null,
      slug: company.slug ?? null,
      phone: company.phone ?? null,
      whatsapp: company.whatsapp ?? null,
    },
  };
}
