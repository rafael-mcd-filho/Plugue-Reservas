import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, Pause, Play, ArrowUpDown, Building2, Circle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanies, useCreateCompany, useUpdateCompany, useDeleteCompany, Company, CompanyInsert, CompanyStatus } from '@/hooks/useCompanies';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

const statusConfig: Record<CompanyStatus, { label: string; className: string }> = {
  active: { label: 'Ativa', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  paused: { label: 'Pausada', className: 'bg-amber-100 text-amber-700 border-amber-200' },
};

const emptyForm: CompanyInsert = {
  name: '', slug: '', razao_social: '', cnpj: '', phone: '', email: '',
  address: '', responsible_name: '', responsible_email: '', responsible_phone: '',
  instagram: '', whatsapp: '', google_maps_url: '', description: '', logo_url: '',
  status: 'active',
};

type SortField = 'name' | 'cnpj' | 'status' | 'created_at';
type SortDir = 'asc' | 'desc';

export default function Companies() {
  const navigate = useNavigate();
  const { data: companies = [], isLoading } = useCompanies();
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [form, setForm] = useState<CompanyInsert>(emptyForm);
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const filtered = companies
    .filter(c => statusFilter === 'all' || c.status === statusFilter)
    .filter(c =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.cnpj && c.cnpj.includes(search)) ||
      (c.responsible_name && c.responsible_name.toLowerCase().includes(search.toLowerCase()))
    )
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      const valA = a[sortField] ?? '';
      const valB = b[sortField] ?? '';
      return valA < valB ? -dir : valA > valB ? dir : 0;
    });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setDialogOpen(true); };

  const openEdit = (c: Company, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(c);
    setForm({
      name: c.name, slug: c.slug, razao_social: c.razao_social || '', cnpj: c.cnpj || '',
      phone: c.phone || '', email: c.email || '', address: c.address || '',
      responsible_name: c.responsible_name || '', responsible_email: c.responsible_email || '',
      responsible_phone: c.responsible_phone || '', status: c.status,
      instagram: c.instagram || '', whatsapp: c.whatsapp || '', google_maps_url: c.google_maps_url || '',
      description: c.description || '', logo_url: c.logo_url || '',
    });
    setDialogOpen(true);
  };

  const handleNameChange = (name: string) => {
    setForm(prev => ({ ...prev, name, slug: !editing ? slugify(name) : prev.slug }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.slug) return;
    if (!editing && !form.responsible_email) return;
    if (editing) {
      await updateCompany.mutateAsync({ id: editing.id, ...form });
    } else {
      await createCompany.mutateAsync(form);
    }
    setDialogOpen(false);
  };

  const togglePause = (c: Company, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus: CompanyStatus = c.status === 'paused' ? 'active' : 'paused';
    updateCompany.mutate({ id: c.id, status: newStatus });
  };

  const counts = {
    all: companies.length,
    active: companies.filter(c => c.status === 'active').length,
    paused: companies.filter(c => c.status === 'paused').length,
  };

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <Button variant="ghost" size="sm" className="gap-1 -ml-3 h-auto py-1 font-medium" onClick={() => toggleSort(field)}>
      {children}
      <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
    </Button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Empresas</h1>
          <p className="text-muted-foreground mt-1">Gerencie as empresas cadastradas no sistema</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" /> Nova Empresa</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Editar Empresa' : 'Nova Empresa'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-5 mt-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Dados da Empresa</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Nome Fantasia *</Label>
                  <Input value={form.name} onChange={e => handleNameChange(e.target.value)} placeholder="Nome fantasia" />
                </div>
                <div>
                  <Label>Slug *</Label>
                  <Input value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value })} placeholder="slug-empresa" />
                </div>
                <div>
                  <Label>Razão Social</Label>
                  <Input value={form.razao_social || ''} onChange={e => setForm({ ...form, razao_social: e.target.value })} placeholder="Razão social completa" />
                </div>
                <div>
                  <Label>CNPJ</Label>
                  <Input value={form.cnpj || ''} onChange={e => setForm({ ...form, cnpj: e.target.value })} placeholder="00.000.000/0001-00" />
                </div>
                <div>
                  <Label>Telefone</Label>
                  <Input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="(11) 3333-4444" />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input type="email" value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="contato@empresa.com" />
                </div>
                <div className="col-span-2">
                  <Label>Endereço</Label>
                  <Textarea value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="Endereço completo" rows={2} />
                </div>
              </div>

              <div className="space-y-1 pt-2">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Responsável (Admin)</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Nome do Responsável</Label>
                  <Input value={form.responsible_name || ''} onChange={e => setForm({ ...form, responsible_name: e.target.value })} placeholder="Nome completo" />
                </div>
                <div>
                  <Label>Email do Responsável (login) {!editing && '*'}</Label>
                  <Input type="email" value={form.responsible_email || ''} onChange={e => setForm({ ...form, responsible_email: e.target.value })} placeholder="admin@empresa.com" />
                </div>
                <div>
                  <Label>Telefone do Responsável</Label>
                  <Input value={form.responsible_phone || ''} onChange={e => setForm({ ...form, responsible_phone: e.target.value })} placeholder="(11) 99999-9999" />
                </div>
                {editing && (
                  <div>
                    <Label>Status</Label>
                    <Select value={form.status} onValueChange={v => setForm({ ...form, status: v as CompanyStatus })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Ativa</SelectItem>
                        <SelectItem value="paused">Pausada</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div className="space-y-1 pt-2">
                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Redes Sociais e Mapa</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Instagram</Label>
                  <Input value={form.instagram || ''} onChange={e => setForm({ ...form, instagram: e.target.value })} placeholder="@restaurante" />
                </div>
                <div>
                  <Label>WhatsApp</Label>
                  <Input value={form.whatsapp || ''} onChange={e => setForm({ ...form, whatsapp: e.target.value })} placeholder="5511999999999" />
                </div>
                <div className="col-span-2">
                  <Label>Link do Google Maps (embed)</Label>
                  <Input value={form.google_maps_url || ''} onChange={e => setForm({ ...form, google_maps_url: e.target.value })} placeholder="https://www.google.com/maps/embed?pb=..." />
                </div>
                <div className="col-span-2">
                  <Label>Descrição (visível na página pública)</Label>
                  <Textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Breve descrição do restaurante" rows={3} />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
                <Button type="submit" disabled={createCompany.isPending || updateCompany.isPending}>
                  {editing ? 'Salvar' : 'Criar Empresa'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome, CNPJ ou responsável..." value={search} onChange={e => setSearch(e.target.value)} className="pl-10" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['all', 'active', 'paused'] as const).map(s => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(s)}
              className="gap-1.5"
            >
              {s === 'all' ? 'Todas' : statusConfig[s].label}
              <span className="text-xs opacity-70">({counts[s]})</span>
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <Card className="border-none shadow-sm">
          <CardContent className="p-0">
            <div className="space-y-3 p-6">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Building2 className="h-12 w-12 mx-auto mb-3 opacity-30" />
            {search || statusFilter !== 'all' ? 'Nenhuma empresa encontrada' : 'Nenhuma empresa cadastrada. Crie a primeira!'}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-none shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead><SortHeader field="name">Nome Fantasia</SortHeader></TableHead>
                <TableHead><SortHeader field="cnpj">CNPJ</SortHeader></TableHead>
                <TableHead><SortHeader field="status">Status</SortHeader></TableHead>
                <TableHead>Plano</TableHead>
                <TableHead><SortHeader field="created_at">Data de Cadastro</SortHeader></TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(company => {
                const sc = statusConfig[company.status];
                return (
                  <TableRow
                    key={company.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/empresas/${company.id}`)}
                  >
                    <TableCell>
                      <div>
                        <p className="font-medium">{company.name}</p>
                        {company.razao_social && (
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">{company.razao_social}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {company.cnpj || '—'}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${sc.className}`}>
                        <Circle className={`h-2 w-2 fill-current`} />
                        {sc.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">—</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(company.created_at), "dd/MM/yyyy", { locale: ptBR })}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:text-primary" onClick={() => navigate(`/${company.slug}/admin`)} title="Acessar painel">
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => openEdit(company, e)} title="Editar">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-8 w-8"
                          onClick={(e) => togglePause(company, e)}
                          title={company.status === 'paused' ? 'Ativar' : 'Pausar'}
                        >
                          {company.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title="Excluir">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Excluir empresa permanentemente?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Isso removerá "{company.name}" e todos os dados associados. <strong>Esta ação não pode ser desfeita.</strong>
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteCompany.mutate(company.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Excluir permanentemente
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
