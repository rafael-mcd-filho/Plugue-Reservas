import { supabase } from '@/integrations/supabase/client';

export type AccessAuditEventType = 'login' | 'panel_access';

interface TrackAccessAuditInput {
  eventType: AccessAuditEventType;
  path?: string | null;
  companyId?: string | null;
  slug?: string | null;
  metadata?: Record<string, unknown>;
}

export async function trackAccessAudit(input: TrackAccessAuditInput) {
  const { error, data } = await supabase.functions.invoke('audit-access', {
    body: {
      event_type: input.eventType,
      path: input.path ?? null,
      company_id: input.companyId ?? null,
      slug: input.slug ?? null,
      metadata: input.metadata ?? {},
    },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

const reportedAuditFailures = new Set<string>();

function getAuditErrorName(error: unknown) {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name?: unknown }).name ?? '');
  }

  return '';
}

function getAuditErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '');
}

function isNonCriticalDevAuditFailure(error: unknown) {
  const name = getAuditErrorName(error);
  const message = getAuditErrorMessage(error);

  return (
    name === 'FunctionsFetchError'
    || /Failed to send a request to the Edge Function/i.test(message)
    || /CORS/i.test(message)
    || /Failed to fetch/i.test(message)
  );
}

export function reportAccessAuditFailure(context: 'login' | 'panel access', error: unknown) {
  if (import.meta.env.DEV && isNonCriticalDevAuditFailure(error)) {
    const key = `${context}:edge-function-unavailable`;
    if (reportedAuditFailures.has(key)) return;

    reportedAuditFailures.add(key);
    console.info(
      `Access audit unavailable in local development for ${context}. ` +
      'This only affects audit logging until the Supabase Edge Function is reachable.',
    );
    return;
  }

  console.warn(`Failed to audit ${context}:`, error);
}
