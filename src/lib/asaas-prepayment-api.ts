import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import type {
  AsaasConfigStatus,
  CreateReservationPaymentRequest,
  CreateReservationPaymentResponse,
  PublicReservationPaymentSummary,
  PublicReservationSectionOptions,
  PublicReservationSectionOption,
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

export function parseReservationSectionOptions(value: unknown): PublicReservationSectionOptions {
  const invalid = () => new Error('Não foi possível consultar os ambientes da reserva.');
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.options)
    || !(value.rule_id === undefined || value.rule_id === null || (typeof value.rule_id === 'string' && value.rule_id))
    || !(value.automatic_allocation_available === undefined || typeof value.automatic_allocation_available === 'boolean')
    || !(value.configuration_error === undefined || value.configuration_error === null || typeof value.configuration_error === 'string')) throw invalid();
  const money = (amount: unknown) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  const nullableMoney = (amount: unknown) => amount === null || money(amount);
  const options: PublicReservationSectionOption[] = value.options.map(option => {
    if (!isRecord(option) || typeof option.id !== 'string' || !option.id
      || typeof option.section_id !== 'string' || !option.section_id
      || option.id !== option.section_id
      || typeof option.section_name !== 'string' || typeof option.public_name !== 'string'
      || !(option.description === null || typeof option.description === 'string')
      || !(option.amount_type === null || ['per_person', 'fixed_per_reservation'].includes(String(option.amount_type)))
      || !nullableMoney(option.base_amount) || !nullableMoney(option.pix_amount) || !nullableMoney(option.credit_card_amount)
      || (option.amount_type === null && (option.base_amount !== null || option.pix_amount !== null || option.credit_card_amount !== null))
      || !(option.payment_rule_section_id === undefined || option.payment_rule_section_id === null || typeof option.payment_rule_section_id === 'string')
      || !(option.capacity_guests === undefined || option.capacity_guests === null
        || (Number.isInteger(option.capacity_guests) && Number(option.capacity_guests) > 0))
      || typeof option.available !== 'boolean') throw invalid();
    return {
      id: option.id, section_id: option.section_id, section_name: option.section_name,
      public_name: option.public_name, description: option.description as string | null,
      amount_type: option.amount_type as PublicReservationSectionOption['amount_type'],
      base_amount: option.base_amount as number | null, pix_amount: option.pix_amount as number | null,
      credit_card_amount: option.credit_card_amount as number | null, available: option.available,
      ...(option.payment_rule_section_id !== undefined ? { payment_rule_section_id: option.payment_rule_section_id as string | null } : {}),
      ...(option.capacity_guests !== undefined ? { capacity_guests: option.capacity_guests as number | null } : {}),
    };
  });
  if ((!value.enabled && options.length) || new Set(options.map(option => option.id)).size !== options.length) throw invalid();
  return { enabled: value.enabled,
    ...(value.rule_id !== undefined ? { rule_id: value.rule_id as string | null } : {}), options,
    ...(value.configuration_error !== undefined ? { configuration_error: value.configuration_error as string | null } : {}),
    ...(value.automatic_allocation_available !== undefined ? { automatic_allocation_available: value.automatic_allocation_available as boolean } : {}),
  };
}

export async function getReservationSectionOptions(
  companyId: string, date: string, time: string, partySize: number, signal?: AbortSignal,
): Promise<PublicReservationSectionOptions> {
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const request = (supabase.rpc as any)('get_public_reservation_section_options', {
    _company_id: companyId, _date: date, _time: time, _party_size: partySize,
  });
  const { data, error } = await (signal && typeof request.abortSignal === 'function' ? request.abortSignal(signal) : request);
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) {
    // Older databases have no environment-selection configuration. Only an
    // explicit missing-function response is compatible with that legacy flow.
    const missingRpc = ['PGRST202', '42883', '404'].includes(String(error.code))
      && /\bget_public_reservation_section_options\b/.test([error.message, error.details, error.hint].join(' '));
    if (missingRpc) return { enabled: false, options: [] };
    throw new Error(error.message || 'Não foi possível consultar os ambientes da reserva.');
  }
  return parseReservationSectionOptions(data);
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
