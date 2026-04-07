import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Building2,
  Calendar,
  CalendarOff,
  Circle,
  Clock3,
  CreditCard,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useCreateCompany, useUpdateCompany, type Company, type CompanyInsert, type CompanyStatus } from '@/hooks/useCompanies';
import { useSaveCompanyFeatures, type CompanyFeatureState } from '@/hooks/useCompanyFeatures';
import { getPlanDefaultFeatures, normalizeCompanyPlanTier } from '@/lib/companyFeatures';
import BlockedDatesTab from '@/components/company/BlockedDatesTab';
import CompanyFeatureSwitchList from '@/components/company/CompanyFeatureSwitchList';
import { normalizeGoogleMapsEmbedInput } from '@/lib/maps';
import { toast } from 'sonner';

interface CompanyDialogProps {
  open: boolean;
  company: Company | null;
  initialFeatures?: CompanyFeatureState | null;
  onOpenChange: (open: boolean) => void;
}

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
}

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

const DEFAULT_HOURS: OpeningHour[] = [
  { day: 'Seg', open: '17:30', close: '22:30' },
  { day: 'Ter', open: '17:30', close: '22:30' },
  { day: 'Qua', open: '17:30', close: '22:30' },
  { day: 'Qui', open: '17:30', close: '22:30' },
  { day: 'Sex', open: '17:30', close: '22:30' },
  { day: 'Sab', open: '17:30', close: '22:30' },
  { day: 'Dom', open: '17:30', close: '22:30' },
];

const PAYMENT_OPTIONS = [
  { key: 'dinheiro', label: 'Dinheiro' },
  { key: 'credito', label: 'Cartao de credito' },
  { key: 'debito', label: 'Cartao de debito' },
  { key: 'pix', label: 'Pix' },
  { key: 'vale_refeicao', label: 'Vale refeicao' },
];

const statusConfig: Record<CompanyStatus, { label: string; className: string }> = {
  active: { label: 'Ativa', className: 'bg-success-soft text-success border-success/20' },
  paused: { label: 'Pausada', className: 'bg-primary-soft text-primary border-primary/20' },
};

const activityIconMap: Record<string, typeof Clock3> = {
  company_created: Building2,
  first_reservation: Calendar,
  user_added: Users,
  last_panel_access: Clock3,
};

const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;

function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function cloneHours(hours: OpeningHour[]) {
  return hours.map((hour) => ({ ...hour }));
}

function getDefaultPayments() {
  return PAYMENT_OPTIONS.reduce((acc, option) => {
    acc[option.key] = option.key !== 'vale_refeicao';
    return acc;
  }, {} as Record<string, boolean>);
}

function normalizeOpeningHours(hours: Company['opening_hours']) {
  if (!Array.isArray(hours) || hours.length === 0) {
    return cloneHours(DEFAULT_HOURS);
  }

  return hours.map((hour, index) => ({
    day: typeof hour?.day === 'string' ? hour.day : DEFAULT_HOURS[index]?.day ?? `Dia ${index + 1}`,
    open: typeof hour?.open === 'string' ? hour.open : '17:30',
    close: typeof hour?.close === 'string' ? hour.close : '22:30',
    closed: !!hour?.closed,
  }));
}

function normalizePaymentMethods(paymentMethods: Company['payment_methods']) {
  const defaults = getDefaultPayments();

  return PAYMENT_OPTIONS.reduce((acc, option) => {
    acc[option.key] = typeof paymentMethods?.[option.key] === 'boolean'
      ? !!paymentMethods?.[option.key]
      : defaults[option.key];
    return acc;
  }, {} as Record<string, boolean>);
}

function createEmptyForm(): CompanyInsert {
  return {
    name: '',
    slug: '',
    razao_social: '',
    cnpj: '',
    phone: '',
    email: '',
    address: '',
    responsible_name: '',
    responsible_email: '',
    responsible_phone: '',
    instagram: '',
    whatsapp: '',
    google_maps_url: '',
    description: '',
    logo_url: '',
    opening_hours: cloneHours(DEFAULT_HOURS),
    payment_methods: getDefaultPayments(),
    reservation_duration: 30,
    max_guests_per_slot: 0,
    status: 'active',
  };
}

