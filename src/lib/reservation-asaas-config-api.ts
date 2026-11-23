import { supabase } from '@/integrations/supabase/client';
import { getFunctionErrorMessage } from '@/lib/functionErrors';

export interface CentralReservationAsaasConfig {
  status: 'not_configured' | 'configured' | 'error';
  environment: 'sandbox' | 'production';
  account_id: string | null;
  has_api_token: boolean;
  token_last_four: string | null;
  last_validated_at: string | null;
  last_error: string | null;
  webhook_id: string | null;
  webhook_url: string;
  webhook_email: string | null;
  candidate_token_valid?: boolean;
  message?: string;
}

export async function manageCentralReservationAsaasConfig(input: {
  action: 'get' | 'save' | 'test';
  api_token?: string;
  environment?: 'sandbox' | 'production';
  webhook_email?: string;
}): Promise<CentralReservationAsaasConfig> {
  const { data, error } = await supabase.functions.invoke<CentralReservationAsaasConfig & { error?: string }>(
    'manage-reservation-asaas-config', { body: input },
  );
  if (error || !data || data.error) {
    throw new Error(error ? await getFunctionErrorMessage(error) : data?.error || 'Não foi possível carregar a conta central de reservas.');
  }
  return data;
}
