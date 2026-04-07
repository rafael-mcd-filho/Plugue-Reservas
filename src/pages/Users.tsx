import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Users as UsersIcon,
  Shield,
  ShieldOff,
  Pencil,
  KeyRound,
  Building2,
  Plus,
  MoreHorizontal,
  Trash2,
  AlertTriangle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useUsers, useToggleBan, useUpdateUser, useResetPassword, useDeleteUser, ManagedUser } from '@/hooks/useUsers';
import { useCompanies } from '@/hooks/useCompanies';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { getFunctionErrorMessage } from '@/lib/functionErrors';

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operador',
  superadmin: 'Superadmin',
};

export default function Users() {
  const { data: users = [], isLoading, error, refetch, isFetching } = useUsers();
  const { data: companies = [] } = useCompanies();
  const toggleBan = useToggleBan();
  const updateUser = useUpdateUser();
  const resetPassword = useResetPassword();
  const deleteUser = useDeleteUser();
  const qc = useQueryClient();

  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '', company_id: '', role: '' });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [resetDialog, setResetDialog] = useState<ManagedUser | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<ManagedUser | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ full_name: '', email: '', phone: '', company_id: '', role: 'admin' });

  const filtered = users.filter((user) => {
    if (filterCompany !== 'all' && user.company_id !== filterCompany) return false;
    if (filterRole !== 'all' && !user.roles.includes(filterRole)) return false;
    if (search) {
      const query = search.toLowerCase();
      return user.full_name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query);
    }
    return true;
  });

  const activeAdminCounts = users.reduce((acc, user) => {
    if (!user.is_banned && user.roles.includes('admin') && user.company_id) {
      acc[user.company_id] = (acc[user.company_id] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const isLastActiveAdmin = (user: ManagedUser | null) =>
    !!user
    && !user.is_banned
    && user.roles.includes('admin')
    && !!user.company_id
    && activeAdminCounts[user.company_id] === 1;

  const editWouldRemoveLastAdmin = !!editUser
    && isLastActiveAdmin(editUser)
    && (editForm.role !== 'admin' || (editForm.company_id || '') !== (editUser.company_id || ''));
  const banWouldRemoveLastAdmin = isLastActiveAdmin(banDialog);
  const deleteWouldRemoveLastAdmin = isLastActiveAdmin(deleteDialog);

  const getCompanyName = (id: string | null) => {
    if (!id) return '-';
    return companies.find((company) => company.id === id)?.name || '-';
  };

  const openEdit = (user: ManagedUser) => {
    setEditUser(user);
    const primaryRole = user.roles.find((role) => role !== 'superadmin') || user.roles[0] || 'admin';
    setEditForm({
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      company_id: user.company_id || '',
      role: primaryRole,
    });
  };

  const handleEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editUser) return;

    if (editWouldRemoveLastAdmin) {
      toast.error('Cada empresa precisa ter pelo menos um admin ativo');
      return;
    }

    await updateUser.mutateAsync({
      user_id: editUser.id,
      full_name: editForm.full_name,
      email: editForm.email,
      phone: editForm.phone,
      company_id: editForm.company_id || null,
      role: editForm.role,
    });

    setEditUser(null);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!createForm.full_name || !createForm.email || !createForm.company_id) {
      toast.error('Preencha nome, e-mail e empresa');
      return;
    }

    setCreating(true);

    try {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: {
          action: 'seed_users',
          users: [{
            full_name: createForm.full_name,
            email: createForm.email,
            phone: createForm.phone || null,
            company_id: createForm.company_id,
            role: createForm.role,
          }],
        },
      });

      if (error) throw new Error(await getFunctionErrorMessage(error));
      const result = data?.results?.[0];
      if (result?.error) throw new Error(result.error);

      if (result?.warning) {
        toast.warning(result.warning);
      }

      if (result?.access_link) {
        try {
          await navigator.clipboard.writeText(result.access_link);
          toast.success('Usuário criado. Link unico copiado.');
        } catch {
          toast.success('Usuário criado. Link unico gerado.');
        }
      } else {
        toast.success('Usuário criado com sucesso.');
      }

      qc.invalidateQueries({ queryKey: ['managed-users'] });
      setShowCreateDialog(false);
      setCreateForm({ full_name: '', email: '', phone: '', company_id: '', role: 'admin' });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Usuários</h1>
          <p className="mt-1 text-sm text-muted-foreground">Gerencie admins e operadores das empresas</p>
        </div>
        <Button className="gap-2 rounded-lg" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" />
          Novo Usuário
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          name="search_users"
          placeholder="Buscar por nome ou e-mail..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 max-w-xs rounded-lg"
          autoComplete="off"
        />
        <Select value={filterCompany} onValueChange={setFilterCompany}>
          <SelectTrigger className="h-10 w-[220px] rounded-lg" aria-label="Filtrar por empresa">
            <SelectValue placeholder="Filtrar por empresa" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as empresas</SelectItem>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="h-10 w-[180px] rounded-lg" aria-label="Filtrar por perfil">
            <SelectValue placeholder="Filtrar por perfil" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os perfis</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="operator">Operador</SelectItem>
            <SelectItem value="superadmin">Superadmin</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Card className="overflow-hidden border-none shadow-sm">
          <CardContent className="space-y-3 p-6">
            {[1, 2, 3].map((item) => <Skeleton key={item} className="h-14 w-full rounded-lg" />)}
          </CardContent>
        </Card>
      ) : error ? (
        <Card className="overflow-hidden border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <AlertTriangle className="mx-auto mb-3 h-12 w-12 text-destructive/70" />
            <p className="font-medium text-foreground">Nao foi possivel carregar os usuarios</p>
            <p className="mt-2 text-sm">{error instanceof Error ? error.message : 'Erro inesperado ao consultar usuarios.'}</p>
            <Button variant="outline" className="mt-4 gap-2 rounded-lg" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="overflow-hidden border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <UsersIcon className="mx-auto mb-3 h-12 w-12 opacity-30" />
            Nenhum usuário encontrado.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-none shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Nome</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Perfil</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.full_name || '-'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                  <TableCell className="text-sm">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Building2 className="h-3 w-3" />
                      {getCompanyName(user.company_id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {user.roles.map((role) => (
                        <Badge key={role} variant="secondary" className="text-xs">
                          {roleLabels[role] || role}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.is_banned ? (
                      <Badge variant="destructive" className="text-xs">Bloqueado</Badge>
                    ) : (
                      <Badge className="border-primary/30 bg-primary/15 text-xs text-primary hover:bg-primary/15">Ativo</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg"
                          aria-label={`Ações para ${user.full_name || user.email}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="rounded-lg">
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
            <AlertDialogTitle>
              {banDialog?.is_banned ? 'Desbloquear usuário?' : 'Bloquear usuário?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {banWouldRemoveLastAdmin
                ? 'Essa empresa ficaria sem admin ativo. Promova ou cadastre outro admin antes de bloquear este usuário.'
                : banDialog?.is_banned
                  ? `${banDialog.full_name || banDialog.email} voltará a ter acesso ao sistema.`
                  : `${banDialog?.full_name || banDialog?.email} perderá acesso imediatamente ao sistema.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (banDialog) {
                  toggleBan.mutate({ user_id: banDialog.id, ban: !banDialog.is_banned });
                }
                setBanDialog(null);
              }}
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
                ? 'Essa empresa ficaria sem admin ativo. Promova ou cadastre outro admin antes de excluir este usuário.'
                : `${deleteDialog?.full_name || deleteDialog?.email} será removido permanentemente do sistema.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteDialog) {
                  deleteUser.mutate(deleteDialog.id);
                }
                setDeleteDialog(null);
              }}
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
              Um link unico de redefinicao será gerado para {resetDialog?.full_name || resetDialog?.email}. O acesso atual será invalidado assim que a nova senha for definida.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (resetDialog) resetPassword.mutate(resetDialog.id); setResetDialog(null); }}>
              Redefinir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="users-edit-full-name">Nome completo</Label>
              <Input
                id="users-edit-full-name"
                name="full_name"
                value={editForm.full_name}
                onChange={(event) => setEditForm({ ...editForm, full_name: event.target.value })}
                autoComplete="name"
              />
            </div>
            <div>
              <Label htmlFor="users-edit-email">E-mail</Label>
              <Input
                id="users-edit-email"
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
              <Label htmlFor="users-edit-phone">Telefone</Label>
              <Input
                id="users-edit-phone"
                name="phone"
                type="tel"
                value={editForm.phone}
                onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
            <div>
              <Label>Empresa</Label>
              <Select value={editForm.company_id || 'none'} onValueChange={(value) => setEditForm({ ...editForm, company_id: value === 'none' ? '' : value })}>
                <SelectTrigger aria-label="Empresa do usuario">
                  <SelectValue placeholder="Selecione a empresa" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem empresa</SelectItem>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Perfil</Label>
              <Select value={editForm.role} onValueChange={(value) => setEditForm({ ...editForm, role: value })}>
                <SelectTrigger aria-label="Perfil do usuario">
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
                Essa alteração removeria o último admin ativo da empresa.
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>Cancelar</Button>
              <Button type="submit" disabled={updateUser.isPending || editWouldRemoveLastAdmin}>Salvar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo Usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="mt-4 space-y-4">
            <div>
              <Label htmlFor="users-create-full-name">Nome completo *</Label>
              <Input
                id="users-create-full-name"
                name="full_name"
                value={createForm.full_name}
                onChange={(event) => setCreateForm({ ...createForm, full_name: event.target.value })}
                placeholder="Nome do usuário"
                autoComplete="name"
                required
              />
            </div>
            <div>
              <Label htmlFor="users-create-email">E-mail *</Label>
              <Input
                id="users-create-email"
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
              <Label htmlFor="users-create-phone">Telefone</Label>
              <Input
                id="users-create-phone"
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
              <Label>Empresa *</Label>
              <Select value={createForm.company_id} onValueChange={(value) => setCreateForm({ ...createForm, company_id: value })}>
                <SelectTrigger aria-label="Empresa do novo usuario">
                  <SelectValue placeholder="Selecione a empresa" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Perfil *</Label>
              <Select value={createForm.role} onValueChange={(value) => setCreateForm({ ...createForm, role: value })}>
                <SelectTrigger aria-label="Perfil do novo usuario">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">Um link unico de acesso será gerado automaticamente.</p>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Criando...' : 'Criar Usuário'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
