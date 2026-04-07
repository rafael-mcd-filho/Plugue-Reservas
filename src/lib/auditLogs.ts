import { supabase } from '@/integrations/supabase/client';

interface AuditLogInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export async function writeSuperadminAuditLog(input: AuditLogInput) {
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;

  if (!userId) return;

  const { error } = await supabase
    .from('audit_logs' as any)
    .insert({
      user_id: userId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      details: input.details ?? {},
    } as any);

  if (error) {
    throw error;
  }
}
