import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AlertTriangle,
  Building2,
  Calendar,
  CalendarOff,
  CheckCircle2,
  Circle,
  CircleDollarSign,
  Clock3,
  CreditCard,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
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
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { useCreateCompany, useUpdateCompany, type Company, type CompanyInsert, type CompanyStatus } from '@/hooks/useCompanies';
import { useSaveCompanyFeatures, type CompanyFeatureState } from '@/hooks/useCompanyFeatures';
import {
  useCompanyBillingLink,
  usePlatformBillingModuleStatus,
  useRemoveCompanyBillingLink,
  useSaveCompanyBillingLink,
  useSetCompanyBillingEnabled,
  useValidateAsaasCustomer,
} from '@/hooks/usePlatformBilling';
import { getPlanDefaultFeatures, normalizeCompanyPlanTier } from '@/lib/companyFeatures';
import type { CompanyBillingTarget } from '@/lib/company-billing-dialog';
import {
  PLATFORM_BILLING_DESCRIPTION_MARKER,
  type ValidatedAsaasCustomer,
} from '@/lib/platform-billing-contracts';
import BlockedDatesTab from '@/components/company/BlockedDatesTab';
import AsaasCustomerFinder from '@/components/billing/AsaasCustomerFinder';
import CompanyFeatureSwitchList from '@/components/company/CompanyFeatureSwitchList';
import { normalizeGoogleMapsEmbedInput } from '@/lib/maps';
import { toSafeRichTextHtml } from '@/lib/richText';
import { toast } from 'sonner';
import {
  normalizeInstagramHandle,
  formatBrazilPhone,
  formatCnpj,
  getCnpjValidationMessage,
  getEmailValidationMessage,
  getPhoneValidationMessage,
  normalizeEmail,
  normalizeOptionalCnpj,
} from '@/lib/validation';

interface CompanyDialogProps {
  open: boolean;
  company: Company | null;
  initialFeatures?: CompanyFeatureState | null;
  billingTarget?: CompanyBillingTarget | null;
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
  { day: 'Sáb', open: '17:30', close: '22:30' },
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
    reservation_slot_interval_minutes: 30,
    max_guests_per_slot: 0,
    status: 'active',
  };
}

function buildFormFromCompany(company: Company): CompanyInsert {
  return {
    name: company.name,
    slug: company.slug,
    razao_social: company.razao_social || '',
    cnpj: formatCnpj(company.cnpj),
    phone: formatBrazilPhone(company.phone),
    email: company.email || '',
    address: company.address || '',
    responsible_name: company.responsible_name || '',
    responsible_email: company.responsible_email || '',
    responsible_phone: formatBrazilPhone(company.responsible_phone),
    instagram: normalizeInstagramHandle(company.instagram),
    whatsapp: formatBrazilPhone(company.whatsapp),
    google_maps_url: company.google_maps_url || '',
    description: company.description || '',
    logo_url: company.logo_url || '',
    opening_hours: normalizeOpeningHours(company.opening_hours),
    payment_methods: normalizePaymentMethods(company.payment_methods),
    reservation_duration: company.reservation_duration ?? 30,
    reservation_slot_interval_minutes: company.reservation_slot_interval_minutes ?? company.reservation_duration ?? 30,
    max_guests_per_slot: company.max_guests_per_slot ?? 0,
    status: company.status,
  };
}

function getInitialFeatures(company: Company | null, initialFeatures?: CompanyFeatureState | null) {
  const defaults = getPlanDefaultFeatures(normalizeCompanyPlanTier(company?.plan_tier));
  if (initialFeatures) return { ...defaults, ...initialFeatures };
  return defaults;
}

