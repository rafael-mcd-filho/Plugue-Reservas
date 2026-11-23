import { getAsaasPayment } from "./asaas.ts";
import { getReservationAsaasCredentials } from "./reservation-asaas-config.ts";

interface SettlementPayment {
  id: string;
  company_id: string;
  asaas_payment_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Reservation approval and cash availability have different lifecycles. Never
// turn a booking's `paid` flag or a webhook payload into withdrawable funds.
// Only opted-in, newly created central charges have a frozen settlement row.
export async function synchronizeReservationSettlement(
  admin: any,
  payment: SettlementPayment,
  source: string,
) {
  if (payment.metadata?.asaas_account_scope !== "platform"
    || payment.metadata?.asaas_environment !== "production" || !payment.asaas_payment_id) return null;

  const { data: settlement, error } = await admin.from("reservation_payment_settlements")
    .select("payment_id").eq("payment_id", payment.id).eq("company_id", payment.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!settlement) return null;

  try {
    const credentials = await getReservationAsaasCredentials(admin, payment);
    const observedAt = new Date().toISOString();
    const provider = await getAsaasPayment(credentials, payment.asaas_payment_id);
    if (provider.id !== payment.asaas_payment_id) throw new Error("Identificador financeiro Asaas divergente");
    const { data, error: syncError } = await admin.rpc("sync_reservation_payment_settlement", {
      _payment_id: payment.id,
      _source: source,
      _provider_snapshot: {
        id: provider.id,
        status: provider.status ?? null,
        billingType: provider.billingType ?? null,
        value: provider.value ?? null,
        netValue: provider.netValue ?? null,
        paymentDate: provider.paymentDate ?? null,
        creditDate: provider.creditDate ?? null,
        estimatedCreditDate: provider.estimatedCreditDate ?? null,
        installment: provider.installment ?? null,
        chargeback: provider.chargeback ?? null,
        refunds: provider.refunds ?? null,
        observed_at: observedAt,
      },
    });
    if (syncError) throw new Error(syncError.message);
    return data;
  } catch (error) {
    // A stale successful receipt must not keep funds withdrawable after a
    // failed authoritative check. Keep secrets/provider text out of the row.
    const { error: holdError } = await admin.from("reservation_payment_settlements")
      .update({ reconciliation_error: "Nao foi possivel verificar o recebimento no Asaas",
        last_checked_at: new Date().toISOString() })
      .eq("payment_id", payment.id).eq("company_id", payment.company_id);
    if (holdError) throw new Error("Nao foi possivel proteger o saldo apos falha na conciliacao");
    const { error: refreshError } = await admin.rpc("refresh_reservation_payment_settlement", { _payment_id: payment.id });
    if (refreshError) throw new Error("Nao foi possivel atualizar a retencao financeira");
    throw error;
  }
}
