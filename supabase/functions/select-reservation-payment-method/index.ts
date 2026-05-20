import { createSupabaseAdminClient } from "../_shared/internal-auth.ts";
import {
  AsaasApiError,
  createAsaasCustomer,
  createAsaasPayment,
  createAsaasPaymentLink,
  deleteAsaasPayment,
  deleteAsaasPaymentLink,
  ensureAsaasAccountSite,
  getAsaasPaymentLinkUrl,
  getAsaasPixQrCode,
  type AsaasBillingType,
  type AsaasPaymentLinkPayload,
} from "../_shared/asaas.ts";
import {
  buildPaymentLinkDescription,
  buildPaymentLinkExternalReference,
  buildPaymentLinkName,
  buildPaymentUrl,
  calculateMethodAmount,
  cleanDigits,
  corsHeaders,
  dateOnlyInTimeZone,
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
    supabaseAdmin.from("companies").select("id, name, slug, logo_url, phone, whatsapp").eq("id", payment.company_id).maybeSingle(),
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
    dueDateLimitDays: 1,
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

function getAppOriginUrl() {
  const candidate = Deno.env.get("APP_URL") || Deno.env.get("SITE_URL") || "";
  return candidate.trim();
}

function isAsaasDomainMissingError(error: unknown) {
  if (!(error instanceof AsaasApiError)) return false;
  const message = String(error.message || "").toLowerCase();
  return message.includes("dom") && message.includes("conta");
}

function friendlyAsaasError(billingType: AsaasBillingType, error: unknown) {
  if (isAsaasDomainMissingError(error)) {
    if (billingType === "CREDIT_CARD") {
      return "Pagamento por cartao temporariamente indisponivel. Use Pix ou fale com o restaurante.";
    }
    return "Configuracao do pagamento incompleta. Fale com o restaurante para liberar o link.";
  }

  if (error instanceof Error && error.message) return error.message;
  return "Nao foi possivel criar o link de pagamento.";
}

function addDaysToDate(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function handlePixPayment(
  supabaseAdmin: any,
  apiToken: string,
  payment: any,
  reservation: any,
  company: any,
  chargedAmount: number,
) {
  const externalReference = buildPaymentLinkExternalReference(payment.payment_token, "PIX");

  const customerPayload = {
    name: reservation.guest_name?.trim() || "Cliente Plugue Reservas",
    mobilePhone: cleanDigits(reservation.guest_phone) || undefined,
    email: reservation.guest_email?.trim() || undefined,
    externalReference,
  };

  let customer;
  try {
    customer = await createAsaasCustomer(apiToken, customerPayload);
  } catch (error) {
    await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
      billing_type: "PIX",
      stage: "create_customer",
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: friendlyAsaasError("PIX", error) }, 502);
  }

  const dueDate = dateOnlyInTimeZone(addDaysToDate(new Date(), 1));
  const description = buildPaymentLinkDescription(payment, reservation);

  let asaasPayment;
  try {
    asaasPayment = await createAsaasPayment(apiToken, {
      customer: customer.id,
      billingType: "PIX",
      value: chargedAmount,
      dueDate,
      description,
      externalReference,
    });
  } catch (error) {
    await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
      billing_type: "PIX",
      stage: "create_payment",
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: friendlyAsaasError("PIX", error) }, 502);
  }

  let pixQrCode;
  try {
    pixQrCode = await getAsaasPixQrCode(apiToken, asaasPayment.id);
  } catch (error) {
    try {
      await deleteAsaasPayment(apiToken, asaasPayment.id);
    } catch (cleanupError) {
      console.warn("Failed to delete Asaas payment after QR code failure", cleanupError);
    }
    await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
      billing_type: "PIX",
      stage: "get_pix_qr",
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: friendlyAsaasError("PIX", error) }, 502);
  }

  const nowIso = new Date().toISOString();
  const metadata = {
    ...(payment.metadata && typeof payment.metadata === "object" ? payment.metadata : {}),
    pix_qr_code_base64: pixQrCode.encodedImage,
    pix_copy_paste: pixQrCode.payload,
    pix_expiration_date: pixQrCode.expirationDate ?? null,
    asaas_customer_id: customer.id,
  };

  const { data: updatedPayment, error: updateError } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      status: "pending",
      billing_type: "PIX",
      charged_amount: chargedAmount,
      max_installments: 1,
      asaas_payment_id: asaasPayment.id,
      asaas_status: asaasPayment.status ?? null,
      payment_link_external_reference: externalReference,
      payment_link_url: null,
      asaas_payment_link_id: null,
      metadata,
      selected_at: nowIso,
      last_checked_at: nowIso,
      error_details: null,
    })
    .eq("id", payment.id)
    .eq("status", "awaiting_method")
    .select("*")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);

  if (!updatedPayment) {
    try {
      await deleteAsaasPayment(apiToken, asaasPayment.id);
    } catch (deleteError) {
      console.warn("Failed to delete duplicate Asaas payment", deleteError);
    }

    const { payment: currentPayment, reservation: currentReservation, company: currentCompany } =
      await resolvePaymentContext(supabaseAdmin, payment.payment_token);
    return jsonResponse(toPublicPaymentSummary(currentPayment, currentReservation, currentCompany));
  }

  await recordPaymentEvent(supabaseAdmin, updatedPayment, "payment_pix_created", {
    billing_type: "PIX",
    charged_amount: chargedAmount,
    asaas_payment_id: asaasPayment.id,
    asaas_customer_id: customer.id,
    payment_link_external_reference: externalReference,
  });

  return jsonResponse(toPublicPaymentSummary(updatedPayment, reservation, company));
}

