import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface ManagedUser {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  company_id: string | null;
  roles: string[];
  is_banned: boolean;
  last_sign_in: string | null;
  created_at: string;
}

async function invokeManageUser(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('manage-user', { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export function useUsers() {
  return useQuery({
    queryKey: ['managed-users'],
    queryFn: async () => {
      const result = await invokeManageUser({ action: 'list_users' });
      return (result.users ?? []) as ManagedUser[];
    },
  });
}

export function useToggleBan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ user_id, ban }: { user_id: string; ban: boolean }) => {
      return invokeManageUser({ action: 'toggle_ban', user_id, ban });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      toast.success(vars.ban ? 'Usuário bloqueado!' : 'Usuário desbloqueado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { user_id: string; full_name?: string; email?: string; phone?: string }) => {
      return invokeManageUser({ action: 'update_user', ...data });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      toast.success('Usuário atualizado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (user_id: string) => {
      return invokeManageUser({ action: 'reset_password', user_id });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      toast.success(`Senha redefinida! Nova senha: ${data.temp_password}`, { duration: 15000 });
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}
