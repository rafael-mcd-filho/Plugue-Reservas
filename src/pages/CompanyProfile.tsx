import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Building2, Calendar, Circle, Clock3, Mail, MapPin,
  Pause, Pencil, Phone, Play, ShieldCheck, Trash2, User, Users,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanies, useUpdateCompany, useDeleteCompany, Company, CompanyStatus } from '@/hooks/useCompanies';
import {
  useCompanyFeatureFlags,
  useSaveCompanyFeatures,
  type CompanyFeatureState,
} from '@/hooks/useCompanyFeatures';
import {
  getPlanDefaultFeatures,
  normalizeCompanyPlanTier,
} from '@/lib/companyFeatures';
import CompanyFeatureSwitchList from '@/components/company/CompanyFeatureSwitchList';

interface CompanyActivityEvent {
  event_key: string;
  occurred_at: string;
  title: string;
  description: string;
  actor_name: string | null;
  metadata: Record<string, unknown> | null;
}

interface AccessAuditLog {
  id: string;
  user_id: string;
  event_type: 'login' | 'panel_access';
  path: string | null;
  ip_address: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
  user_name?: string;
  user_email?: string | null;
  role?: string | null;
}

const statusConfig: Record<CompanyStatus, { label: string; className: string }> = {
  active: { label: 'Ativa', className: 'bg-success-soft text-success border-success/20' },
  paused: { label: 'Pausada', className: 'bg-primary-soft text-primary border-primary/20' },
};

const activityIconMap: Record<string, any> = {
  company_created: Building2,
  first_reservation: Calendar,
  user_added: Users,
  last_panel_access: Clock3,
};

