import type { SupabaseAdminClient } from './internal-auth.ts';

type QueueCall = {
  type?: string;
  company_id: string;
  waitlist_id?: string | null;
  waitlist_called_at?: string | null;
};
type Channel = 'evolution' | 'pluguechat_official';

/** These rejections establish that no message was accepted; a timeout/5xx does not. */
const REJECTED_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422, 429]);
const EVOLUTION_PREFLIGHT_FAILURES = new Set(['evolution_not_configured', 'instance_not_configured', 'instance_disconnected', 'invalid_payload']);
const PLUGUECHAT_REJECTIONS = new Set(['FAILED', 'ERROR', 'REJECTED', 'CANCELED', 'CANCELLED', 'UNDELIVERED']);

export function isEvolutionCallFailureRetryable(error: { code?: string; provider_status?: number | null }) {
  return EVOLUTION_PREFLIGHT_FAILURES.has(error.code ?? '')
    || (error.code === 'provider_request_failed' && REJECTED_HTTP_STATUSES.has(error.provider_status ?? 0));
}

export function isPlugueChatCallFailureRetryable(result: { provider_status?: string | null; error?: string }) {
  if (['EXPIRED', 'MISSING_MESSAGE_ID'].includes((result.provider_status ?? '').toUpperCase())) return false;
  if (PLUGUECHAT_REJECTIONS.has((result.provider_status ?? '').toUpperCase())) return true;
  if (['Configuração PlugueChat não encontrada ou incompleta.', 'Template da chamada não configurado.', 'Telefone internacional invalido para envio.'].includes(result.error ?? '')) return true;
  const httpStatus = result.error?.match(/^HTTP (\d{3}):/)?.[1];
  return httpStatus !== undefined && REJECTED_HTTP_STATUSES.has(Number(httpStatus));
}

/** Never send an old call after its deadline, a configuration change or seating. */
export async function getWaitlistCallEligibility(
  database: SupabaseAdminClient,
  item: QueueCall,
  expectedChannel: Channel,
  now?: number,
): Promise<{ eligible: boolean; reason?: string }> {
  if (item.type !== 'waitlist_called') return { eligible: true };
  if (!item.waitlist_id || !item.waitlist_called_at) return { eligible: false, reason: 'untracked_call' };
  const calledAt = Date.parse(item.waitlist_called_at);
  if (!Number.isFinite(calledAt) || calledAt + 5 * 60_000 <= (now ?? Date.now())) return { eligible: false, reason: 'call_expired' };

  try {
    const [company, entry, automation, feature] = await Promise.all([
      database.from('companies').select('whatsapp_automation_channel,deletion_requested_at').eq('id', item.company_id).maybeSingle(),
      database.from('waitlist').select('status,called_at').eq('company_id', item.company_id).eq('id', item.waitlist_id).maybeSingle(),
      database.from(expectedChannel === 'evolution' ? 'automation_settings' : 'pluguechat_automation_templates')
        .select('enabled').eq('company_id', item.company_id).eq('type', 'waitlist_called').maybeSingle(),
      database.rpc('company_feature_enabled', { _company_id: item.company_id, _feature_key: 'whatsapp_integration' }),
    ]);
    if (company.error || entry.error || automation.error || feature.error) return { eligible: false, reason: 'lookup_failed' };
    if (!company.data || company.data.deletion_requested_at || (company.data.whatsapp_automation_channel ?? 'evolution') !== expectedChannel) return { eligible: false, reason: 'channel_changed' };
    if (!entry.data || entry.data.status !== 'called') return { eligible: false, reason: 'call_ended' };
    if (Date.parse(entry.data.called_at ?? '') !== calledAt) return { eligible: false, reason: 'call_changed' };
    if (automation.data?.enabled !== true || feature.data !== true) return { eligible: false, reason: 'automation_disabled' };
    if (calledAt + 5 * 60_000 <= (now ?? Date.now())) return { eligible: false, reason: 'call_expired' };
    return { eligible: true };
  } catch {
    return { eligible: false, reason: 'lookup_failed' };
  }
}