export default function CompanyDialog({
  open,
  company,
  initialFeatures,
  billingTarget,
  onOpenChange,
}: CompanyDialogProps) {
  const isEditing = !!company;
  const billingOnly = !!billingTarget;
  const billingCompanyId = billingTarget?.id ?? company?.id;
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const saveCompanyFeatures = useSaveCompanyFeatures();
  const billingModuleQuery = usePlatformBillingModuleStatus({ enabled: open });
  const billingLinkQuery = useCompanyBillingLink(billingCompanyId, { enabled: open && !!billingCompanyId });
  const validateBillingCustomer = useValidateAsaasCustomer();
  const saveBillingLink = useSaveCompanyBillingLink();
  const removeBillingLink = useRemoveCompanyBillingLink();
  const setCompanyBillingEnabled = useSetCompanyBillingEnabled();
  const [form, setForm] = useState<CompanyInsert>(createEmptyForm());
  const [featureForm, setFeatureForm] = useState<CompanyFeatureState>(getInitialFeatures(null));
  const [activeTab, setActiveTab] = useState('geral');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [billingCustomerId, setBillingCustomerId] = useState('');
  const [billingCustomerDirty, setBillingCustomerDirty] = useState(false);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [billingEnabledDirty, setBillingEnabledDirty] = useState(false);
  const [validatedBillingCustomer, setValidatedBillingCustomer] = useState<ValidatedAsaasCustomer | null>(null);

  useEffect(() => {
    if (!open) return;

    setActiveTab(billingTarget ? 'financeiro' : 'geral');
    setForm(company ? buildFormFromCompany(company) : createEmptyForm());
    setFeatureForm(getInitialFeatures(company, initialFeatures));
    setBillingCustomerId('');
    setBillingCustomerDirty(false);
    setBillingEnabled(false);
    setBillingEnabledDirty(false);
    setValidatedBillingCustomer(null);
  }, [open, company, initialFeatures, billingTarget]);

  useEffect(() => {
    if (!open || !billingCompanyId || billingCustomerDirty || billingEnabledDirty || !billingLinkQuery.isSuccess) return;
    const link = billingLinkQuery.data;
    if (!link) {
      setBillingCustomerId('');
      setBillingEnabled(false);
      setBillingEnabledDirty(false);
      setValidatedBillingCustomer(null);
      return;
    }
    setBillingCustomerId(link.customerId);
    setBillingEnabled(link.billingEnabled);
    setBillingEnabledDirty(false);
    setValidatedBillingCustomer({
      id: link.customerId,
      name: link.customerName || 'Cliente Asaas',
      cpfCnpj: link.customerDocument,
      email: null,
      mobilePhone: null,
      externalReference: null,
      linkedCompanyId: link.companyId,
      billingEnabled: link.billingEnabled,
    });
  }, [
    billingCustomerDirty,
    billingEnabledDirty,
    billingLinkQuery.data,
    billingLinkQuery.isSuccess,
    billingCompanyId,
    open,
  ]);

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

  const pending = createCompany.isPending
    || updateCompany.isPending
    || saveCompanyFeatures.isPending
    || validateBillingCustomer.isPending
    || saveBillingLink.isPending
    || setCompanyBillingEnabled.isPending
    || removeBillingLink.isPending;
  const targetStatus = billingTarget?.status ?? company?.status;
  const headerStatus = targetStatus ? statusConfig[targetStatus] : null;
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

  const handleBillingCustomerChange = (value: string) => {
    const nextCustomerId = value.trimStart();
    setBillingCustomerId(nextCustomerId);
    setBillingCustomerDirty(true);
    setValidatedBillingCustomer(null);
    validateBillingCustomer.reset();
    if (nextCustomerId.trim() !== (billingLinkQuery.data?.customerId ?? '')) {
      setBillingEnabled(false);
      setBillingEnabledDirty(true);
    }
  };

  const handleBillingCustomerSelect = (customer: ValidatedAsaasCustomer) => {
    setBillingCustomerId(customer.id);
    setValidatedBillingCustomer(customer);
    setBillingCustomerDirty(customer.id !== (billingLinkQuery.data?.customerId ?? ''));
    if (customer.id !== (billingLinkQuery.data?.customerId ?? '')) {
      setBillingEnabled(false);
      setBillingEnabledDirty(true);
    }
    validateBillingCustomer.reset();
    toast.success('Cliente selecionado. O Customer ID foi preenchido automaticamente.');
  };

  const handleValidateBillingCustomer = async () => {
    const customerId = billingCustomerId.trim();
    if (!customerId) {
      toast.error('Informe o Customer ID do Asaas.');
      return;
    }

    try {
      const customer = await validateBillingCustomer.mutateAsync({
        companyId: billingCompanyId,
        customerId,
      });
      setValidatedBillingCustomer(customer);
      setBillingCustomerDirty(true);
      toast.success('Cliente localizado no Asaas.');
    } catch (error: any) {
      setValidatedBillingCustomer(null);
      toast.error(error?.message || 'Não foi possível validar o cliente no Asaas.');
    }
  };

  const persistBillingLink = async (companyId: string) => {
    const customerId = billingCustomerId.trim();
    let savedLink = billingLinkQuery.data ?? null;

    if (!billingCustomerDirty && !billingEnabledDirty) return;

    if (!customerId) {
      if (billingLinkQuery.data) {
        await removeBillingLink.mutateAsync({ companyId });
      }
      return;
    }

    if (billingCustomerDirty) {
      const result = await saveBillingLink.mutateAsync({
        companyId,
        customerId,
        descriptionMarker: PLATFORM_BILLING_DESCRIPTION_MARKER,
      });
      savedLink = result.link;
      if (result.warning) {
        toast.warning(result.warning);
      }
    }

    if (savedLink && savedLink.billingEnabled !== billingEnabled) {
      await setCompanyBillingEnabled.mutateAsync({
        companyId,
        enabled: billingEnabled,
        expectedBillingRevision: savedLink.billingRevision,
      });
    }
  };

  const handleBillingSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!billingCompanyId || billingLinkQuery.isLoading || billingLinkQuery.isError) return;

    try {
      await persistBillingLink(billingCompanyId);
      toast.success(`Configuração financeira de ${billingTarget?.name ?? 'empresa'} salva.`);
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error?.message || 'Não foi possível salvar a configuração financeira desta empresa.');
    }
  };

  const handleLogoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || publicCustomizationLocked) {
      event.target.value = '';
      return;
    }

    if (!file.type.startsWith('image/')) {
      toast.error('Selecione um arquivo de imagem válido');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_LOGO_FILE_SIZE) {
      toast.error('O logo deve ter no máximo 2MB');
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

    const cnpjError = getCnpjValidationMessage(form.cnpj, 'um CNPJ');
    if (cnpjError) {
      toast.error(cnpjError);
      return;
    }

    const phoneError = getPhoneValidationMessage(form.phone, 'um telefone');
    if (phoneError) {
      toast.error(phoneError);
      return;
    }

    const emailError = getEmailValidationMessage(form.email, 'um e-mail');
    if (emailError) {
      toast.error(emailError);
      return;
    }

    const responsibleEmailError = getEmailValidationMessage(form.responsible_email, 'o e-mail do responsável', !isEditing);
    if (responsibleEmailError) {
      toast.error(responsibleEmailError);
      return;
    }

    const responsiblePhoneError = getPhoneValidationMessage(form.responsible_phone, 'o telefone do responsável');
    if (responsiblePhoneError) {
      toast.error(responsiblePhoneError);
      return;
    }

    const whatsappError = getPhoneValidationMessage(form.whatsapp, 'um WhatsApp');
    if (whatsappError) {
      toast.error(whatsappError);
      return;
    }

    const payload: CompanyInsert = {
      ...form,
      cnpj: normalizeOptionalCnpj(form.cnpj),
      phone: formatBrazilPhone(form.phone),
      email: normalizeEmail(form.email),
      responsible_email: normalizeEmail(form.responsible_email),
      responsible_phone: formatBrazilPhone(form.responsible_phone),
      instagram: normalizeInstagramHandle(form.instagram) || null,
      logo_url: publicCustomizationLocked ? (company?.logo_url || '') : (form.logo_url || ''),
      description: publicCustomizationLocked ? (company?.description || '') : toSafeRichTextHtml(form.description || ''),
      whatsapp: publicCustomizationLocked ? (company?.whatsapp || '') : formatBrazilPhone(form.whatsapp),
      google_maps_url: normalizeGoogleMapsEmbedInput(form.google_maps_url) || '',
      opening_hours: normalizeOpeningHours(form.opening_hours),
      payment_methods: normalizePaymentMethods(form.payment_methods),
      reservation_duration: form.reservation_duration ?? 30,
      reservation_slot_interval_minutes: form.reservation_slot_interval_minutes ?? form.reservation_duration ?? 30,
      max_guests_per_slot: form.max_guests_per_slot ?? 0,
    };

    if ((form.google_maps_url || '').trim() && !payload.google_maps_url) {
      toast.error('Use um link de incorporação válido do Google Maps.');
      return;
    }

    if (company) {
      await updateCompany.mutateAsync({ id: company.id, ...payload });
      await saveCompanyFeatures.mutateAsync({
        companyId: company.id,
        features: featureForm,
      });
      try {
        await persistBillingLink(company.id);
      } catch (error: any) {
        toast.error(error?.message || 'A empresa foi salva, mas o vínculo financeiro não pôde ser atualizado.');
        setActiveTab('financeiro');
        return;
      }
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

      try {
        await persistBillingLink(createdCompanyId);
      } catch (error: any) {
        toast.error(error?.message || 'A empresa foi criada, mas o vínculo financeiro não pôde ser salvo.');
        onOpenChange(false);
        return;
      }
    }

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`flex h-[90vh] w-full flex-col overflow-hidden ${
        billingOnly ? 'sm:max-w-4xl' : 'sm:max-w-[90vw] sm:w-[90vw]'
      }`}>
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-3">
            <DialogTitle>
              {billingOnly
                ? `Configuração financeira · ${billingTarget.name}`
                : company
                  ? company.name
                  : 'Nova Empresa'}
            </DialogTitle>
            {headerStatus && (
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${headerStatus.className}`}>
                <Circle className="h-2 w-2 fill-current" />
                {headerStatus.label}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {billingOnly
              ? 'Gerencie o vínculo com o Asaas e a liberação do Financeiro desta empresa.'
              : isEditing
                ? 'Todas as configurações da empresa em um único modal.'
                : 'Cadastre a empresa e defina as configurações iniciais no mesmo fluxo.'}
          </p>
        </DialogHeader>

        <form
          onSubmit={billingOnly ? handleBillingSubmit : handleSubmit}
          className="mt-4 flex min-h-0 flex-1 flex-col"
        >
          <Tabs
            value={billingOnly ? 'financeiro' : activeTab}
            onValueChange={setActiveTab}
            className="flex min-h-0 flex-1 flex-col"
          >
            {!billingOnly && (
              <TabsList className={`grid w-full ${isEditing ? 'grid-cols-4' : 'grid-cols-3'}`}>
                <TabsTrigger value="geral">Geral</TabsTrigger>
                <TabsTrigger value="features">Features</TabsTrigger>
                <TabsTrigger value="financeiro">Financeiro</TabsTrigger>
                {isEditing && <TabsTrigger value="historico">Histórico</TabsTrigger>}
              </TabsList>
            )}

            <div className={`${billingOnly ? '' : 'mt-4'} flex-1 overflow-y-auto pr-1`}>
              {!billingOnly && <TabsContent value="geral" className="mt-0 space-y-6">
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
                        <Input
                          value={form.cnpj || ''}
                          onChange={(event) => setForm((current) => ({ ...current, cnpj: formatCnpj(event.target.value) }))}
                          maxLength={18}
                        />
                      </div>
                      <div>
                        <Label>Telefone</Label>
                        <Input
                          value={form.phone || ''}
                          onChange={(event) => setForm((current) => ({ ...current, phone: formatBrazilPhone(event.target.value) }))}
                          maxLength={15}
                        />
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
                            Envie PNG, JPG, WEBP ou SVG com até 2MB.
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
                          <p className="mt-1 text-xs text-muted-foreground">A logo da página pública fica bloqueada quando a feature de página pública customizada estiver desativada.</p>
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
                        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Responsável</p>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <Label>Nome do Responsável</Label>
                          <Input value={form.responsible_name || ''} onChange={(event) => setForm((current) => ({ ...current, responsible_name: event.target.value }))} />
                        </div>
                        <div>
                          <Label>Email do Responsável {!isEditing && '*'}</Label>
                          <Input type="email" value={form.responsible_email || ''} onChange={(event) => setForm((current) => ({ ...current, responsible_email: event.target.value }))} />
                        </div>
                        <div>
                          <Label>Telefone do Responsável</Label>
                          <Input
                            value={form.responsible_phone || ''}
                            onChange={(event) => setForm((current) => ({ ...current, responsible_phone: formatBrazilPhone(event.target.value) }))}
                            maxLength={15}
                          />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-4">
                      <div>
                        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Página pública e localização</p>
                        {publicCustomizationLocked && (
                          <p className="mt-1 text-xs text-muted-foreground">Descrição, logo e botão de WhatsApp ficam bloqueados. Endereço, mapa e pagamentos continuam disponíveis.</p>
                        )}
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="md:col-span-2">
                          <Label>Descrição</Label>
                          <RichTextEditor
                            value={form.description || ''}
                            onChange={(nextValue) => setForm((current) => ({ ...current, description: nextValue }))}
                            placeholder="Descreva a experiência, o ambiente e os diferenciais da empresa..."
                            disabled={publicCustomizationLocked}
                          />
                        </div>
                        <div>
                          <Label>Instagram</Label>
                          <Input
                            value={form.instagram || ''}
                            onChange={(event) => setForm((current) => ({ ...current, instagram: event.target.value }))}
                            onBlur={() => setForm((current) => ({ ...current, instagram: normalizeInstagramHandle(current.instagram) }))}
                            placeholder="pluguereservas"
                          />
                        </div>
                        <div>
                          <Label>WhatsApp</Label>
                          <Input
                            value={form.whatsapp || ''}
                            onChange={(event) => setForm((current) => ({ ...current, whatsapp: formatBrazilPhone(event.target.value) }))}
                            placeholder="(84) 99999-9999"
                            disabled={publicCustomizationLocked}
                            maxLength={15}
                          />
                        </div>
                        <div className="md:col-span-2">
                          <Label>Endereço</Label>
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
              </TabsContent>}

              {!billingOnly && <TabsContent value="operacao" className="mt-0 space-y-6">
                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-primary" /> Horários e capacidade
                    </CardTitle>
                    <CardDescription>Disponibilidade de reserva, duração e limite por horário.</CardDescription>
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
                              <span className="text-sm text-muted-foreground">às</span>
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
                        <Label>Duração da reserva</Label>
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
                        <Label>Capacidade máxima por horário</Label>
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
                    <CardDescription>Métodos aceitos pela empresa na página pública.</CardDescription>
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
                        Salve a empresa primeiro para cadastrar bloqueios de datas e horários.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>}

              <TabsContent value="financeiro" className="mt-0 space-y-6">
                <Card className="overflow-hidden border-primary/15 shadow-sm">
                  <div className="h-1 bg-primary" />
                  <CardHeader className="pb-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <CircleDollarSign className="h-4 w-4 text-primary" />
                          Mensalidades da Plug Guest
                        </CardTitle>
                        <CardDescription className="mt-1 max-w-2xl">
                          Vincule o Customer ID da conta global do Asaas. O sistema apenas consulta e exibe as cobranças identificadas.
                        </CardDescription>
                      </div>
                      <Badge variant="outline" className="w-fit border-border bg-muted/50 font-mono text-[11px] text-muted-foreground">
                        {PLATFORM_BILLING_DESCRIPTION_MARKER}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {billingModuleQuery.isFetching && !billingModuleQuery.data?.available ? (
                      <div className="space-y-3">
                        <Skeleton className="h-10 w-full max-w-xl" />
                        <Skeleton className="h-20 w-full max-w-xl" />
                      </div>
                    ) : !billingModuleQuery.data?.available ? (
                      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm leading-relaxed text-muted-foreground">
                        A estrutura financeira ainda não está disponível neste ambiente. O restante do cadastro da empresa continua funcionando normalmente.
                      </div>
                    ) : !billingModuleQuery.data.configured ? (
                      <div className="rounded-lg border border-warning/25 bg-warning-soft p-4 text-sm leading-relaxed text-amber-900">
                        Configure e valide primeiro o token global do Asaas na página de Integrações. Depois disso, este campo será liberado para vínculo.
                      </div>
                    ) : billingLinkQuery.isLoading && billingCompanyId ? (
                      <div className="space-y-3">
                        <Skeleton className="h-10 w-full max-w-xl" />
                        <Skeleton className="h-20 w-full max-w-xl" />
                      </div>
                    ) : billingLinkQuery.isError && billingCompanyId ? (
                      <div className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-destructive/25 bg-destructive-soft/50 p-4">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                          <div>
                            <p className="text-sm font-semibold text-destructive">Não foi possível carregar o vínculo financeiro</p>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              O Customer ID ficou bloqueado para evitar que uma falha de leitura pareça um vínculo vazio ou remova a configuração atual.
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void billingLinkQuery.refetch()}
                          className="gap-2"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Tentar novamente
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className={`max-w-2xl rounded-xl border p-4 transition-colors ${
                          billingEnabled
                            ? 'border-success/30 bg-success-soft/55'
                            : 'border-border bg-muted/20'
                        }`}>
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-start gap-3">
                              <div className={`mt-0.5 rounded-lg p-2 ${billingEnabled ? 'bg-success text-white' : 'bg-background text-muted-foreground shadow-sm'}`}>
                                <CircleDollarSign className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-semibold">Financeiro desta empresa</p>
                                  <Badge
                                    variant="outline"
                                    className={billingEnabled
                                      ? 'border-success/30 bg-background/70 text-success'
                                      : 'border-border bg-background/70 text-muted-foreground'}
                                  >
                                    {billingEnabled ? 'Ativo' : 'Desativado'}
                                  </Badge>
                                </div>
                                <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                                  {billingEnabled
                                    ? billingModuleQuery.data.enabled
                                      ? 'O admin da empresa verá as faturas, alertas de atraso e esta empresa participará da sincronização automática.'
                                      : 'A empresa está preparada, mas só verá as faturas quando o Financeiro global também estiver ativo.'
                                    : 'O admin da empresa não verá o Financeiro e ela ficará fora da sincronização automática. O superadmin ainda poderá abrir a prévia e sincronizar manualmente.'}
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-2 shadow-sm">
                              <Label htmlFor="company-platform-billing-enabled" className="cursor-pointer text-xs font-semibold">
                                {billingEnabled ? 'Liberado' : 'Desativado'}
                              </Label>
                              <Switch
                                id="company-platform-billing-enabled"
                                checked={billingEnabled}
                                onCheckedChange={(checked) => {
                                  setBillingEnabled(checked);
                                  setBillingEnabledDirty(true);
                                }}
                                disabled={pending || (!billingEnabled && validatedBillingCustomer?.id !== billingCustomerId.trim())}
                                aria-label={billingEnabled ? 'Desativar Financeiro nesta empresa' : 'Ativar Financeiro nesta empresa'}
                              />
                            </div>
                          </div>
                          {!billingEnabled && validatedBillingCustomer?.id !== billingCustomerId.trim() && (
                            <p className="mt-3 border-t border-border/70 pt-3 text-xs text-muted-foreground">
                              Localize ou valide um cliente do Asaas antes de liberar as cobranças para esta empresa.
                            </p>
                          )}
                        </div>

                        <AsaasCustomerFinder
                          companyId={billingCompanyId}
                          selectedCustomerId={billingCustomerId.trim()}
                          disabled={pending}
                          onSelect={handleBillingCustomerSelect}
                        />

                        <div className="max-w-2xl">
                          <div className="mb-2 flex items-center gap-3">
                            <span className="h-px flex-1 bg-border" />
                            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">ou informe manualmente</span>
                            <span className="h-px flex-1 bg-border" />
                          </div>
                          <Label htmlFor="company-asaas-customer-id">Customer ID do Asaas</Label>
                          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                            <Input
                              id="company-asaas-customer-id"
                              value={billingCustomerId}
                              onChange={(event) => handleBillingCustomerChange(event.target.value)}
                              placeholder="cus_000000000000"
                              autoComplete="off"
                              spellCheck={false}
                              className="font-mono"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              onClick={handleValidateBillingCustomer}
                              disabled={!billingCustomerId.trim() || validateBillingCustomer.isPending}
                              className="shrink-0 gap-2"
                            >
                              {validateBillingCustomer.isPending
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <RefreshCw className="h-4 w-4" />}
                              Validar cliente
                            </Button>
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                            Esse identificador não é secreto. O token global permanece protegido no backend e nunca é salvo na empresa.
                          </p>
                        </div>

                        {validatedBillingCustomer && (
                          <div className="max-w-2xl rounded-lg border border-success/25 bg-success-soft/65 p-4">
                            <div className="flex items-start gap-3">
                              <div className="rounded-full bg-background p-1.5 text-success shadow-sm">
                                <CheckCircle2 className="h-4 w-4" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">Cliente encontrado</p>
                                <p className="mt-1 truncate text-sm text-foreground/75">{validatedBillingCustomer.name}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {[validatedBillingCustomer.cpfCnpj, validatedBillingCustomer.email].filter(Boolean).join(' · ') || validatedBillingCustomer.id}
                                </p>
                                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{validatedBillingCustomer.id}</p>
                              </div>
                            </div>
                          </div>
                        )}

                        {billingLinkQuery.data?.lastSyncError && !billingCustomerDirty && (
                          <div className="max-w-2xl rounded-lg border border-destructive/25 bg-destructive-soft/60 p-4 text-sm text-destructive">
                            A última sincronização falhou: {billingLinkQuery.data.lastSyncError}
                          </div>
                        )}

                        {billingLinkQuery.data && !billingCustomerId.trim() && billingCustomerDirty && (
                          <div className="max-w-2xl rounded-lg border border-warning/25 bg-warning-soft p-4 text-sm text-amber-900">
                            O vínculo atual será removido ao salvar. A cópia local das faturas será limpa e poderá ser reconstruída ao vincular o cliente novamente.
                          </div>
                        )}

                        <div className="max-w-2xl rounded-lg border border-border bg-muted/20 px-4 py-3">
                          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Como o filtro funciona</p>
                          <p className="mt-1.5 text-sm leading-relaxed text-foreground/70">
                            A cada sincronização, serão importadas apenas as cobranças deste cliente cuja descrição contenha exatamente <span className="font-mono font-semibold text-foreground">{PLATFORM_BILLING_DESCRIPTION_MARKER}</span>.
                          </p>
                          {billingLinkQuery.data?.lastSyncedAt && !billingCustomerDirty && (
                            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                              <p>Última sincronização: {new Date(billingLinkQuery.data.lastSyncedAt).toLocaleString('pt-BR')}.</p>
                              <p>
                                {billingLinkQuery.data.lastMatchedCount} {billingLinkQuery.data.lastMatchedCount === 1 ? 'importada' : 'importadas'} de {billingLinkQuery.data.lastFetchedCount} {billingLinkQuery.data.lastFetchedCount === 1 ? 'cobrança encontrada' : 'cobranças encontradas'}
                                {billingLinkQuery.data.lastIgnoredCount > 0 ? ` · ${billingLinkQuery.data.lastIgnoredCount} sem o marcador` : ''}.
                              </p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {!billingOnly && <TabsContent value="features" className="mt-0">
                <Card className="border-none shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-primary" /> Features da empresa
                    </CardTitle>
                    <CardDescription>Ative ou desative os recursos disponíveis para esta empresa.</CardDescription>
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
              </TabsContent>}

              {!billingOnly && company && (
                <TabsContent value="historico" className="mt-0 space-y-6">
                  <Card className="border-none shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" /> Resumo de Cadastro
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <InfoRow icon={<Mail className="h-4 w-4 text-muted-foreground" />} label="Email principal" value={company.email} />
                      <InfoRow icon={<Phone className="h-4 w-4 text-muted-foreground" />} label="Telefone principal" value={formatBrazilPhone(company.phone)} />
                      <InfoRow icon={<MapPin className="h-4 w-4 text-muted-foreground" />} label="Endereço" value={company.address} />
                      <InfoRow icon={<Globe className="h-4 w-4 text-muted-foreground" />} label="Slug" value={company.slug} />
                      <InfoRow icon={<Calendar className="h-4 w-4 text-muted-foreground" />} label="Criada em" value={format(new Date(company.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })} />
                      <InfoRow icon={<Calendar className="h-4 w-4 text-muted-foreground" />} label="Atualizada em" value={format(new Date(company.updated_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })} />
                    </CardContent>
                  </Card>

                  <Card className="border-none shadow-sm">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Clock3 className="h-4 w-4 text-primary" /> Timeline
                      </CardTitle>
                      <CardDescription>Conta criada, primeira reserva, usuários e último acesso.</CardDescription>
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
                                      {format(new Date(event.occurred_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
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
                      <CardDescription>Últimos logins e acessos ao painel da empresa.</CardDescription>
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
            <Button
              type="submit"
              disabled={pending || (billingOnly && (billingLinkQuery.isLoading || billingLinkQuery.isError))}
            >
              {pending && <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {billingOnly ? 'Salvar Financeiro' : isEditing ? 'Salvar alterações' : 'Criar empresa'}
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
