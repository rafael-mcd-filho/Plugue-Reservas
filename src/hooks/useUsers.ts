import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useManageUserInvoker } from '@/hooks/useManageUserInvoker';

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

export function useUsers() {
  const { invokeManageUser, manageUserScopeKey } = useManageUserInvoker();

  return useQuery({
    queryKey: ['managed-users', manageUserScopeKey],
    queryFn: async () => {
      const result = await invokeManageUser({ action: 'list_users' });
      return (result.users ?? []) as ManagedUser[];
    },
    retry: false,
  });
}

export function useToggleBan() {
  const qc = useQueryClient();
  const { invokeManageUser } = useManageUserInvoker();

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
  const { invokeManageUser } = useManageUserInvoker();

  return useMutation({
    mutationFn: async (data: { user_id: string; full_name?: string; email?: string; phone?: string; company_id?: string | null; role?: string }) => {
      return invokeManageUser({ action: 'update_user', ...data });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      toast.success('Usuário atualizado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useSetUserPassword() {
  const qc = useQueryClient();
  const { invokeManageUser } = useManageUserInvoker();

  return useMutation({
    mutationFn: async ({ user_id, password }: { user_id: string; password: string }) => {
      return invokeManageUser({ action: 'set_user_password', user_id, password });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  const { invokeManageUser } = useManageUserInvoker();

  return useMutation({
    mutationFn: async (user_id: string) => {
      return invokeManageUser({ action: 'delete_user', user_id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['managed-users'] });
      toast.success('Usuário excluído!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });
}
