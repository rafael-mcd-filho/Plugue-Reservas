import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import type {
  AsaasConfigStatus,
  PublicReservationPaymentSummary,
  ReservationPrepaymentBillingType,
  SelectReservationPaymentMethodRequest,
} from '@/lib/asaas-prepayment-contracts';

export interface ReservationPaymentFunctionResponse extends PublicReservationPaymentSummary {
  message?: string;
  confirmation?: {
    status: 'paid' | 'late_paid';
  };
}

export interface SaveAsaasConfigResponse {
  status: Exclude<AsaasConfigStatus, 'not_configured'>;
  last_validated_at: string | null;
  last_error: string | null;
  webhook_url: string | null;
  webhook_auth_token: string;
}

async function invokeReservationPaymentFunction<T>(
  functionName: string,
  body: object,
  fallbackError: string,
) {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(functionName, {
    body,
  });

  if (error || !data || (data as { error?: string }).error) {
    const message = error
      ? await getFunctionErrorMessage(error)
      : (data as { error?: string } | null)?.error || fallbackError;
    throw new Error(message);
  }

  return data as T;
}

export async function getReservationPayment(paymentToken: string) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'get-reservation-payment',
    { payment_token: paymentToken },
    'Não foi possível carregar o pagamento da reserva.',
  );
}

export async function selectReservationPaymentMethod(
  paymentToken: string,
  billingType: ReservationPrepaymentBillingType,
) {
  const body: SelectReservationPaymentMethodRequest = {
    payment_token: paymentToken,
    billing_type: billingType,
  };

  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'select-reservation-payment-method',
    body,
    'Não foi possível criar o link de pagamento.',
  );
}

export async function checkReservationPayment(paymentToken: string) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'check-reservation-payment',
    { payment_token: paymentToken },
    'Não foi possível consultar o pagamento.',
  );
}

export async function saveAsaasConfig(companyId: string, apiToken: string) {
  return invokeReservationPaymentFunction<SaveAsaasConfigResponse>(
    'save-asaas-config',
    {
      company_id: companyId,
      api_token: apiToken,
    },
    'Não foi possível salvar a configuração Asaas.',
  );
}
