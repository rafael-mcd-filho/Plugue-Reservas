import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  corsHeaders,
  jsonResponse,
  paymentIsExpired,
  readJson,
  toPublicPaymentSummary,
} from "../_shared/reservation-payments.ts";

async function loadPaymentByTokenOrTrackingCode(supabaseAdmin: any, body: any, url: URL) {
  const paymentToken = typeof body.payment_token === "string"
    ? body.payment_token
    : url.searchParams.get("payment_token");
  const trackingCode = typeof body.tracking_code === "string"
    ? body.tracking_code
    : url.searchParams.get("tracking_code");

  if (paymentToken) {
    const { data, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("payment_token", paymentToken)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  if (trackingCode) {
    const { data: reservation, error: reservationError } = await supabaseAdmin
      .from("reservations")
      .select("id")
      .eq("public_tracking_code", trackingCode)
      .maybeSingle();
    if (reservationError) throw new Error(reservationError.message);
    if (!reservation) return null;

    const { data, error } = await supabaseAdmin
      .from("reservation_payments")
      .select("*")
      .eq("reservation_id", reservation.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  throw new Error("Token do pagamento ou codigo da reserva obrigatorio");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createSupabaseAdminClient();
    const body = req.method === "GET" ? {} : await readJson(req);
    const url = new URL(req.url);
    const payment = await loadPaymentByTokenOrTrackingCode(supabaseAdmin, body, url);

    if (!payment) return jsonResponse({ error: "Pagamento nao encontrado" }, 404);

    const [{ data: reservation, error: reservationError }, { data: company, error: companyError }] = await Promise.all([
      supabaseAdmin.from("reservations").select("*").eq("id", payment.reservation_id).maybeSingle(),
      supabaseAdmin.from("companies").select("id, name, slug, logo_url, phone, whatsapp").eq("id", payment.company_id).maybeSingle(),
    ]);

    if (reservationError) throw new Error(reservationError.message);
    if (companyError) throw new Error(companyError.message);
    if (!reservation || !company) return jsonResponse({ error: "Dados da reserva nao encontrados" }, 404);

    if (payment.status === "awaiting_method" && paymentIsExpired(payment)) {
      const { data: updatedPayment, error: updateError } = await supabaseAdmin
        .from("reservation_payments")
        .update({ status: "expired", error_details: "Prazo local expirado sem escolha de metodo" })
        .eq("id", payment.id)
        .select("*")
        .single();
      if (updateError) throw new Error(updateError.message);
      await supabaseAdmin.from("reservations").update({ status: "payment_expired" }).eq("id", reservation.id);
      return jsonResponse(toPublicPaymentSummary(updatedPayment, { ...reservation, status: "payment_expired" }, company));
    }

    return jsonResponse(toPublicPaymentSummary(payment, reservation, company));
  } catch (error: any) {
    console.error("get-reservation-payment error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
