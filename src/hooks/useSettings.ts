import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
}

export interface Notification {
  id: string;
  company_id: string | null;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_by: string | null;
  created_at: string;
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
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string | null }) => {
      const { error } = await supabase
        .from('system_settings' as any)
        .update({ value, updated_at: new Date().toISOString() } as any)
        .eq('key', key);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('Configuração salva!');
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
      return (data ?? []) as unknown as AuditLog[];
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
    mutationFn: async (notification: { company_id: string | null; title: string; message: string; type: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      const { error } = await supabase
        .from('notifications' as any)
        .insert({ ...notification, created_by: session?.user?.id } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Notificação enviada!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('notifications' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('Notificação removida!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}
