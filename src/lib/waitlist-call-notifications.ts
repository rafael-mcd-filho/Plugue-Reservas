import { supabase } from '@/integrations/supabase/client';

export interface WaitlistCallFailure {
  waitlist_id: string;
  called_at: string;
  can_retry: boolean;
}

export interface WaitlistCallNotifications {
  company_id: string;
  channel: 'evolution' | 'pluguechat_official';
  automation_enabled: boolean;
  failures: WaitlistCallFailure[];
}

const requestError = () => new Error('Não foi possível consultar os avisos da chamada.');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Unknown or cross-company responses must never enable a retry. */
export function parseWaitlistCallNotifications(value: unknown, companyId: string): WaitlistCallNotifications {
  if (!isRecord(value) || value.company_id !== companyId
    || (value.channel !== 'evolution' && value.channel !== 'pluguechat_official')
    || typeof value.automation_enabled !== 'boolean' || !Array.isArray(value.failures)) throw requestError();

  const seen = new Set<string>();
  const failures = value.failures.map((failure) => {
    if (!isRecord(failure) || typeof failure.waitlist_id !== 'string' || !failure.waitlist_id
      || seen.has(failure.waitlist_id) || typeof failure.called_at !== 'string'
      || !Number.isFinite(Date.parse(failure.called_at)) || typeof failure.can_retry !== 'boolean') throw requestError();
    seen.add(failure.waitlist_id);
    return { waitlist_id: failure.waitlist_id, called_at: failure.called_at, can_retry: failure.can_retry };
  });

  return {
    company_id: companyId, channel: value.channel, automation_enabled: value.automation_enabled,
    failures: value.automation_enabled ? failures : [],
  };
}

async function requestWaitlistCallNotifications(body: Record<string, unknown>, companyId: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  const { data, error } = await supabase.functions.invoke<unknown>('waitlist-call-notification', {
    body, ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
  if (error) throw requestError();
  return parseWaitlistCallNotifications(data, companyId);
}

export function getWaitlistCallNotifications(companyId: string, signal?: AbortSignal) {
  return requestWaitlistCallNotifications({ action: 'list', company_id: companyId }, companyId, signal);
}

export function retryWaitlistCallNotification(companyId: string, waitlistId: string, calledAt: string) {
  if (!waitlistId || !Number.isFinite(Date.parse(calledAt))) return Promise.reject(requestError());
  return requestWaitlistCallNotifications({
    action: 'retry', company_id: companyId, waitlist_id: waitlistId, expected_called_at: calledAt,
  }, companyId);
}
