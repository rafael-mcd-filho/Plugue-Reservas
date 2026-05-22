import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
import { Checkbox } from '@/components/ui/checkbox';
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
import UserPasswordDialog from '@/components/users/UserPasswordDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  buildOperatorPermissionOverrides,
  COMPANY_PANEL_PERMISSION_METADATA,
  getCompanyPanelPermissionSelection,
  getDefaultOperatorPermissionSelection,
  OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS,
  type CompanyPanelPermission,
} from '@/lib/companyPermissions';
import {
  formatBrazilPhone,
  getEmailValidationMessage,
  getPasswordValidationMessage,
  getPhoneValidationMessage,
  normalizeEmail,
  PASSWORD_REQUIREMENTS_TEXT,
} from '@/lib/validation';
import type { ManagedUser } from '@/hooks/useUsers';
import { useManageUserInvoker } from '@/hooks/useManageUserInvoker';

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

type OperatorPermissionSelection = Record<CompanyPanelPermission, boolean>;

function createDefaultOperatorPermissionSelection(): OperatorPermissionSelection {
  return { ...getDefaultOperatorPermissionSelection() };
}

function createOperatorPermissionSelection(
  overrides?: Partial<Record<CompanyPanelPermission, boolean>> | null,
): OperatorPermissionSelection {
  return { ...getCompanyPanelPermissionSelection(['operator'], overrides) };
}

function toggleOperatorPermission(
  current: OperatorPermissionSelection,
  permission: CompanyPanelPermission,
  checked: boolean,
): OperatorPermissionSelection {
  const next = {
    ...current,
    [permission]: checked,
  };

  if (permission === 'reservations_view' && !checked) {
    next.reservations_delete = false;
  }

  if (permission === 'reservations_delete' && checked) {
    next.reservations_view = true;
  }

  return next;
}

function hasCustomOperatorAccess(user: ManagedUser) {
  return user.roles.includes('operator')
    && !!user.company_panel_permission_overrides
    && Object.keys(user.company_panel_permission_overrides).length > 0;
}

function hasMatchingOperatorPermissions(
  left?: Partial<Record<CompanyPanelPermission, boolean>> | null,
  right?: Partial<Record<CompanyPanelPermission, boolean>> | null,
) {
  const leftSelection = getCompanyPanelPermissionSelection(['operator'], left);
  const rightSelection = getCompanyPanelPermissionSelection(['operator'], right);

  return OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS.every(
    (permission) => leftSelection[permission] === rightSelection[permission],
  );
}

