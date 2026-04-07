import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { writeSuperadminAuditLog } from '@/lib/auditLogs';
import { normalizeSystemName } from '@/lib/branding';

export interface SystemSetting {
  id: string;
  key: string;
  value: string | null;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, any>;
  ip_address: string | null;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
}

export interface Notification {
  id: string;
  company_id: string | null;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  read_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SystemBranding {
  system_name: string;
  system_logo_url: string;
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ['system-settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings' as any)
        .select('*');
      if (error) throw error;
      return (data ?? []) as unknown as SystemSetting[];
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function useSystemBranding() {
  return useQuery({
    queryKey: ['system-branding'],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_public_system_branding');
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      return {
        system_name: normalizeSystemName(row?.system_name),
        system_logo_url: row?.system_logo_url || '',
      } as SystemBranding;
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string | null }) => {
      const { data: { session } } = await supabase.auth.getSession();
      const { error } = await supabase
        .from('system_settings' as any)
        .update({
          value,
          updated_at: new Date().toISOString(),
          updated_by: session?.user?.id ?? null,
        } as any)
        .eq('key', key);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('Configuracao salva!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useAuditLogs(limit = 50) {
  return useQuery({
    queryKey: ['audit-logs', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;

      const rows = (data ?? []) as any[];
      const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];

      if (userIds.length === 0) {
        return [] as AuditLog[];
      }

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles' as any)
        .select('id, full_name, email')
        .in('id', userIds as any);

      if (profilesError) throw profilesError;

      const profileMap = new Map(
        ((profiles ?? []) as any[]).map((profile) => [
          profile.id,
          { actor_name: profile.full_name || null, actor_email: profile.email || null },
        ]),
      );

      return rows.map((row) => {
        const actor = profileMap.get(row.user_id) ?? { actor_name: null, actor_email: null };
        return {
          ...row,
          ...actor,
        };
      }) as AuditLog[];
    },
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications' as any)
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Notification[];
    },
  });
}

export function useCreateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (notification: { company_ids: string[]; title: string; message: string; type: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      const { company_ids, ...rest } = notification;

      if (company_ids.length === 0) {
        throw new Error('Selecione ao menos uma empresa');
      }

      const rows = company_ids.map((companyId) => ({
        ...rest,
        company_id: companyId,
        created_by: session?.user?.id ?? null,
      }));

      const { error } = await supabase
        .from('notifications' as any)
        .insert(rows as any);
      if (error) throw error;

      try {
        await writeSuperadminAuditLog({
          action: 'send_notification',
          entityType: 'notification',
          details: {
            title: rest.title,
            type: rest.type,
            company_count: company_ids.length,
            company_ids,
          },
        });
      } catch (auditError) {
        console.error('Failed to audit send_notification', auditError);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['company-notifications'] });
      toast.success('Notificacao enviada!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: existing } = await supabase
        .from('notifications' as any)
        .select('id, title, company_id')
        .eq('id', id)
        .maybeSingle();

      const { error } = await supabase
        .from('notifications' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;

      try {
        await writeSuperadminAuditLog({
          action: 'delete_notification',
          entityType: 'notification',
          entityId: id,
          details: {
            title: existing?.title ?? null,
            company_id: existing?.company_id ?? null,
          },
        });
      } catch (auditError) {
        console.error('Failed to audit delete_notification', auditError);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['company-notifications'] });
      toast.success('Notificacao removida!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useCompanyNotifications(companyId: string, limit = 10) {
  return useQuery({
    queryKey: ['company-notifications', companyId, limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as Notification[];
    },
    enabled: !!companyId,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ companyId, ids }: { companyId: string; ids: string[] }) => {
      if (ids.length === 0) return 0;
      const { data, error } = await (supabase.rpc as any)('mark_notifications_read', { _notification_ids: ids });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['company-notifications', variables.companyId] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}
