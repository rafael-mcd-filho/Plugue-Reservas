import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Mail, Phone, MapPin, Pencil, Pause, Play, AlertTriangle, Trash2, Calendar, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCompanies, useUpdateCompany, useDeleteCompany, Company, CompanyStatus } from '@/hooks/useCompanies';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useState } from 'react';

const statusConfig: Record<CompanyStatus, { label: string; variant: 'default' | 'secondary' | 'destructive'; color: string }> = {
  active: { label: 'Ativa', variant: 'default', color: 'text-green-600' },
  paused: { label: 'Pausada', variant: 'secondary', color: 'text-muted-foreground' },
  defaulting: { label: 'Inadimplente', variant: 'destructive', color: 'text-destructive' },
};

export default function CompanyProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: companies = [], isLoading } = useCompanies();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const [editOpen, setEditOpen] = useState(false);

  const company = companies.find(c => c.id === id);

  const [form, setForm] = useState<Partial<Company>>({});

  const openEdit = () => {
    if (!company) return;
    setForm({
      name: company.name, slug: company.slug, razao_social: company.razao_social || '',
      cnpj: company.cnpj || '', phone: company.phone || '', email: company.email || '',
      address: company.address || '', responsible_name: company.responsible_name || '',
      responsible_email: company.responsible_email || '', responsible_phone: company.responsible_phone || '',
      status: company.status,
    });
    setEditOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!company) return;
    await updateCompany.mutateAsync({ id: company.id, ...form });
    setEditOpen(false);
  };

  const togglePause = () => {
    if (!company) return;
    updateCompany.mutate({ id: company.id, status: company.status === 'paused' ? 'active' : 'paused' });
  };

  const toggleDefaulting = () => {
    if (!company) return;
    updateCompany.mutate({ id: company.id, status: company.status === 'defaulting' ? 'active' : 'defaulting' });
  };

  const handleDelete = () => {
    if (!company) return;
    deleteCompany.mutate(company.id, { onSuccess: () => navigate('/empresas') });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate('/empresas')} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Button>
        <Card className="border-none shadow-sm">
          <CardContent className="py-12 text-center text-muted-foreground">
            Empresa não encontrada.
          </CardContent>
        </Card>
      </div>
    );
  }

  const sc = statusConfig[company.status];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/empresas')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight truncate">{company.name}</h1>
            <Badge variant={sc.variant}>{sc.label}</Badge>
          </div>
          {company.razao_social && (
            <p className="text-sm text-muted-foreground mt-0.5">{company.razao_social}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={openEdit}>
            <Pencil className="h-4 w-4" /> Editar
          </Button>
          <Button
            variant="outline" size="sm" className="gap-2"
            onClick={togglePause}
          >
            {company.status === 'paused' ? <><Play className="h-4 w-4" /> Ativar</> : <><Pause className="h-4 w-4" /> Pausar</>}
          </Button>
          <Button
            variant={company.status === 'defaulting' ? 'destructive' : 'outline'}
            size="sm" className="gap-2"
            onClick={toggleDefaulting}
          >
            <AlertTriangle className="h-4 w-4" />
            {company.status === 'defaulting' ? 'Regularizar' : 'Inadimplente'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-2">
                <Trash2 className="h-4 w-4" /> Excluir
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
                <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Excluir permanentemente
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Company Info */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" /> Dados da Empresa
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InfoRow label="Nome Fantasia" value={company.name} />
            <InfoRow label="Razão Social" value={company.razao_social} />
            <InfoRow label="CNPJ" value={company.cnpj} mono />
            <InfoRow label="Slug" value={company.slug} mono />
            <Separator />
            {company.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{company.email}</span>
              </div>
            )}
            {company.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{company.phone}</span>
              </div>
            )}
            {company.address && (
              <div className="flex items-center gap-2 text-sm">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>{company.address}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Responsible */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> Responsável (Admin)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InfoRow label="Nome" value={company.responsible_name} />
            {company.responsible_email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{company.responsible_email}</span>
              </div>
            )}
            {company.responsible_phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{company.responsible_phone}</span>
              </div>
            )}
            <Separator />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>Cadastrada em {format(new Date(company.created_at), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>Atualizada em {format(new Date(company.updated_at), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</span>
            </div>
          </CardContent>
        </Card>

        {/* Plan placeholder */}
        <Card className="border-none shadow-sm lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Plano e Assinatura</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Nenhum plano vinculado. Funcionalidade de planos será implementada em breve.</p>
          </CardContent>
        </Card>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Empresa</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-5 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Nome Fantasia</Label>
                <Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Razão Social</Label>
                <Input value={form.razao_social || ''} onChange={e => setForm({ ...form, razao_social: e.target.value })} />
              </div>
              <div>
                <Label>CNPJ</Label>
                <Input value={form.cnpj || ''} onChange={e => setForm({ ...form, cnpj: e.target.value })} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={form.slug || ''} onChange={e => setForm({ ...form, slug: e.target.value })} />
              </div>
              <div>
                <Label>Telefone</Label>
                <Input value={form.phone || ''} onChange={e => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div>
                <Label>Email</Label>
                <Input value={form.email || ''} onChange={e => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Endereço</Label>
                <Textarea value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} rows={2} />
              </div>
              <div>
                <Label>Nome do Responsável</Label>
                <Input value={form.responsible_name || ''} onChange={e => setForm({ ...form, responsible_name: e.target.value })} />
              </div>
              <div>
                <Label>Email do Responsável</Label>
                <Input value={form.responsible_email || ''} onChange={e => setForm({ ...form, responsible_email: e.target.value })} />
              </div>
              <div>
                <Label>Telefone do Responsável</Label>
                <Input value={form.responsible_phone || ''} onChange={e => setForm({ ...form, responsible_phone: e.target.value })} />
              </div>
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
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={updateCompany.isPending}>Salvar</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm mt-0.5 ${mono ? 'font-mono' : ''} ${value ? '' : 'text-muted-foreground'}`}>
        {value || '—'}
      </p>
    </div>
  );
}