function buildFormFromCompany(company: Company): CompanyInsert {
  return {
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
    instagram: company.instagram || '',
    whatsapp: company.whatsapp || '',
    google_maps_url: company.google_maps_url || '',
    description: company.description || '',
    logo_url: company.logo_url || '',
    opening_hours: normalizeOpeningHours(company.opening_hours),
    payment_methods: normalizePaymentMethods(company.payment_methods),
    reservation_duration: company.reservation_duration ?? 30,
    max_guests_per_slot: company.max_guests_per_slot ?? 0,
    status: company.status,
  };
}

function getInitialFeatures(company: Company | null, initialFeatures?: CompanyFeatureState | null) {
  if (initialFeatures) return initialFeatures;
  return getPlanDefaultFeatures(normalizeCompanyPlanTier(company?.plan_tier));
}

export default function CompanyDialog({
  open,
  company,
  initialFeatures,
  onOpenChange,
}: CompanyDialogProps) {
  const isEditing = !!company;
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const saveCompanyFeatures = useSaveCompanyFeatures();
  const [form, setForm] = useState<CompanyInsert>(createEmptyForm());
  const [featureForm, setFeatureForm] = useState<CompanyFeatureState>(getInitialFeatures(null));
  const [activeTab, setActiveTab] = useState('geral');
  const [uploadingLogo, setUploadingLogo] = useState(false);

  useEffect(() => {
    if (!open) return;

    setActiveTab('geral');
    setForm(company ? buildFormFromCompany(company) : createEmptyForm());
    setFeatureForm(getInitialFeatures(company, initialFeatures));
  }, [open, company?.id]);

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
    enabled: open && !!company?.id,
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
    enabled: open && !!company?.id,
  });

  const pending = createCompany.isPending || updateCompany.isPending || saveCompanyFeatures.isPending;
  const headerStatus = company ? statusConfig[company.status] : null;
  const hours = normalizeOpeningHours(form.opening_hours);
  const payments = normalizePaymentMethods(form.payment_methods);
  const publicCustomizationLocked = !featureForm.custom_public_page;

  const handleNameChange = (name: string) => {
    setForm((current) => ({
      ...current,
      name,
      slug: isEditing ? current.slug : slugify(name),
    }));
  };

  const updateHour = (index: number, field: keyof OpeningHour, value: string | boolean) => {
    setForm((current) => ({
      ...current,
      opening_hours: normalizeOpeningHours(current.opening_hours).map((hour, hourIndex) =>
        hourIndex === index ? { ...hour, [field]: value } : hour,
      ),
    }));
  };

  const togglePaymentMethod = (key: string, enabled: boolean) => {
    setForm((current) => ({
      ...current,
      payment_methods: {
        ...normalizePaymentMethods(current.payment_methods),
        [key]: enabled,
      },
    }));
  };

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || publicCustomizationLocked) {
      event.target.value = '';
      return;
    }

    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem valido');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_LOGO_FILE_SIZE) {
      toast.error('O logo deve ter no maximo 2MB');
      event.target.value = '';
      return;
    }

    setUploadingLogo(true);

    try {
      const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const slugBase = slugify(form.slug || form.name || company?.slug || company?.name || 'empresa');
      const filePath = `company-logos/${slugBase || 'empresa'}-${Date.now()}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from('system-assets')
        .upload(filePath, file, { upsert: false });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from('system-assets')
        .getPublicUrl(filePath);

      setForm((current) => ({
        ...current,
        logo_url: publicUrlData.publicUrl,
      }));

      toast.success('Logo enviado com sucesso');
    } catch (error: any) {
      toast.error(`Erro ao enviar logo: ${error.message}`);
    } finally {
      setUploadingLogo(false);
      event.target.value = '';
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.name || !form.slug) return;
    if (!isEditing && !form.responsible_email) return;

    const payload: CompanyInsert = {
      ...form,
      logo_url: publicCustomizationLocked ? (company?.logo_url || '') : (form.logo_url || ''),
      description: publicCustomizationLocked ? (company?.description || '') : (form.description || ''),
      whatsapp: publicCustomizationLocked ? (company?.whatsapp || '') : (form.whatsapp || ''),
      google_maps_url: normalizeGoogleMapsEmbedInput(form.google_maps_url) || '',
      opening_hours: normalizeOpeningHours(form.opening_hours),
      payment_methods: normalizePaymentMethods(form.payment_methods),
      reservation_duration: form.reservation_duration ?? 30,
      max_guests_per_slot: form.max_guests_per_slot ?? 0,
    };

    if ((form.google_maps_url || '').trim() && !payload.google_maps_url) {
      toast.error('Use um link de incorporacao valido do Google Maps.');
      return;
    }

    if (company) {
      await updateCompany.mutateAsync({ id: company.id, ...payload });
      await saveCompanyFeatures.mutateAsync({
        companyId: company.id,
        features: featureForm,
      });
      onOpenChange(false);
      return;
    }

    const result = await createCompany.mutateAsync(payload);
    const createdCompanyId = result?.company?.id as string | undefined;

    if (createdCompanyId) {
      await saveCompanyFeatures.mutateAsync({
        companyId: createdCompanyId,
        features: featureForm,
      });
    }

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden sm:w-[calc(100vw-2rem)]">
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-3">
            <DialogTitle>{company ? company.name : 'Nova Empresa'}</DialogTitle>
            {headerStatus && (
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${headerStatus.className}`}>
                <Circle className="h-2 w-2 fill-current" />
                {headerStatus.label}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {isEditing
              ? 'Todas as configurações da empresa em um único modal.'
              : 'Cadastre a empresa e defina as configurações iniciais no mesmo fluxo.'}
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 flex min-h-0 flex-1 flex-col">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className={`grid w-full ${isEditing ? 'grid-cols-4' : 'grid-cols-3'}`}>
              <TabsTrigger value="geral">Geral</TabsTrigger>
              <TabsTrigger value="operacao">Operação</TabsTrigger>
              <TabsTrigger value="features">Features</TabsTrigger>
              {isEditing && <TabsTrigger value="historico">Histórico</TabsTrigger>}
            </TabsList>

            <div className="mt-4 flex-1 overflow-y-auto pr-1">
              <TabsContent value="geral" className="mt-0 space-y-6">
                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Dados da Empresa</CardTitle>
                    <CardDescription>Cadastro principal, contatos e identidade visual.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <Label>Nome Fantasia *</Label>
                        <Input value={form.name} onChange={(event) => handleNameChange(event.target.value)} placeholder="Nome fantasia" />
                      </div>
                      <div>
                        <Label>Slug *</Label>
                        <Input value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} placeholder="slug-empresa" />
                      </div>
                      <div>
                        <Label>Razao Social</Label>
                        <Input value={form.razao_social || ''} onChange={(event) => setForm((current) => ({ ...current, razao_social: event.target.value }))} />
                      </div>
                      <div>
                        <Label>CNPJ</Label>
                        <Input value={form.cnpj || ''} onChange={(event) => setForm((current) => ({ ...current, cnpj: event.target.value }))} />
                      </div>
                      <div>
                        <Label>Telefone</Label>
                        <Input value={form.phone || ''} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} />
                      </div>
                      <div>
                        <Label>Email</Label>
                        <Input type="email" value={form.email || ''} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
                      </div>
                      <div className="md:col-span-2">
                        <Label>Logo da Empresa</Label>
                        <div className="mt-2 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="relative">
                              <input
                                type="file"
                                accept="image/*"
                                onChange={handleLogoUpload}
                                disabled={publicCustomizationLocked || uploadingLogo}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                              <Button
                                type="button"
                                variant="outline"
                                disabled={publicCustomizationLocked || uploadingLogo}
                                className="pointer-events-none gap-2"
                              >
                                {uploadingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                                {uploadingLogo ? 'Enviando...' : 'Enviar logo'}
                              </Button>
                            </div>

                            {form.logo_url && (
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={publicCustomizationLocked || uploadingLogo}
                                onClick={() => setForm((current) => ({ ...current, logo_url: '' }))}
                                className="gap-2 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                                Remover
                              </Button>
                            )}
                          </div>

                          <p className="text-xs text-muted-foreground">
                            Envie PNG, JPG, WEBP ou SVG com ate 2MB.
                          </p>

                          <div className="flex min-h-28 max-w-sm items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-4">
                            {form.logo_url ? (
                              <img
                                src={form.logo_url}
                                alt={form.name ? `Logo de ${form.name}` : 'Logo da empresa'}
                                className="max-h-20 w-auto max-w-full object-contain"
                              />
                            ) : (
                              <p className="text-center text-xs text-muted-foreground">
                                Nenhum logo enviado ainda.
                              </p>
                            )}
                          </div>
                        </div>
                        {publicCustomizationLocked && (
                          <p className="mt-1 text-xs text-muted-foreground">A logo da pagina publica fica bloqueada quando a feature de pagina publica customizada estiver desativada.</p>
                        )}
                      </div>
                      {isEditing && (
                        <div>
                          <Label>Status</Label>
                          <Select value={form.status} onValueChange={(value) => setForm((current) => ({ ...current, status: value as CompanyStatus }))}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="active">Ativa</SelectItem>
                              <SelectItem value="paused">Pausada</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>

                    <Separator />

                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Responsavel</p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <Label>Nome do Responsavel</Label>
                          <Input value={form.responsible_name || ''} onChange={(event) => setForm((current) => ({ ...current, responsible_name: event.target.value }))} />
                        </div>
                        <div>
                          <Label>Email do Responsavel {!isEditing && '*'}</Label>
                          <Input type="email" value={form.responsible_email || ''} onChange={(event) => setForm((current) => ({ ...current, responsible_email: event.target.value }))} />
                        </div>
                        <div>
                          <Label>Telefone do Responsavel</Label>
                          <Input value={form.responsible_phone || ''} onChange={(event) => setForm((current) => ({ ...current, responsible_phone: event.target.value }))} />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Pagina Publica e Localizacao</p>
                        {publicCustomizationLocked && (
                          <p className="mt-1 text-xs text-muted-foreground">Descricao, logo e botao de WhatsApp ficam bloqueados. Endereco, mapa e pagamentos continuam disponiveis.</p>
                        )}
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="md:col-span-2">
                          <Label>Descricao</Label>
                          <Textarea value={form.description || ''} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} rows={3} disabled={publicCustomizationLocked} />
                        </div>
                        <div>
                          <Label>Instagram</Label>
                          <Input value={form.instagram || ''} onChange={(event) => setForm((current) => ({ ...current, instagram: event.target.value }))} placeholder="@restaurante" />
                        </div>
                        <div>
                          <Label>WhatsApp</Label>
                          <Input value={form.whatsapp || ''} onChange={(event) => setForm((current) => ({ ...current, whatsapp: event.target.value }))} placeholder="5584999999999" disabled={publicCustomizationLocked} />
                        </div>
                        <div className="md:col-span-2">
                          <Label>Endereco</Label>
                          <Textarea value={form.address || ''} onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))} rows={2} />
                        </div>
                        <div className="md:col-span-2">
                          <Label>Google Maps Embed</Label>
                          <Input value={form.google_maps_url || ''} onChange={(event) => setForm((current) => ({ ...current, google_maps_url: event.target.value }))} placeholder="https://www.google.com/maps/embed?pb=..." />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="operacao" className="mt-0 space-y-6">
                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-primary" /> Horarios e Capacidade
                    </CardTitle>
                    <CardDescription>Disponibilidade de reserva, duracao e limite por horario.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-3">
                      {hours.map((hour, index) => (
                        <div key={hour.day} className="flex flex-wrap items-center gap-4">
                          <span className="w-10 text-sm font-medium">{hour.day}</span>
                          <Switch
                            checked={!hour.closed}
                            onCheckedChange={(checked) => updateHour(index, 'closed', !checked)}
                          />
                          {!hour.closed ? (
                            <>
                              <Input type="time" value={hour.open} onChange={(event) => updateHour(index, 'open', event.target.value)} className="w-32" />
                              <span className="text-sm text-muted-foreground">as</span>
                              <Input type="time" value={hour.close} onChange={(event) => updateHour(index, 'close', event.target.value)} className="w-32" />
                            </>
                          ) : (
                            <span className="text-sm text-muted-foreground">Fechado</span>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <Label>Duracao da reserva</Label>
                        <Select
                          value={String(form.reservation_duration ?? 30)}
                          onValueChange={(value) => setForm((current) => ({ ...current, reservation_duration: Number(value) }))}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="15">15 min</SelectItem>
                            <SelectItem value="30">30 min</SelectItem>
                            <SelectItem value="45">45 min</SelectItem>
                            <SelectItem value="60">1 hora</SelectItem>
                            <SelectItem value="90">1h30</SelectItem>
                            <SelectItem value="120">2 horas</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Capacidade maxima por horario</Label>
                        <Input
                          type="number"
                          min={0}
                          value={form.max_guests_per_slot ?? 0}
                          onChange={(event) => setForm((current) => ({ ...current, max_guests_per_slot: Number(event.target.value) }))}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-primary" /> Pagamentos
                    </CardTitle>
                    <CardDescription>Metodos aceitos pela empresa na pagina publica.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {PAYMENT_OPTIONS.map((option) => (
                      <div key={option.key} className="flex items-center justify-between">
                        <Label htmlFor={`payment-${option.key}`} className="cursor-pointer">
                          {option.label}
                        </Label>
                        <Switch
                          id={`payment-${option.key}`}
                          checked={payments[option.key]}
                          onCheckedChange={(checked) => togglePaymentMethod(option.key, checked)}
                        />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                {company ? (
                  <BlockedDatesTab companyId={company.id} />
                ) : (
                  <Card className="border-none shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <CalendarOff className="h-4 w-4 text-primary" /> Datas Bloqueadas
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        Salve a empresa primeiro para cadastrar bloqueios de datas e horarios.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="features" className="mt-0">
                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-primary" /> Features da Empresa
                    </CardTitle>
                    <CardDescription>Ative ou desative os recursos disponiveis para esta empresa.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CompanyFeatureSwitchList
                      features={featureForm}
                      disabled={pending}
                      onToggle={(featureKey, enabled) =>
                        setFeatureForm((current) => ({ ...current, [featureKey]: enabled }))
                      }
                    />
                  </CardContent>
                </Card>
              </TabsContent>

              {company && (
                <TabsContent value="historico" className="mt-0 space-y-6">
                  <Card className="border-none shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" /> Resumo de Cadastro
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <InfoRow icon={<Mail className="h-4 w-4 text-muted-foreground" />} label="Email principal" value={company.email} />
                      <InfoRow icon={<Phone className="h-4 w-4 text-muted-foreground" />} label="Telefone principal" value={company.phone} />
                      <InfoRow icon={<MapPin className="h-4 w-4 text-muted-foreground" />} label="Endereco" value={company.address} />
                      <InfoRow icon={<Globe className="h-4 w-4 text-muted-foreground" />} label="Slug" value={company.slug} />
                      <InfoRow icon={<Calendar className="h-4 w-4 text-muted-foreground" />} label="Criada em" value={format(new Date(company.created_at), "dd/MM/yyyy 'as' HH:mm", { locale: ptBR })} />
                      <InfoRow icon={<Calendar className="h-4 w-4 text-muted-foreground" />} label="Atualizada em" value={format(new Date(company.updated_at), "dd/MM/yyyy 'as' HH:mm", { locale: ptBR })} />
                    </CardContent>
                  </Card>

                  <Card className="border-none shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Clock3 className="h-4 w-4 text-primary" /> Timeline
                      </CardTitle>
                      <CardDescription>Conta criada, primeira reserva, usuarios e ultimo acesso.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {timelineLoading ? (
                        <div className="space-y-4">
                          <Skeleton className="h-16 w-full" />
                          <Skeleton className="h-16 w-full" />
                          <Skeleton className="h-16 w-full" />
                        </div>
                      ) : timeline.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Ainda não há eventos registrados para esta empresa.</p>
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
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-medium">{event.title}</p>
                                    <span className="text-xs text-muted-foreground">
                                      {format(new Date(event.occurred_at), "dd/MM/yyyy 'as' HH:mm", { locale: ptBR })}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-sm text-muted-foreground">{event.description}</p>
                                  {event.actor_name && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {event.actor_name} - {formatDistanceToNow(new Date(event.occurred_at), { addSuffix: true, locale: ptBR })}
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
                        <Users className="h-4 w-4 text-primary" /> Auditoria de Acesso
                      </CardTitle>
                      <CardDescription>Ultimos logins e acessos ao painel da empresa.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {accessLoading ? (
                        <div className="space-y-3">
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-10 w-full" />
                        </div>
                      ) : recentAccesses.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nenhum acesso auditado ainda.</p>
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
                                      <p className="text-sm font-medium">{log.user_name || log.user_id}</p>
                                      <p className="text-xs text-muted-foreground">
                                        {[log.role, log.user_email].filter(Boolean).join(' - ') || 'Sem papel identificado'}
                                      </p>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant={log.event_type === 'login' ? 'secondary' : 'outline'}>
                                      {log.event_type === 'login' ? 'Login' : 'Painel'}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-sm text-muted-foreground">
                                    {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
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
                </TabsContent>
              )}
            </div>
          </Tabs>

          <div className="mt-4 flex justify-end gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {isEditing ? 'Salvar alteracoes' : 'Criar empresa'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-sm">{value || '-'}</p>
    </div>
  );
}
