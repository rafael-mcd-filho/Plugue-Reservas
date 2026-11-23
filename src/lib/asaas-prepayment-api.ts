import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import type {
  AsaasConfigStatus,
  CreateReservationPaymentRequest,
  CreateReservationPaymentResponse,
  PublicReservationPaymentSummary,
  ReservationPaymentRequirement,
  ReservationPrepaymentBillingType,
  SelectReservationPaymentMethodRequest,
} from '@/lib/asaas-prepayment-contracts';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** An unavailable/legacy response is unknown, never an assertion that no payment is needed. */
export function parseReservationPaymentRequirement(value: unknown, scope: { companyId: string; date: string }): ReservationPaymentRequirement {
  const invalid = () => new Error('Não foi possível consultar a necessidade de pagamento.');
  if (!isRecord(value) || value.schema !== 'reservation-payment-requirement' || value.version !== 1
    || value.company_id !== scope.companyId || value.date !== scope.date
    || typeof value.requires_payment !== 'boolean'
    || (value.reason !== undefined && value.reason !== 'feature_disabled' && value.reason !== 'no_rule')
    || (value.requires_payment && value.reason !== undefined)) throw invalid();
  return {
    schema: 'reservation-payment-requirement', version: 1, company_id: scope.companyId, date: scope.date,
    requires_payment: value.requires_payment,
    ...(value.reason === 'feature_disabled' || value.reason === 'no_rule' ? { reason: value.reason } : {}),
  };
}

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
  webhook_auth_token: string | null;
  has_api_token: boolean;
}

export interface GetAsaasConfigResponse {
  status: AsaasConfigStatus;
  last_validated_at: string | null;
  last_error: string | null;
  webhook_url: string | null;
  webhook_auth_token: string | null;
  has_api_token: boolean;
  managed_by_platform?: boolean;
  from_company_account?: boolean;
  environment?: 'sandbox' | 'production' | null;
}

async function invokeReservationPaymentFunction<T>(
  functionName: string,
  body: object,
  fallbackError: string,
  options: { signal?: AbortSignal } = {},
) {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(functionName, {
    body,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (error || !data || (data as { error?: string }).error) {
    const message = error
      ? await getFunctionErrorMessage(error)
      : (data as { error?: string } | null)?.error || fallbackError;
    throw new Error(message);
  }

  return data as T;
}

export async function getReservationPaymentRequirement(companyId: string, date: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const response = await invokeReservationPaymentFunction<unknown>(
    'create-reservation-payment',
    { action: 'preview', company_id: companyId, date },
    'Não foi possível consultar a necessidade de pagamento.',
    { signal },
  );
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  return parseReservationPaymentRequirement(response, { companyId, date });
}

export async function getReservationPayment(paymentToken: string) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'get-reservation-payment',
    { payment_token: paymentToken },
    'Não foi possível carregar o pagamento da reserva.',
  );
}

export async function getReservationPaymentByTrackingCode(trackingCode: string) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'get-reservation-payment',
    { tracking_code: trackingCode },
    'Não foi possível carregar o pagamento da reserva.',
  );
}

export async function selectReservationPaymentMethod(
  paymentToken: string,
  billingType: ReservationPrepaymentBillingType,
  options: { cpf?: string } = {},
) {
  const body: SelectReservationPaymentMethodRequest & { cpf?: string } = {
    payment_token: paymentToken,
    billing_type: billingType,
    ...(options.cpf ? { cpf: options.cpf } : {}),
  };

  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'select-reservation-payment-method',
    body,
    'Não foi possível criar o pagamento.',
  );
}

export async function checkReservationPayment(paymentToken: string) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'check-reservation-payment',
    { payment_token: paymentToken },
    'Não foi possível consultar o pagamento.',
  );
}

export async function refundReservationPayment(
  companyId: string,
  paymentToken: string,
  options: { value?: number; description?: string } = {},
) {
  return invokeReservationPaymentFunction<ReservationPaymentFunctionResponse>(
    'refund-reservation-payment',
    {
      company_id: companyId,
      payment_token: paymentToken,
      ...options,
    },
    'Não foi possível solicitar o estorno.',
  );
}

export async function createReservationPayment(body: CreateReservationPaymentRequest) {
  return invokeReservationPaymentFunction<CreateReservationPaymentResponse>(
    'create-reservation-payment',
    body,
    'Não foi possível preparar o pagamento da reserva.',
  );
}

export async function saveAsaasConfig(companyId: string, apiToken: string) {
  return invokeReservationPaymentFunction<SaveAsaasConfigResponse>(
    'save-asaas-config',
    {
      action: 'save',
      company_id: companyId,
      api_token: apiToken,
    },
    'Não foi possível salvar a configuração Asaas.',
  );
}

export async function getAsaasConfig(companyId: string) {
  return invokeReservationPaymentFunction<GetAsaasConfigResponse>(
    'save-asaas-config',
    {
      action: 'get',
      company_id: companyId,
    },
    'Não foi possível carregar a configuração Asaas.',
  );
}

export async function testAsaasConfig(companyId: string, apiToken?: string) {
  return invokeReservationPaymentFunction<GetAsaasConfigResponse>(
    'save-asaas-config',
    {
      action: 'test',
      company_id: companyId,
      ...(apiToken ? { api_token: apiToken } : {}),
    },
    'Não foi possível testar a configuração Asaas.',
  );
}