async function handleCardPayment(
  supabaseAdmin: any,
  apiToken: string,
  payment: any,
  reservation: any,
  company: any,
  chargedAmount: number,
  maxInstallments: number,
) {
  const externalReference = buildPaymentLinkExternalReference(payment.payment_token, "CREDIT_CARD");
  const paymentLinkPayload = getPaymentLinkPayload(payment, reservation, "CREDIT_CARD", chargedAmount, maxInstallments);

  let asaasPaymentLink;
  try {
    asaasPaymentLink = await createAsaasPaymentLink(apiToken, paymentLinkPayload);
  } catch (error) {
    if (isAsaasDomainMissingError(error)) {
      const appUrl = getAppOriginUrl();
      if (appUrl) {
        const registered = await ensureAsaasAccountSite(
          apiToken,
          appUrl,
          company.name || "Plugue Reservas",
        );
        if (registered) {
          try {
            asaasPaymentLink = await createAsaasPaymentLink(apiToken, paymentLinkPayload);
          } catch (retryError) {
            await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
              billing_type: "CREDIT_CARD",
              stage: "after_site_registration",
              error: retryError instanceof Error ? retryError.message : String(retryError),
            });
            return jsonResponse({ error: friendlyAsaasError("CREDIT_CARD", retryError) }, 502);
          }
        } else {
          await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
            billing_type: "CREDIT_CARD",
            stage: "site_registration_failed",
            error: error instanceof Error ? error.message : String(error),
          });
          return jsonResponse({ error: friendlyAsaasError("CREDIT_CARD", error) }, 502);
        }
      } else {
        await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
          billing_type: "CREDIT_CARD",
          stage: "no_app_url",
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse({ error: friendlyAsaasError("CREDIT_CARD", error) }, 502);
      }
    } else {
      await recordPaymentEvent(supabaseAdmin, payment, "payment_link_creation_failed", {
        billing_type: "CREDIT_CARD",
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse({ error: friendlyAsaasError("CREDIT_CARD", error) }, 502);
    }
  }

  const paymentLinkUrl = getAsaasPaymentLinkUrl(asaasPaymentLink);

  if (!paymentLinkUrl) {
    throw new Error("Asaas nao retornou URL do link de pagamento");
  }

  const { data: updatedPayment, error: updateError } = await supabaseAdmin
    .from("reservation_payments")
    .update({
      status: "pending",
      billing_type: "CREDIT_CARD",
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
      await deleteAsaasPaymentLink(apiToken, asaasPaymentLink.id);
    } catch (deleteError) {
      console.warn("Failed to delete duplicate Asaas payment link", deleteError);
    }

    const { payment: currentPayment, reservation: currentReservation, company: currentCompany } =
      await resolvePaymentContext(supabaseAdmin, payment.payment_token);
    return jsonResponse(toPublicPaymentSummary(currentPayment, currentReservation, currentCompany));
  }

  await recordPaymentEvent(supabaseAdmin, updatedPayment, "payment_link_created", {
    billing_type: "CREDIT_CARD",
    charged_amount: chargedAmount,
    max_installments: maxInstallments,
    asaas_payment_link_id: asaasPaymentLink.id,
    payment_link_external_reference: asaasPaymentLink.externalReference ?? externalReference,
  });

  return jsonResponse(toPublicPaymentSummary(updatedPayment, reservation, company));
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

    if (billingType === "PIX") {
      return await handlePixPayment(supabaseAdmin, asaasConfig.api_token, payment, reservation, company, chargedAmount);
    }

    return await handleCardPayment(
      supabaseAdmin,
      asaasConfig.api_token,
      payment,
      reservation,
      company,
      chargedAmount,
      maxInstallments,
    );
  } catch (error: any) {
    console.error("select-reservation-payment-method error", error);
    return jsonResponse({ error: error?.message || "Erro interno" }, 500);
  }
});
