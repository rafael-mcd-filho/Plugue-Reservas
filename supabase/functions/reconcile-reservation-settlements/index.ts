import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { corsHeaders, jsonResponse, readJson } from "../_shared/reservation-payments.ts";
import { synchronizeReservationSettlement } from "../_shared/reservation-settlement-sync.ts";

// Financial receivables are tracked independently of the booking reconciler's
// age window. Old payments can still settle, be refunded, or face a chargeback.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    if (!(await isAuthorizedInternalJob(req))) return jsonResponse({ error: "Nao autorizado" }, 401);
    const body = await readJson(req);
    const requestedLimit = Number(body.limit ?? 25);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(60, Math.max(1, requestedLimit)) : 25;
    const admin = createSupabaseAdminClient();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: rows, error } = await admin.from("reservation_payment_settlements")
      .select("payment_id,company_id").or(`last_checked_at.is.null,last_checked_at.lt.${stale}`)
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .order("payment_id", { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    const summary = { checked: 0, waiting: 0, failed: 0 };
    for (const row of rows ?? []) {
      try {
        const { data: payment, error: paymentError } = await admin.from("reservation_payments")
          .select("id,company_id,asaas_payment_id,metadata").eq("id", row.payment_id)
          .eq("company_id", row.company_id).maybeSingle();
        if (paymentError) throw new Error(paymentError.message);
        if (!payment) throw new Error("Pagamento financeiro indisponivel");
        if (!payment.asaas_payment_id) summary.waiting++;
        else {
          await synchronizeReservationSettlement(admin, payment, "financial_reconcile");
          summary.checked++;
        }
      } catch {
        summary.failed++;
        // A failed lookup keeps the previous projection; never fabricate zero,
        // mark a missing provider payment as received, or release its funds.
      }
      const { error: checkedError } = await admin.from("reservation_payment_settlements")
        .update({ last_checked_at: new Date().toISOString() }).eq("payment_id", row.payment_id)
        .eq("company_id", row.company_id);
      if (checkedError) throw new Error(checkedError.message);
    }
    const { error: releaseError } = await admin.rpc("release_due_reservation_settlements");
    if (releaseError) throw new Error(releaseError.message);
    return jsonResponse({ ok: true, summary });
  } catch (error) {
    console.error("Financial reconciliation failed", error instanceof Error ? error.message : "unknown");
    return jsonResponse({ error: "Nao foi possivel conciliar os recebimentos das reservas" }, 500);
  }
});
