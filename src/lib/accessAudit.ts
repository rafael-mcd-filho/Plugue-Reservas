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
