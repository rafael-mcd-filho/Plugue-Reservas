import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import UserPasswordDialog from '@/components/users/UserPasswordDialog';
import SupportCompanyAccess from '@/components/users/SupportCompanyAccess';
import { useAuth } from '@/contexts/AuthContext';
import { useUsers, useToggleBan, useUpdateUser, useSetUserPassword, useDeleteUser, ManagedUser } from '@/hooks/useUsers';
import { useManageUserInvoker } from '@/hooks/useManageUserInvoker';
import { useCompanies } from '@/hooks/useCompanies';
import { toast } from 'sonner';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPasswordValidationMessage,
  getPhoneValidationMessage,
  normalizeEmail,
  PASSWORD_REQUIREMENTS_TEXT,
} from '@/lib/validation';

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operador',
  support: 'Suporte',
  superadmin: 'Superadmin',
};

export default function Users() {
  const navigate = useNavigate();
  const { user: currentUser, signOut } = useAuth();
  const { data: users = [], isLoading, error, refetch, isFetching } = useUsers();
  const {
    data: companies = [],
    isLoading: companiesLoading,
    error: companiesError,
    refetch: refetchCompanies,
    isFetching: companiesFetching,
  } = useCompanies();
  const toggleBan = useToggleBan();
  const updateUser = useUpdateUser();
  const setUserPassword = useSetUserPassword();
  const deleteUser = useDeleteUser();
  const qc = useQueryClient();
  const { invokeManageUser } = useManageUserInvoker();

  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '', company_id: '', role: '', support_company_ids: [] as string[] });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [passwordDialog, setPasswordDialog] = useState<ManagedUser | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<ManagedUser | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    company_id: '',
    role: 'admin',
    support_company_ids: [] as string[],
    password: '',
    confirmPassword: '',
  });

  const filtered = users.filter((user) => {
    if (filterCompany !== 'all' && (user.roles.includes('support')
      ? !user.support_company_ids?.includes(filterCompany)
      : user.company_id !== filterCompany)) return false;
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
  const editAccessUnavailable = !!editUser?.roles.includes('support') && !Array.isArray(editUser.support_company_ids);
  const editAccessBlocked = editAccessUnavailable || (editForm.role === 'support' && (companiesLoading || !!companiesError));
  const createAccessBlocked = createForm.role === 'support' && (companiesLoading || !!companiesError);

  const getCompanyName = (id: string | null) => {
    if (!id) return '-';
    return companies.find((company) => company.id === id)?.name || 'Empresa indisponível';
  };

  const openEdit = (user: ManagedUser) => {
    setEditUser(user);
    const primaryRole = user.roles.find((role) => role !== 'superadmin') || user.roles[0] || 'admin';
    setEditForm({
      full_name: user.full_name,
      email: user.email,
      phone: formatBrazilPhone(user.phone),
      company_id: user.company_id || '',
      role: primaryRole,
      support_company_ids: Array.isArray(user.support_company_ids) ? [...user.support_company_ids] : [],
    });
  };

  const reloadEditAccess = async () => {
    if (!editUser) return;
    const result = await refetch();
    const refreshedUser = result.data?.find((user) => user.id === editUser.id);
    if (!refreshedUser || !Array.isArray(refreshedUser.support_company_ids)) {
      toast.error('As autorizações continuam indisponíveis. Tente novamente.');
      return;
    }
    setEditUser(refreshedUser);
    setEditForm((form) => ({ ...form, support_company_ids: [...refreshedUser.support_company_ids] }));
  };

  const handleEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editUser) return;
    if (editAccessBlocked) {
      toast.error('Carregue as empresas e autorizações antes de salvar.');
      return;
    }

    if (editWouldRemoveLastAdmin) {
      toast.error('Cada empresa precisa ter pelo menos um admin ativo');
      return;
    }

    const emailError = getEmailValidationMessage(editForm.email, 'um e-mail', true);
    if (emailError) {
      toast.error(emailError);
      return;
    }

    const phoneError = getPhoneValidationMessage(editForm.phone, 'um telefone');
    if (phoneError) {
      toast.error(phoneError);
      return;
    }

    const normalizedEmail = normalizeEmail(editForm.email);
    const shouldReauthenticate = editUser.id === currentUser?.id
      && normalizedEmail !== normalizeEmail(editUser.email);

    try {
      await updateUser.mutateAsync({
        user_id: editUser.id,
        full_name: editForm.full_name,
        email: normalizedEmail,
        phone: formatBrazilPhone(editForm.phone),
        company_id: editForm.role === 'support' ? null : editForm.company_id || null,
        ...(editForm.role !== 'superadmin' ? { role: editForm.role } : {}),
        ...(editForm.role === 'support' ? { support_company_ids: editForm.support_company_ids } : {}),
      });
    } catch {
      return;
    }

    setEditUser(null);

    if (shouldReauthenticate) {
      toast.success('E-mail de login atualizado. Entre novamente com o novo e-mail.');
      await signOut();
      navigate('/login', { replace: true });
    }
  };

  const handleSetPassword = async (password: string) => {
    if (!passwordDialog) return;

    const targetUser = passwordDialog;

    await setUserPassword.mutateAsync({
      user_id: targetUser.id,
      password,
    });

    setPasswordDialog(null);

    if (targetUser.id === currentUser?.id) {
      toast.success('Senha atualizada. Entre novamente com a nova senha.');
      await signOut();
      navigate('/login', { replace: true });
      return;
    }

    toast.success('Senha atualizada.');
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!createForm.full_name || !createForm.email || (createForm.role !== 'support' && !createForm.company_id)) {
      toast.error(createForm.role === 'support' ? 'Preencha nome e e-mail' : 'Preencha nome, e-mail e empresa');
      return;
    }
    if (createAccessBlocked) {
      toast.error('Carregue as empresas antes de selecionar os acessos.');
      return;
    }

    const emailError = getEmailValidationMessage(createForm.email, 'um e-mail', true);
    if (emailError) {
      toast.error(emailError);
      return;
    }

    const phoneError = getPhoneValidationMessage(createForm.phone, 'um telefone');
    if (phoneError) {
      toast.error(phoneError);
      return;
    }

    const passwordError = getPasswordValidationMessage(createForm.password);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    if (createForm.password !== createForm.confirmPassword) {
      toast.error('As senhas precisam ser iguais.');
      return;
    }

    setCreating(true);

    try {
      const data = await invokeManageUser<{ results?: Array<{ error?: string; warning?: string; access_link?: string }> }>({
        action: 'seed_users',
        users: [{
          full_name: createForm.full_name,
          email: normalizeEmail(createForm.email),
          phone: formatBrazilPhone(createForm.phone) || null,
          company_id: createForm.role === 'support' ? null : createForm.company_id,
          role: createForm.role,
          ...(createForm.role === 'support' ? { support_company_ids: createForm.support_company_ids } : {}),
          password: createForm.password,
        }],
      });
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
      setCreateForm({
        full_name: '',
        email: '',
        phone: '',
        company_id: '',
        role: 'admin',
        support_company_ids: [],
        password: '',
        confirmPassword: '',
      });
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
          <p className="mt-1 text-sm text-muted-foreground">Gerencie admins, operadores e acessos de Suporte</p>
        </div>
        <Button className="gap-2 rounded-lg" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" />
          Novo Usuário
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Input
          name="search_users"
          placeholder="Buscar por nome ou e-mail..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 w-full rounded-lg sm:max-w-xs"
          autoComplete="off"
        />
        <Select value={filterCompany} onValueChange={setFilterCompany}>
          <SelectTrigger className="h-10 w-full rounded-lg sm:w-[220px]" aria-label="Filtrar por empresa">
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
          <SelectTrigger className="h-10 w-full rounded-lg sm:w-[180px]" aria-label="Filtrar por perfil">
            <SelectValue placeholder="Filtrar por perfil" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os perfis</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="operator">Operador</SelectItem>
            <SelectItem value="support">Suporte</SelectItem>
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
            <p className="font-medium text-foreground">Não foi possível carregar os usuários</p>
            <p className="mt-2 text-sm">{error instanceof Error ? error.message : 'Erro inesperado ao consultar usuários.'}</p>
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
                <TableHead>Empresas</TableHead>
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
                    {user.roles.includes('support') ? (
                      <div className="max-w-xs space-y-1">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Building2 className="h-3 w-3 shrink-0" />
                          {Array.isArray(user.support_company_ids)
                            ? `${user.support_company_ids.length} ${user.support_company_ids.length === 1 ? 'empresa autorizada' : 'empresas autorizadas'}`
                            : 'Autorizações indisponíveis'}
                        </span>
                        {!!user.support_company_ids?.length && (
                          <p className="break-words text-xs text-muted-foreground">
                            {user.support_company_ids.map(getCompanyName).join(', ')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Building2 className="h-3 w-3" />
                        {getCompanyName(user.company_id)}
                      </span>
                    )}
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
                        <DropdownMenuItem onClick={() => setPasswordDialog(user)}>
                          <KeyRound className="mr-2 h-4 w-4" />
                          Alterar senha
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

      <UserPasswordDialog
        open={!!passwordDialog}
        onOpenChange={(open) => !open && setPasswordDialog(null)}
        title="Alterar senha"
        description={`Defina uma nova senha para ${passwordDialog?.full_name || passwordDialog?.email || 'este usuario'}.`}
        submitLabel="Salvar senha"
        submitting={setUserPassword.isPending}
        onSubmit={handleSetPassword}
      />

      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Usuário</DialogTitle>
            <DialogDescription>Atualize o cadastro, o perfil e as empresas às quais este usuário pode acessar.</DialogDescription>
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
                onChange={(event) => setEditForm({ ...editForm, phone: formatBrazilPhone(event.target.value) })}
                autoComplete="tel"
                inputMode="tel"
                maxLength={15}
              />
            </div>
            <div>
              <Label>Perfil</Label>
              {editForm.role === 'superadmin' ? (
                <Input aria-label="Perfil do usuario" value="Superadmin" readOnly />
              ) : (
                <Select value={editForm.role} onValueChange={(value) => setEditForm({ ...editForm, role: value })} disabled={updateUser.isPending}>
                  <SelectTrigger aria-label="Perfil do usuario">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="operator">Operador</SelectItem>
                    <SelectItem value="support" disabled={editUser?.roles.includes('superadmin')}>Suporte</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            {editForm.role === 'support' ? (
              <SupportCompanyAccess
                companies={companies}
                selectedIds={editForm.support_company_ids}
                onChange={(ids) => setEditForm({ ...editForm, support_company_ids: ids })}
                isLoading={companiesLoading}
                isFetching={companiesFetching || isFetching}
                error={companiesError}
                unavailable={editAccessUnavailable}
                disabled={updateUser.isPending}
                onRetry={() => {
                  void refetchCompanies();
                  if (editAccessUnavailable) void reloadEditAccess();
                }}
              />
            ) : (
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
            )}
            {editAccessUnavailable && editForm.role !== 'support' && (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>Não foi possível carregar as autorizações deste usuário. Recarregue antes de salvar.</p>
                <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={reloadEditAccess}>
                  Tentar novamente
                </Button>
              </div>
            )}
            {editWouldRemoveLastAdmin && (
              <p className="text-sm text-destructive">
                Essa alteração removeria o último admin ativo da empresa.
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>Cancelar</Button>
              <Button type="submit" disabled={updateUser.isPending || editWouldRemoveLastAdmin || editAccessBlocked}>Salvar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Novo Usuário</DialogTitle>
            <DialogDescription>Defina o perfil e os acessos do novo usuário.</DialogDescription>
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
                onChange={(event) => setCreateForm({ ...createForm, phone: formatBrazilPhone(event.target.value) })}
                placeholder="(11) 99999-9999"
                autoComplete="tel"
                inputMode="tel"
                maxLength={15}
              />
            </div>
            <div>
              <Label>Perfil *</Label>
              <Select value={createForm.role} onValueChange={(value) => setCreateForm({ ...createForm, role: value })} disabled={creating}>
                <SelectTrigger aria-label="Perfil do novo usuario">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                  <SelectItem value="support">Suporte</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {createForm.role === 'support' ? (
              <SupportCompanyAccess
                companies={companies}
                selectedIds={createForm.support_company_ids}
                onChange={(ids) => setCreateForm({ ...createForm, support_company_ids: ids })}
                isLoading={companiesLoading}
                isFetching={companiesFetching}
                error={companiesError}
                disabled={creating}
                onRetry={() => { void refetchCompanies(); }}
              />
            ) : (
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
            )}
            <p className="text-xs text-muted-foreground">O usuário entrará com o e-mail e a senha definidos no cadastro.</p>
            <div>
              <Label htmlFor="users-create-password">Senha inicial *</Label>
              <Input
                id="users-create-password"
                name="password"
                type="password"
                value={createForm.password}
                onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
                placeholder="Defina a senha de acesso"
                autoComplete="new-password"
                required
              />
              <p className="mt-1 text-xs text-muted-foreground">{PASSWORD_REQUIREMENTS_TEXT}</p>
            </div>
            <div>
              <Label htmlFor="users-create-confirm-password">Confirmar senha *</Label>
              <Input
                id="users-create-confirm-password"
                name="confirm_password"
                type="password"
                value={createForm.confirmPassword}
                onChange={(event) => setCreateForm({ ...createForm, confirmPassword: event.target.value })}
                placeholder="Repita a senha"
                autoComplete="new-password"
                required
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
              <Button type="submit" disabled={creating || createAccessBlocked}>
                {creating ? 'Criando...' : 'Criar Usuário'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
