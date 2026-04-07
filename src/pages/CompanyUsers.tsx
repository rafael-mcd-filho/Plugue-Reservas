import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getFunctionErrorMessage } from '@/lib/functionErrors';
import type { ManagedUser } from '@/hooks/useUsers';

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operador',
};

const roleBadgeClassNames: Record<string, string> = {
  admin: 'border-success/20 bg-success-soft text-success',
  operator: 'border-primary/20 bg-primary-soft text-primary',
};

const avatarToneClasses = [
  'bg-success-soft text-success',
  'bg-primary-soft text-primary',
  'bg-info-soft text-info',
  'bg-destructive-soft text-destructive',
];

function getUserInitials(user: ManagedUser) {
  const source = user.full_name?.trim() || user.email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'US';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function getAvatarTone(user: ManagedUser) {
  const seed = (user.full_name || user.email || 'user')
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return avatarToneClasses[seed % avatarToneClasses.length];
}

export default function CompanyUsers() {
  const { companyId, companyName } = useCompanySlug();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '', role: 'operator' });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [resetDialog, setResetDialog] = useState<ManagedUser | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<ManagedUser | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ full_name: '', email: '', phone: '', role: 'operator' });

  const {
    data: users = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['company-users', companyId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: { action: 'list_users' },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      const allUsers = (data?.users ?? []) as ManagedUser[];
      return allUsers.filter((user) => user.company_id === companyId);
    },
    enabled: !!companyId,
    retry: false,
  });

  const activeAdminCount = useMemo(
    () => users.filter((user) => !user.is_banned && user.roles.includes('admin')).length,
    [users],
  );

  const isLastActiveAdmin = (user: ManagedUser | null) =>
    !!user && !user.is_banned && user.roles.includes('admin') && activeAdminCount === 1;

  const editWouldRemoveLastAdmin =
    !!editUser && isLastActiveAdmin(editUser) && editForm.role !== 'admin';
  const banWouldRemoveLastAdmin = isLastActiveAdmin(banDialog);
  const deleteWouldRemoveLastAdmin = isLastActiveAdmin(deleteDialog);

  const filtered = useMemo(() => {
    return users.filter((user) => {
      if (filterRole !== 'all' && !user.roles.includes(filterRole)) return false;
      if (search) {
        const query = search.toLowerCase();
        return (
          user.full_name.toLowerCase().includes(query) ||
          user.email.toLowerCase().includes(query)
        );
      }
      return true;
    });
  }, [filterRole, search, users]);

  const openEdit = (user: ManagedUser) => {
    setEditUser(user);
    const primaryRole = user.roles.find((role) => role !== 'superadmin') || user.roles[0] || 'operator';
    setEditForm({
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      role: primaryRole,
    });
  };

  const handleEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editUser) return;

    if (editWouldRemoveLastAdmin) {
      toast.error('A unidade precisa manter ao menos um admin ativo.');
      return;
    }

    try {
      const { error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'update_user',
          user_id: editUser.id,
          full_name: editForm.full_name,
          email: editForm.email,
          phone: editForm.phone,
          role: editForm.role,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      toast.success('Usuário atualizado.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
      setEditUser(null);
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
  };

  const handleToggleBan = async (user: ManagedUser) => {
    try {
      const { error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'toggle_ban',
          user_id: user.id,
          ban: !user.is_banned,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      toast.success(user.is_banned ? 'Usuário desbloqueado.' : 'Usuário bloqueado.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setBanDialog(null);
    }
  };

  const handleResetPassword = async (userId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'reset_password',
          user_id: userId,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      if (data?.access_link) {
        try {
          await navigator.clipboard.writeText(data.access_link);
          toast.success('Link unico de redefinicao copiado.');
        } catch {
          toast.success('Link unico de redefinicao gerado.');
        }
      } else {
        toast.success('Link unico de redefinicao gerado.');
      }
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setResetDialog(null);
    }
  };

  const handleDeleteUser = async (user: ManagedUser) => {
    try {
      const { error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'delete_user',
          user_id: user.id,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      toast.success('Usuario excluido.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setDeleteDialog(null);
    }
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!createForm.full_name || !createForm.email) {
      toast.error('Preencha nome e e-mail.');
      return;
    }

    setCreating(true);

    try {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'seed_users',
          users: [
            {
              full_name: createForm.full_name,
              email: createForm.email,
              phone: createForm.phone || null,
              company_id: companyId,
              role: createForm.role,
            },
          ],
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorMessage(error));
      }

      const result = data?.results?.[0];
      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.warning) {
        toast.warning(result.warning);
      }

      if (result?.access_link) {
        try {
          await navigator.clipboard.writeText(result.access_link);
          toast.success('Usuario criado. Link unico copiado.');
        } catch {
          toast.success('Usuario criado. Link unico gerado.');
        }
      } else {
        toast.success('Usuario criado com sucesso.');
      }
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
      setShowCreateDialog(false);
      setCreateForm({ full_name: '', email: '', phone: '', role: 'operator' });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Usuarios</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie os usuarios de {companyName}
          </p>
        </div>

        <Button className="gap-2 self-start rounded-lg px-4" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" />
          Novo usuario
        </Button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome ou e-mail..."
            className="h-10 rounded-lg bg-card pl-10"
          />
        </div>

        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="h-10 w-full rounded-lg bg-card lg:w-[180px]">
            <SelectValue placeholder="Todos os perfis" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os perfis</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="operator">Operador</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="space-y-3 p-6">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-16 w-full rounded-2xl" />
            ))}
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="py-14 text-center text-muted-foreground">
            <AlertTriangle className="mx-auto mb-3 h-12 w-12 text-destructive/70" />
            <p className="font-medium text-foreground">Nao foi possivel carregar os usuarios.</p>
            <p className="mt-2 text-sm">{error instanceof Error ? error.message : 'Erro inesperado.'}</p>
            <Button variant="outline" className="mt-4 gap-2 rounded-lg" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="py-14 text-center text-muted-foreground">
            <UsersIcon className="mx-auto mb-3 h-12 w-12 opacity-30" />
            Nenhum usuario encontrado.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <Table>
            <TableHeader className="bg-muted/55">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="h-12 px-5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Nome
                </TableHead>
                <TableHead className="h-12 px-5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  E-mail
                </TableHead>
                <TableHead className="h-12 px-5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Perfil
                </TableHead>
                <TableHead className="h-12 px-5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Status
                </TableHead>
                <TableHead className="h-12 px-5 text-right text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Acoes
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => (
                <TableRow key={user.id} className="border-border/80 bg-card hover:bg-muted/25">
                  <TableCell className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          getAvatarTone(user),
                        )}
                      >
                        {getUserInitials(user)}
                      </div>
                      <span className="font-medium text-foreground">{user.full_name || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-5 py-4 text-sm text-muted-foreground">
                    {user.email}
                  </TableCell>
                  <TableCell className="px-5 py-4">
                    <div className="flex flex-wrap gap-2">
                      {user.roles
                        .filter((role) => role !== 'superadmin')
                        .map((role) => (
                          <span
                            key={role}
                            className={cn(
                              'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium',
                              roleBadgeClassNames[role] || 'border-border bg-muted text-foreground',
                            )}
                          >
                            {roleLabels[role] || role}
                          </span>
                        ))}
                    </div>
                  </TableCell>
                  <TableCell className="px-5 py-4">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium',
                        user.is_banned
                          ? 'border-destructive/20 bg-destructive-soft text-destructive'
                          : 'border-success/20 bg-success-soft text-success',
                      )}
                    >
                      {user.is_banned ? 'Bloqueado' : 'Ativo'}
                    </span>
                  </TableCell>
                  <TableCell className="px-5 py-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-9 w-9 rounded-lg border-border bg-card text-muted-foreground hover:bg-muted"
                          aria-label={`Acoes para ${user.full_name || user.email}`}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52 rounded-lg">
                        <DropdownMenuItem onClick={() => openEdit(user)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setResetDialog(user)}>
                          <KeyRound className="mr-2 h-4 w-4" />
                          Redefinir senha
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={user.is_banned ? 'text-primary focus:text-primary' : 'text-destructive focus:text-destructive'}
                          onClick={() => setBanDialog(user)}
                        >
                          {user.is_banned ? (
                            <>
                              <Shield className="mr-2 h-4 w-4" />
                              Desbloquear
                            </>
                          ) : (
                            <>
                              <ShieldOff className="mr-2 h-4 w-4" />
                              Bloquear
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteDialog(user)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Excluir
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <AlertDialog open={!!banDialog} onOpenChange={(open) => !open && setBanDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{banDialog?.is_banned ? 'Desbloquear usuario?' : 'Bloquear usuario?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {banWouldRemoveLastAdmin
                ? 'A unidade ficaria sem admin ativo. Promova ou cadastre outro admin antes de bloquear este usuario.'
                : banDialog?.is_banned
                  ? `${banDialog.full_name || banDialog.email} voltara a ter acesso ao sistema.`
                  : `${banDialog?.full_name || banDialog?.email} perdera acesso imediatamente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => banDialog && handleToggleBan(banDialog)}
              disabled={banWouldRemoveLastAdmin}
              className={banDialog?.is_banned ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {banDialog?.is_banned ? 'Desbloquear' : 'Bloquear'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir usuário?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWouldRemoveLastAdmin
                ? 'A unidade ficaria sem admin ativo. Promova ou cadastre outro admin antes de excluir este usuário.'
                : `${deleteDialog?.full_name || deleteDialog?.email} será removido permanentemente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDialog && handleDeleteUser(deleteDialog)}
              disabled={deleteWouldRemoveLastAdmin}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetDialog} onOpenChange={(open) => !open && setResetDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Redefinir senha?</AlertDialogTitle>
            <AlertDialogDescription>
              Um link único de redefinição será gerado para {resetDialog?.full_name || resetDialog?.email}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => resetDialog && handleResetPassword(resetDialog.id)}>
              Redefinir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="edit-user-full-name">Nome completo</Label>
              <Input
                id="edit-user-full-name"
                name="full_name"
                value={editForm.full_name}
                onChange={(event) => setEditForm({ ...editForm, full_name: event.target.value })}
                autoComplete="name"
              />
            </div>
            <div>
              <Label htmlFor="edit-user-email">E-mail</Label>
              <Input
                id="edit-user-email"
                name="email"
                type="email"
                value={editForm.email}
                onChange={(event) => setEditForm({ ...editForm, email: event.target.value })}
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="edit-user-phone">Telefone</Label>
              <Input
                id="edit-user-phone"
                name="phone"
                type="tel"
                value={editForm.phone}
                onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
            <div>
              <Label>Perfil</Label>
              <Select value={editForm.role} onValueChange={(value) => setEditForm({ ...editForm, role: value })}>
                <SelectTrigger aria-label="Perfil do usuário">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editWouldRemoveLastAdmin && (
              <p className="text-sm text-destructive">
                A unidade precisa manter ao menos um admin ativo.
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={editWouldRemoveLastAdmin}>
                Salvar
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="create-user-full-name">Nome completo *</Label>
              <Input
                id="create-user-full-name"
                name="full_name"
                value={createForm.full_name}
                onChange={(event) => setCreateForm({ ...createForm, full_name: event.target.value })}
                placeholder="Nome do usuário"
                autoComplete="name"
                required
              />
            </div>
            <div>
              <Label htmlFor="create-user-email">E-mail *</Label>
              <Input
                id="create-user-email"
                name="email"
                type="email"
                value={createForm.email}
                onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })}
                placeholder="email@empresa.com"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                required
              />
            </div>
            <div>
              <Label htmlFor="create-user-phone">Telefone</Label>
              <Input
                id="create-user-phone"
                name="phone"
                type="tel"
                value={createForm.phone}
                onChange={(event) => setCreateForm({ ...createForm, phone: event.target.value })}
                placeholder="(11) 99999-9999"
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
            <div>
              <Label>Perfil *</Label>
              <Select value={createForm.role} onValueChange={(value) => setCreateForm({ ...createForm, role: value })}>
                <SelectTrigger aria-label="Perfil do novo usuário">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              O usuário será vinculado automaticamente a {companyName}. Um link único de acesso será gerado.
            </p>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Criando...' : 'Criar usuário'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