function OperatorPermissionEditor({
  value,
  onChange,
}: {
  value: OperatorPermissionSelection;
  onChange: (next: OperatorPermissionSelection) => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">Acessos do operador</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Admin segue com acesso total. Aqui você define só os módulos liberados para operador.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onChange(createDefaultOperatorPermissionSelection())}
        >
          Restaurar padrão
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {OPERATOR_ASSIGNABLE_COMPANY_PANEL_PERMISSIONS.map((permission) => {
          const metadata = COMPANY_PANEL_PERMISSION_METADATA[permission];
          const checked = value[permission];
          const disabled = permission === 'reservations_delete' && !value.reservations_view;

          return (
            <label
              key={permission}
              className={cn(
                'flex items-start gap-3 rounded-xl border border-border/70 bg-card p-3 transition-colors',
                checked ? 'border-primary/30 bg-primary-soft/40' : 'hover:border-border',
                disabled && 'opacity-60',
              )}
            >
              <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(nextChecked) => onChange(
                  toggleOperatorPermission(value, permission, nextChecked === true),
                )}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{metadata.label}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{metadata.description}</p>
              </div>
            </label>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Dica: desmarcar <strong>Reservas</strong> tamb&eacute;m remove a exclus&atilde;o definitiva.
      </p>
    </div>
  );
}

export default function CompanyUsers() {
  const navigate = useNavigate();
  const { user: currentUser, signOut } = useAuth();
  const { companyId, companyName } = useCompanySlug();
  const qc = useQueryClient();
  const { invokeManageUser, manageUserScopeKey } = useManageUserInvoker();

  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    role: 'operator',
    operatorPermissions: createDefaultOperatorPermissionSelection(),
  });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [passwordDialog, setPasswordDialog] = useState<ManagedUser | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<ManagedUser | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [createForm, setCreateForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    role: 'operator',
    operatorPermissions: createDefaultOperatorPermissionSelection(),
    password: '',
    confirmPassword: '',
  });

  const {
    data: users = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['company-users', companyId, manageUserScopeKey],
    queryFn: async () => {
      const data = await invokeManageUser<{ users?: ManagedUser[] }>({
        action: 'list_users',
        company_id: companyId,
      });
      const allUsers = (data?.users ?? []) as ManagedUser[];
      return allUsers.filter((user) => user.company_id === companyId);
    },
    enabled: !!companyId,
    retry: false,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
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
      phone: formatBrazilPhone(user.phone),
      role: primaryRole,
      operatorPermissions: createOperatorPermissionSelection(
        primaryRole === 'operator' ? user.company_panel_permission_overrides : null,
      ),
    });
  };

  const handleEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editUser) return;

    if (editWouldRemoveLastAdmin) {
      toast.error('A unidade precisa manter ao menos um admin ativo.');
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

    try {
      const normalizedEmail = normalizeEmail(editForm.email);
      const shouldReauthenticate = editUser.id === currentUser?.id
        && normalizedEmail !== normalizeEmail(editUser.email);
      const expectedRole = editForm.role;
      const expectedPermissionOverrides = expectedRole === 'operator'
        ? buildOperatorPermissionOverrides(editForm.operatorPermissions)
        : null;

      await invokeManageUser({
        action: 'update_user',
        user_id: editUser.id,
        full_name: editForm.full_name,
        email: normalizedEmail,
        phone: formatBrazilPhone(editForm.phone),
        company_id: companyId,
        role: expectedRole,
        company_panel_permission_overrides: expectedPermissionOverrides,
      });

      const refreshedResult = await refetch();
      const refreshedUser = (refreshedResult.data ?? []).find((user) => user.id === editUser.id);

      if (!refreshedUser) {
        throw new Error('Usuário atualizado, mas não foi possível confirmar os dados após salvar.');
      }

      if (!refreshedUser.roles.includes(expectedRole)) {
        throw new Error('O perfil do usuário não foi atualizado corretamente no backend.');
      }

      if (
        expectedRole === 'operator'
        && !hasMatchingOperatorPermissions(
          refreshedUser.company_panel_permission_overrides,
          expectedPermissionOverrides,
        )
      ) {
        throw new Error(
          'As permissões do operador não foram persistidas no backend. Verifique se a migration e a função manage-user estão publicadas.',
        );
      }

      toast.success('Usuário atualizado.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
      qc.invalidateQueries({ queryKey: ['company-panel-permission-overrides', companyId, editUser.id] });
      setEditUser(null);

      if (shouldReauthenticate) {
        toast.success('E-mail de login atualizado. Entre novamente com o novo e-mail.');
        await signOut();
        navigate('/login', { replace: true });
      }
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
  };

  const handleToggleBan = async (user: ManagedUser) => {
    try {
      await invokeManageUser({
        action: 'toggle_ban',
        user_id: user.id,
        ban: !user.is_banned,
      });

      toast.success(user.is_banned ? 'Usuário desbloqueado.' : 'Usuário bloqueado.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setBanDialog(null);
    }
  };

  const handleSetPassword = async (password: string) => {
    if (!passwordDialog) return;

    try {
      setChangingPassword(true);
      const targetUser = passwordDialog;

      await invokeManageUser({
        action: 'set_user_password',
        user_id: targetUser.id,
        password,
      });

      toast.success('Senha atualizada.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });

      if (targetUser.id === currentUser?.id) {
        toast.success('Senha atualizada. Entre novamente com a nova senha.');
        await signOut();
        navigate('/login', { replace: true });
      }
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setChangingPassword(false);
      setPasswordDialog(null);
    }
  };

  const handleDeleteUser = async (user: ManagedUser) => {
    try {
      await invokeManageUser({
        action: 'delete_user',
        user_id: user.id,
      });

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
      const data = await invokeManageUser<{ results?: Array<{ error?: string; warning?: string }> }>({
        action: 'seed_users',
        users: [
          {
            full_name: createForm.full_name,
            email: normalizeEmail(createForm.email),
            phone: formatBrazilPhone(createForm.phone) || null,
            company_id: companyId,
            role: createForm.role,
            company_panel_permission_overrides: createForm.role === 'operator'
              ? buildOperatorPermissionOverrides(createForm.operatorPermissions)
              : null,
            password: createForm.password,
          },
        ],
      });

      const result = data?.results?.[0];
      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.warning) {
        toast.warning(result.warning);
      }

      toast.success('Usuario criado com senha definida.');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
      setShowCreateDialog(false);
      setCreateForm({
        full_name: '',
        email: '',
        phone: '',
        role: 'operator',
        operatorPermissions: createDefaultOperatorPermissionSelection(),
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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Usuários</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gerencie os usuários de {companyName}
          </p>
        </div>

        <Button className="gap-2 self-start rounded-lg px-4" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" />
          Novo usuário
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
            <p className="font-medium text-foreground">Não foi possível carregar os usuários.</p>
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
                  Ações
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
                    {hasCustomOperatorAccess(user) && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Acesso do operador personalizado
                      </p>
                    )}
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
                          aria-label={`Ações para ${user.full_name || user.email}`}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52 rounded-lg">
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

      <UserPasswordDialog
        open={!!passwordDialog}
        onOpenChange={(open) => !open && setPasswordDialog(null)}
        title="Alterar senha"
        description={`Defina uma nova senha para ${passwordDialog?.full_name || passwordDialog?.email || 'este usuario'}.`}
        submitLabel="Salvar senha"
        submitting={changingPassword}
        onSubmit={handleSetPassword}
      />

      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>Editar usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="mt-4 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
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
                  onChange={(event) => setEditForm({ ...editForm, phone: formatBrazilPhone(event.target.value) })}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={15}
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
              {editForm.role === 'operator' ? (
                <OperatorPermissionEditor
                  value={editForm.operatorPermissions}
                  onChange={(next) => setEditForm({ ...editForm, operatorPermissions: next })}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Admin tem acesso completo fixo em todos os m&oacute;dulos da unidade.
                </p>
              )}
              {editWouldRemoveLastAdmin && (
                <p className="text-sm text-destructive">
                  A unidade precisa manter ao menos um admin ativo.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t pt-4 mt-4 shrink-0">
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
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>Novo usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="mt-4 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
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
                  onChange={(event) => setCreateForm({ ...createForm, phone: formatBrazilPhone(event.target.value) })}
                  placeholder="(11) 99999-9999"
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={15}
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
              {createForm.role === 'operator' ? (
                <OperatorPermissionEditor
                  value={createForm.operatorPermissions}
                  onChange={(next) => setCreateForm({ ...createForm, operatorPermissions: next })}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Admin tem acesso completo fixo em todos os m&oacute;dulos da unidade.
                </p>
              )}

              <div>
                <Label htmlFor="create-user-password">Senha inicial *</Label>
                <Input
                  id="create-user-password"
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
                <Label htmlFor="create-user-confirm-password">Confirmar senha *</Label>
                <Input
                  id="create-user-confirm-password"
                  name="confirm_password"
                  type="password"
                  value={createForm.confirmPassword}
                  onChange={(event) => setCreateForm({ ...createForm, confirmPassword: event.target.value })}
                  placeholder="Repita a senha"
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t pt-4 mt-4 shrink-0">
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