export default function CompanyProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: companies = [], isLoading } = useCompanies();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const saveCompanyFeatures = useSaveCompanyFeatures();
  const [editOpen, setEditOpen] = useState(false);
  const [modalFeatures, setModalFeatures] = useState<CompanyFeatureState | null>(null);

  const company = companies.find((item) => item.id === id);

  const [form, setForm] = useState<Partial<Company>>({});

  const { data: featureFlags, isLoading: featureFlagsLoading } = useCompanyFeatureFlags(company?.id);

  const { data: timeline = [], isLoading: timelineLoading } = useQuery({
    queryKey: ['company-activity-timeline', company?.id],
    queryFn: async () => {
      const rpcResult = await (supabase as any).rpc('get_company_activity_timeline', {
        _company_id: company!.id,
      });

      if (rpcResult.error) {
        console.warn('Company activity timeline RPC not available yet:', rpcResult.error);
        return [];
      }
      return (rpcResult.data ?? []) as CompanyActivityEvent[];
    },
    enabled: !!company?.id,
  });

  const { data: recentAccesses = [], isLoading: accessLoading } = useQuery({
    queryKey: ['company-access-audit', company?.id],
    queryFn: async () => {
      const { data: logs, error: logsError } = await supabase
        .from('access_audit_logs' as any)
        .select('*')
        .eq('company_id', company!.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (logsError) {
        console.warn('Access audit table not available yet:', logsError);
        return [];
      }

      const accessLogs = (logs ?? []) as AccessAuditLog[];
      const userIds = [...new Set(accessLogs.map((log) => log.user_id))];

      if (userIds.length === 0) return accessLogs;

      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase
          .from('profiles' as any)
          .select('id, full_name, email')
          .in('id', userIds),
        supabase
          .from('user_roles' as any)
          .select('user_id, role, company_id')
          .eq('company_id', company!.id)
          .in('user_id', userIds),
      ]);

      return accessLogs.map((log) => {
        const profile = (profiles ?? []).find((item: any) => item.id === log.user_id);
        const membership = (roles ?? []).find((item: any) => item.user_id === log.user_id);

        return {
          ...log,
          user_name: profile?.full_name || profile?.email || log.user_id,
          user_email: profile?.email ?? null,
          role: membership?.role ?? null,
        };
      });
    },
    enabled: !!company?.id,
  });

  const openEdit = () => {
    if (!company) return;

    setForm({
      name: company.name,
      slug: company.slug,
      razao_social: company.razao_social || '',
      cnpj: company.cnpj || '',
      phone: company.phone || '',
      email: company.email || '',
      address: company.address || '',
      responsible_name: company.responsible_name || '',
      responsible_email: company.responsible_email || '',
      responsible_phone: company.responsible_phone || '',
      status: company.status,
    });
    setModalFeatures(getCurrentFeatures(company, featureFlags?.features));
    setEditOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!company) return;
    await updateCompany.mutateAsync({ id: company.id, ...form });
    if (modalFeatures) {
      await saveCompanyFeatures.mutateAsync({
        companyId: company.id,
        features: modalFeatures,
      });
    }
    setEditOpen(false);
  };

  const togglePause = () => {
    if (!company) return;
    updateCompany.mutate({
      id: company.id,
      status: company.status === 'paused' ? 'active' : 'paused',
    });
  };

  const handleDelete = () => {
    if (!company) return;
    deleteCompany.mutate(company.id, { onSuccess: () => navigate('/empresas') });
  };

  const handleFeatureToggle = async (features: CompanyFeatureState) => {
    if (!company) return;
    await saveCompanyFeatures.mutateAsync({
      companyId: company.id,
      features,
    });
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
            Empresa nao encontrada.
          </CardContent>
        </Card>
      </div>
    );
  }

  const sc = statusConfig[company.status];
  const effectiveFeatures = getCurrentFeatures(company, featureFlags?.features);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" aria-label="Voltar para empresas" onClick={() => navigate('/empresas')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight truncate">{company.name}</h1>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${sc.className}`}>
              <Circle className="h-2 w-2 fill-current" />
              {sc.label}
            </span>
          </div>
          {company.razao_social && (
            <p className="text-sm text-muted-foreground mt-0.5">{company.razao_social}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={openEdit}>
            <Pencil className="h-4 w-4" /> Editar
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={togglePause}>
            {company.status === 'paused' ? <><Play className="h-4 w-4" /> Ativar</> : <><Pause className="h-4 w-4" /> Pausar</>}
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
                  Isso remove "{company.name}" e os dados associados. Esta ação não pode ser desfeita.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Excluir permanentemente
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" /> Dados da Empresa
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <InfoRow label="Nome Fantasia" value={company.name} />
            <InfoRow label="Razao Social" value={company.razao_social} />
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

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> Responsavel
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

        <Card className="border-none shadow-sm lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" /> Features da Empresa
            </CardTitle>
            <CardDescription>
              Ative ou desative os recursos que quiser para esta empresa.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {featureFlagsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <CompanyFeatureSwitchList
                features={effectiveFeatures}
                disabled={saveCompanyFeatures.isPending || updateCompany.isPending}
                onToggle={(featureKey, enabled) =>
                  handleFeatureToggle({ ...effectiveFeatures, [featureKey]: enabled })
                }
              />
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-primary" /> Timeline da Empresa
            </CardTitle>
            <CardDescription>
              Conta criada, primeira reserva, usuarios adicionados e ultimo acesso ao painel.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {timelineLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">Ainda não há eventos para esta empresa.</p>
            ) : (
              <div className="space-y-4">
                {timeline.map((event) => {
                  const Icon = activityIconMap[event.event_key] || Clock3;
                  return (
                    <div key={`${event.event_key}-${event.occurred_at}-${event.title}`} className="flex gap-3">
                      <div className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium">{event.title}</p>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(event.occurred_at), "dd/MM/yyyy 'as' HH:mm", { locale: ptBR })}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{event.description}</p>
                        {event.actor_name && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {event.actor_name} • {formatDistanceToNow(new Date(event.occurred_at), { addSuffix: true, locale: ptBR })}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-primary" /> Auditoria de Acesso
            </CardTitle>
            <CardDescription>
              Ultimos acessos ao painel com usuario, horario, rota e IP.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {accessLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : recentAccesses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum acesso auditado para esta empresa ainda.</p>
            ) : (
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Usuario</TableHead>
                      <TableHead>Evento</TableHead>
                      <TableHead>Quando</TableHead>
                      <TableHead>Rota</TableHead>
                      <TableHead>IP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentAccesses.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{log.user_name || log.user_id}</p>
                            <p className="text-xs text-muted-foreground">
                              {[log.role, log.user_email].filter(Boolean).join(' • ') || 'Sem papel identificado'}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={log.event_type === 'login' ? 'secondary' : 'outline'}>
                            {log.event_type === 'login' ? 'Login' : 'Painel'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(log.created_at), "dd/MM HH:mm", { locale: ptBR })}
                        </TableCell>
                        <TableCell className="text-sm font-mono text-muted-foreground">
                          {log.path || '-'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {log.ip_address || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Empresa</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-5 mt-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>Nome Fantasia</Label>
                <Input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Razão Social</Label>
                <Input value={form.razao_social || ''} onChange={(e) => setForm({ ...form, razao_social: e.target.value })} />
              </div>
              <div>
                <Label>CNPJ</Label>
                <Input value={form.cnpj || ''} onChange={(e) => setForm({ ...form, cnpj: e.target.value })} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={form.slug || ''} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
              </div>
              <div>
                <Label>Telefone</Label>
                <Input value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div>
                <Label>Email</Label>
                <Input value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Endereco</Label>
                <Textarea value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} />
              </div>
              <div>
                <Label>Nome do Responsavel</Label>
                <Input value={form.responsible_name || ''} onChange={(e) => setForm({ ...form, responsible_name: e.target.value })} />
              </div>
              <div>
                <Label>Email do Responsavel</Label>
                <Input value={form.responsible_email || ''} onChange={(e) => setForm({ ...form, responsible_email: e.target.value })} />
              </div>
              <div>
                <Label>Telefone do Responsavel</Label>
                <Input value={form.responsible_phone || ''} onChange={(e) => setForm({ ...form, responsible_phone: e.target.value })} />
              </div>
              <div>
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(value) => setForm({ ...form, status: value as CompanyStatus })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativa</SelectItem>
                    <SelectItem value="paused">Pausada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {modalFeatures && (
              <div className="space-y-3 pt-2">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Features</p>
                  <p className="text-sm text-muted-foreground mt-1">Ajuste as permissões da empresa no mesmo fluxo de edição.</p>
                </div>
                <CompanyFeatureSwitchList
                  features={modalFeatures}
                  compact
                  disabled={saveCompanyFeatures.isPending || updateCompany.isPending}
                  onToggle={(featureKey, enabled) =>
                    setModalFeatures((current) => current ? { ...current, [featureKey]: enabled } : current)
                  }
                />
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={updateCompany.isPending || saveCompanyFeatures.isPending}>Salvar</Button>
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

function getCurrentFeatures(company: Company | undefined, features?: CompanyFeatureState | null) {
  if (features) return features;
  return getPlanDefaultFeatures(normalizeCompanyPlanTier(company?.plan_tier));
}
