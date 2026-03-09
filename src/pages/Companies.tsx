import { useState } from 'react';
import { Plus, Search, Pencil, Trash2, Building2, Phone, Mail, MapPin, Pause, Play, AlertTriangle } from 'lucide-react';
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
import { useCompanies, useCreateCompany, useUpdateCompany, useDeleteCompany, Company, CompanyInsert, CompanyStatus } from '@/hooks/useCompanies';

function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

const statusConfig: Record<CompanyStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  active: { label: 'Ativa', variant: 'default' },
  paused: { label: 'Pausada', variant: 'secondary' },
  defaulting: { label: 'Inadimplente', variant: 'destructive' },
};

const emptyForm: CompanyInsert = {
  name: '', slug: '', razao_social: '', cnpj: '', phone: '', email: '',
  address: '', responsible_name: '', responsible_email: '', responsible_phone: '', status: 'active',
};

export default function Companies() {
  const { data: companies = [], isLoading } = useCompanies();
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [form, setForm] = useState<CompanyInsert>(emptyForm);

  const filtered = companies
    .filter(c => statusFilter === 'all' || c.status === statusFilter)
    .filter(c =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.cnpj && c.cnpj.includes(search)) ||
      (c.responsible_name && c.responsible_name.toLowerCase().includes(search.toLowerCase()))
    );

  const openCreate = () => { setEditing(null); setForm(emptyForm); setDialogOpen(true); };

  const openEdit = (c: Company) => {
    setEditing(c);
    setForm({
      name: c.name, slug: c.slug, razao_social: c.razao_social || '', cnpj: c.cnpj || '',
      phone: c.phone || '', email: c.email || '', address: c.address || '',
      responsible_name: c.responsible_name || '', responsible_email: c.responsible_email || '',
      responsible_phone: c.responsible_phone || '', status: c.status,
    });
    setDialogOpen(true);
  };

  const handleNameChange = (name: string) => {
    setForm(prev => ({ ...prev, name, slug: !editing ? slugify(name) : prev.slug }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.slug) return;
    if (!editing && !form.responsible_email) {
      return;
    }
    if (editing) {
      await updateCompany.mutateAsync({ id: editing.id, ...form });
    } else {
      await createCompany.mutateAsync(form);
    }
    setDialogOpen(false);
  };

  const togglePause = (c: Company) => {
    const newStatus: CompanyStatus = c.status === 'paused' ? 'active' : 'paused';
    updateCompany.mutate({ id: c.id, status: newStatus });
  };

  const toggleDefaulting = (c: Company) => {
    const newStatus: CompanyStatus = c.status === 'defaulting' ? 'active' : 'defaulting';
    updateCompany.mutate({ id: c.id, status: newStatus });
  };

  const counts = {
    all: companies.length,
    active: companies.filter(c => c.status === 'active').length,
    paused: companies.filter(c => c.status === 'paused').length,
    defaulting: companies.filter(c => c.status === 'defaulting').length,
  };

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
                  <Label>Email do Responsável (login)</Label>
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
                        <SelectItem value="defaulting">Inadimplente</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
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
        <div className="flex gap-2">
          {(['all', 'active', 'paused', 'defaulting'] as const).map(s => (
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

      {/* List */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <Card key={i} className="border-none shadow-sm">
              <CardContent className="pt-6 space-y-3">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            {search || statusFilter !== 'all' ? 'Nenhuma empresa encontrada' : 'Nenhuma empresa cadastrada. Crie a primeira!'}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(company => {
            const sc = statusConfig[company.status];
            return (
              <Card key={company.id} className="border-none shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
                        <Building2 className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-base truncate">{company.name}</h3>
                        {company.razao_social && <p className="text-xs text-muted-foreground truncate">{company.razao_social}</p>}
                        {company.cnpj && <p className="text-xs text-muted-foreground font-mono">{company.cnpj}</p>}
                      </div>
                    </div>
                    <Badge variant={sc.variant} className="shrink-0 ml-2">{sc.label}</Badge>
                  </div>

                  {(company.responsible_name || company.responsible_email) && (
                    <div className="mb-3 p-2.5 rounded-lg bg-muted/50">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Responsável</p>
                      {company.responsible_name && <p className="text-sm font-medium">{company.responsible_name}</p>}
                      {company.responsible_email && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Mail className="h-3 w-3" />
                          <span>{company.responsible_email}</span>
                        </div>
                      )}
                      {company.responsible_phone && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" />
                          <span>{company.responsible_phone}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-1 text-sm text-muted-foreground mb-4">
                    {company.phone && (
                      <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5" /><span>{company.phone}</span></div>
                    )}
                    {company.email && (
                      <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5" /><span>{company.email}</span></div>
                    )}
                    {company.address && (
                      <div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5" /><span className="truncate">{company.address}</span></div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 pt-2 border-t border-border">
                    <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => openEdit(company)}>
                      <Pencil className="h-3.5 w-3.5" /> Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => togglePause(company)}
                    >
                      {company.status === 'paused'
                        ? <><Play className="h-3.5 w-3.5" /> Ativar</>
                        : <><Pause className="h-3.5 w-3.5" /> Pausar</>
                      }
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`gap-1.5 text-xs ${company.status === 'defaulting' ? 'text-destructive' : ''}`}
                      onClick={() => toggleDefaulting(company)}
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {company.status === 'defaulting' ? 'Regularizar' : 'Inadimplente'}
                    </Button>
                    <div className="flex-1" />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remover empresa?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Isso removerá "{company.name}" e todos os dados associados. Esta ação não pode ser desfeita.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteCompany.mutate(company.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remover
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
