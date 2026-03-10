import { useState } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Users as UsersIcon, Shield, ShieldOff, Pencil, KeyRound, Plus, MoreHorizontal } from 'lucide-react';
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
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { ManagedUser } from '@/hooks/useUsers';

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operador',
};

export default function CompanyUsers() {
  const { companyId, companyName } = useCompanySlug();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [editForm, setEditForm] = useState({ full_name: '', email: '', phone: '' });
  const [banDialog, setBanDialog] = useState<ManagedUser | null>(null);
  const [resetDialog, setResetDialog] = useState<ManagedUser | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ full_name: '', email: '', phone: '', role: 'operator' });

  // Fetch users for this company only
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['company-users', companyId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: { action: 'list_users' },
      });
      if (error) throw error;
      const allUsers = (data?.users ?? []) as ManagedUser[];
      return allUsers.filter(u => u.company_id === companyId);
    },
  });

  const filtered = users.filter(u => {
    if (filterRole !== 'all' && !u.roles.includes(filterRole)) return false;
    if (search) {
      const q = search.toLowerCase();
      return u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    }
    return true;
  });

  const openEdit = (user: ManagedUser) => {
    setEditUser(user);
    setEditForm({ full_name: user.full_name, email: user.email, phone: user.phone });
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    try {
      const { error } = await supabase.functions.invoke('manage-user', {
        body: { action: 'update_user', user_id: editUser.id, ...editForm },
      });
      if (error) throw error;
      toast.success('Usuário atualizado!');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
      setEditUser(null);
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
  };

  const handleToggleBan = async (user: ManagedUser) => {
    try {
      const { error } = await supabase.functions.invoke('manage-user', {
        body: { action: 'toggle_ban', user_id: user.id, ban: !user.is_banned },
      });
      if (error) throw error;
      toast.success(user.is_banned ? 'Usuário desbloqueado!' : 'Usuário bloqueado!');
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
    setBanDialog(null);
  };

  const handleResetPassword = async (userId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('manage-user', {
        body: { action: 'reset_password', user_id: userId },
      });
      if (error) throw error;
      toast.success(`Senha redefinida! Nova senha: ${data.temp_password}`, { duration: 15000 });
      qc.invalidateQueries({ queryKey: ['company-users', companyId] });
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
    setResetDialog(null);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.full_name || !createForm.email) {
      toast.error('Preencha nome e e-mail');
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
            company_id: companyId,
            role: createForm.role,
          }],
        },
      });
      if (error) throw error;
      const result = data?.results?.[0];
      if (result?.error) throw new Error(result.error);
      toast.success(`Usuário criado! Senha temporária: ${result.temp_password}`, { duration: 15000 });
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Usuários</h1>
          <p className="text-muted-foreground mt-1">Gerencie os usuários de {companyName}</p>
        </div>
        <Button className="gap-2" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" /> Novo Usuário
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Input placeholder="Buscar por nome ou e-mail..." value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Filtrar por perfil" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os perfis</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="operator">Operador</SelectItem>
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
                  <TableCell>
                    <div className="flex gap-1">
                      {user.roles.filter(r => r !== 'superadmin').map(r => (
                        <Badge key={r} variant="secondary" className="text-xs">{roleLabels[r] || r}</Badge>
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
                        <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
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
                          {user.is_banned ? <><Shield className="h-4 w-4 mr-2" /> Desbloquear</> : <><ShieldOff className="h-4 w-4 mr-2" /> Bloquear</>}
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
            <AlertDialogTitle>{banDialog?.is_banned ? 'Desbloquear usuário?' : 'Bloquear usuário?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {banDialog?.is_banned
                ? `${banDialog.full_name || banDialog.email} voltará a ter acesso ao sistema.`
                : `${banDialog?.full_name || banDialog?.email} perderá acesso imediatamente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => banDialog && handleToggleBan(banDialog)}
              className={banDialog?.is_banned ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {banDialog?.is_banned ? 'Desbloquear' : 'Bloquear'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset password */}
      <AlertDialog open={!!resetDialog} onOpenChange={open => !open && setResetDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Redefinir senha?</AlertDialogTitle>
            <AlertDialogDescription>
              Uma nova senha temporária será gerada para {resetDialog?.full_name || resetDialog?.email}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => resetDialog && handleResetPassword(resetDialog.id)}>Redefinir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Dialog */}
      <Dialog open={!!editUser} onOpenChange={open => !open && setEditUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Editar Usuário</DialogTitle></DialogHeader>
          <form onSubmit={handleEdit} className="space-y-4 mt-4">
            <div><Label>Nome completo</Label><Input value={editForm.full_name} onChange={e => setEditForm({ ...editForm, full_name: e.target.value })} /></div>
            <div><Label>E-mail</Label><Input type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} /></div>
            <div><Label>Telefone</Label><Input value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} /></div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setEditUser(null)}>Cancelar</Button>
              <Button type="submit">Salvar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create User Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Novo Usuário</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4 mt-4">
            <div><Label>Nome completo *</Label><Input value={createForm.full_name} onChange={e => setCreateForm({ ...createForm, full_name: e.target.value })} placeholder="Nome do usuário" required /></div>
            <div><Label>E-mail *</Label><Input type="email" value={createForm.email} onChange={e => setCreateForm({ ...createForm, email: e.target.value })} placeholder="email@empresa.com" required /></div>
            <div><Label>Telefone</Label><Input value={createForm.phone} onChange={e => setCreateForm({ ...createForm, phone: e.target.value })} placeholder="(11) 99999-9999" /></div>
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
            <p className="text-xs text-muted-foreground">O usuário será vinculado automaticamente a {companyName}. Uma senha temporária será gerada.</p>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
              <Button type="submit" disabled={creating}>{creating ? 'Criando...' : 'Criar Usuário'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
