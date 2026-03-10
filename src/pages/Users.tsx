import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Users as UsersIcon, Shield, ShieldOff, Pencil, KeyRound, Building2, Plus, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useUsers, useToggleBan, useUpdateUser, useResetPassword, ManagedUser } from '@/hooks/useUsers';
import { useCompanies } from '@/hooks/useCompanies';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operador',
  superadmin: 'Superadmin',
};

export default function Users() {
  const { data: users = [], isLoading } = useUsers();
  const { data: companies = [] } = useCompanies();
  const toggleBan = useToggleBan();
  const updateUser = useUpdateUser();
  const resetPassword = useResetPassword();
  const qc = useQueryClient();

  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '', company_id: '', role: '' });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [resetDialog, setResetDialog] = useState<ManagedUser | null>(null);

  // New user state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ full_name: '', email: '', phone: '', company_id: '', role: 'admin' });

  const filtered = users.filter(u => {
    if (filterCompany !== 'all' && u.company_id !== filterCompany) return false;
    if (filterRole !== 'all' && !u.roles.includes(filterRole)) return false;
    if (search) {
      const q = search.toLowerCase();
      return u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    }
    return true;
  });

  const getCompanyName = (id: string | null) => {
    if (!id) return '—';
    return companies.find(c => c.id === id)?.name || '—';
  };

  const openEdit = (user: ManagedUser) => {
    setEditUser(user);
    const primaryRole = user.roles.find(r => r !== 'superadmin') || user.roles[0] || 'admin';
    setEditForm({ full_name: user.full_name, email: user.email, phone: user.phone, company_id: user.company_id || '', role: primaryRole });
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
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
      if (error) throw error;
      const result = data?.results?.[0];
      if (result?.error) throw new Error(result.error);
      toast.success(`Usuário criado! Senha temporária: ${result.temp_password}`, { duration: 15000 });
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Usuários</h1>
          <p className="text-muted-foreground mt-1">Gerencie admins e operadores das empresas</p>
        </div>
        <Button className="gap-2" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" /> Novo Usuário
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Buscar por nome ou e-mail..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={filterCompany} onValueChange={setFilterCompany}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Filtrar por empresa" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as empresas</SelectItem>
            {companies.map(c => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-[180px]">
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
        <Card className="border-none shadow-sm">
          <CardContent className="p-6 space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <UsersIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
            Nenhum usuário encontrado.
          </CardContent>
        </Card>
      ) : (
        <Card className="border-none shadow-sm overflow-hidden">
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
              {filtered.map(user => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.full_name || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                  <TableCell className="text-sm">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Building2 className="h-3 w-3" /> {getCompanyName(user.company_id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {user.roles.map(r => (
                        <Badge key={r} variant="secondary" className="text-xs">
                          {roleLabels[r] || r}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.is_banned ? (
                      <Badge variant="destructive" className="text-xs">Bloqueado</Badge>
                    ) : (
                      <Badge className="text-xs bg-primary/15 text-primary border-primary/30 hover:bg-primary/15">Ativo</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(user)}>
                          <Pencil className="h-4 w-4 mr-2" /> Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setResetDialog(user)}>
                          <KeyRound className="h-4 w-4 mr-2" /> Redefinir senha
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={user.is_banned ? 'text-primary focus:text-primary' : 'text-destructive focus:text-destructive'}
                          onClick={() => setBanDialog(user)}
                        >
                          {user.is_banned ? (
                            <><Shield className="h-4 w-4 mr-2" /> Desbloquear</>
                          ) : (
                            <><ShieldOff className="h-4 w-4 mr-2" /> Bloquear</>
                          )}
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

      {/* Ban confirmation */}
      <AlertDialog open={!!banDialog} onOpenChange={open => !open && setBanDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {banDialog?.is_banned ? 'Desbloquear usuário?' : 'Bloquear usuário?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {banDialog?.is_banned
                ? `${banDialog.full_name || banDialog.email} voltará a ter acesso ao sistema.`
                : `${banDialog?.full_name || banDialog?.email} perderá acesso imediatamente ao sistema.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (banDialog) toggleBan.mutate({ user_id: banDialog.id, ban: !banDialog.is_banned }); setBanDialog(null); }}
              className={banDialog?.is_banned ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {banDialog?.is_banned ? 'Desbloquear' : 'Bloquear'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset password confirmation */}
      <AlertDialog open={!!resetDialog} onOpenChange={open => !open && setResetDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Redefinir senha?</AlertDialogTitle>
            <AlertDialogDescription>
              Uma nova senha temporária será gerada para {resetDialog?.full_name || resetDialog?.email}. A senha atual será invalidada imediatamente.
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

      {/* Edit Dialog */}
      <Dialog open={!!editUser} onOpenChange={open => !open && setEditUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4 mt-4">
            <div>
              <Label>Nome completo</Label>
              <Input value={editForm.full_name} onChange={e => setEditForm({ ...editForm, full_name: e.target.value })} />
            </div>
            <div>
              <Label>E-mail</Label>
              <Input type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div>
              <Label>Telefone</Label>
              <Input value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>Cancelar</Button>
              <Button type="submit" disabled={updateUser.isPending}>Salvar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create User Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo Usuário</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-4">
            <div>
              <Label>Nome completo *</Label>
              <Input value={createForm.full_name} onChange={e => setCreateForm({ ...createForm, full_name: e.target.value })} placeholder="Nome do usuário" required />
            </div>
            <div>
              <Label>E-mail *</Label>
              <Input type="email" value={createForm.email} onChange={e => setCreateForm({ ...createForm, email: e.target.value })} placeholder="email@empresa.com" required />
            </div>
            <div>
              <Label>Telefone</Label>
              <Input value={createForm.phone} onChange={e => setCreateForm({ ...createForm, phone: e.target.value })} placeholder="(11) 99999-9999" />
            </div>
            <div>
              <Label>Empresa *</Label>
              <Select value={createForm.company_id} onValueChange={v => setCreateForm({ ...createForm, company_id: v })}>
                <SelectTrigger><SelectValue placeholder="Selecione a empresa" /></SelectTrigger>
                <SelectContent>
                  {companies.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Perfil *</Label>
              <Select value={createForm.role} onValueChange={v => setCreateForm({ ...createForm, role: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="operator">Operador</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">Uma senha temporária será gerada automaticamente.</p>
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
