import { useEffect, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import {
  Save,
  Clock,
  CreditCard,
  MapPin,
  Info,
  Instagram,
  Loader2,
  MessageCircle,
  Phone,
  CalendarOff,
  Trash2,
  Upload,
  Users,
  Copy,
  Banknote,
  QrCode,
  Wallet,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import BlockedDatesTab from '@/components/company/BlockedDatesTab';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import type { Company } from '@/hooks/useCompanies';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { getGoogleMapsEmbedUrl, normalizeGoogleMapsEmbedInput } from '@/lib/maps';
import { cn } from '@/lib/utils';

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
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
  { key: 'dinheiro', label: 'Dinheiro', description: 'Pagamento em espécie', icon: Banknote },
  { key: 'credito', label: 'Cartão de crédito', description: 'Visa, Mastercard, Elo, etc.', icon: CreditCard },
  { key: 'debito', label: 'Cartão de débito', description: 'Débito à vista', icon: CreditCard },
  { key: 'pix', label: 'Pix', description: 'Transferência instantânea', icon: QrCode },
  { key: 'vale_refeicao', label: 'Vale refeição', description: 'Alelo, Sodexo, VR, etc.', icon: Wallet },
];

const DEFAULT_PAYMENTS: Record<string, boolean> = {
  dinheiro: true,
  credito: true,
  debito: true,
  pix: true,
  vale_refeicao: false,
};

const SETTINGS_TABS = ['hours', 'payments', 'info', 'location', 'blocked'] as const;
const SETTINGS_TAB_ITEMS = [
  { value: 'hours', label: 'Horários', icon: Clock },
  { value: 'payments', label: 'Pagamentos', icon: CreditCard },
  { value: 'info', label: 'Informações', icon: Info },
  { value: 'location', label: 'Localização', icon: MapPin },
  { value: 'blocked', label: 'Bloqueios', icon: CalendarOff },
] as const;
const settingsCardClassName = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const settingsFieldClassName = 'h-10 rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsTextAreaClassName = 'rounded-xl border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsBadgeClassName = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;

type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && SETTINGS_TABS.includes(value as SettingsTab);
}

function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

export default function CompanySettings() {
  const { companyId, companyName, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: company, isLoading } = useQuery({
    queryKey: ['company-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('description, logo_url, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot')
        .eq('id', companyId)
        .maybeSingle();

      if (error) throw error;
      return data as Company | null;
    },
    enabled: !!companyId,
  });

  const { data: featureFlags } = useCompanyFeatureFlags(companyId);

  const [hours, setHours] = useState<OpeningHour[]>(DEFAULT_HOURS);
  const [payments, setPayments] = useState<Record<string, boolean>>(DEFAULT_PAYMENTS);
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [showPublicWhatsappButton, setShowPublicWhatsappButton] = useState('show');
  const [publicWaitlistEnabled, setPublicWaitlistEnabled] = useState(false);
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [reservationDuration, setReservationDuration] = useState(30);
  const [maxGuestsPerSlot, setMaxGuestsPerSlot] = useState(0);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!company || initialized) return;

    setHours((company.opening_hours as OpeningHour[]) || DEFAULT_HOURS);
    setPayments((company.payment_methods as Record<string, boolean>) || DEFAULT_PAYMENTS);
    setDescription(company.description || '');
    setLogoUrl(company.logo_url || '');
    setAddress(company.address || '');
    setPhone(company.phone || '');
    setInstagram(company.instagram || '');
    setWhatsapp(company.whatsapp || '');
    setShowPublicWhatsappButton((company.show_public_whatsapp_button ?? true) ? 'show' : 'hide');
    setPublicWaitlistEnabled(company.public_waitlist_enabled ?? false);
    setGoogleMapsUrl(company.google_maps_url || '');
    setReservationDuration((company as any).reservation_duration ?? 30);
    setMaxGuestsPerSlot((company as any).max_guests_per_slot ?? 0);
    setInitialized(true);
  }, [company, initialized]);

  const publicCustomizationLocked = featureFlags
    ? !featureFlags.features.custom_public_page
    : false;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!company) throw new Error('Empresa não encontrada');

      const normalizedMapsEmbedUrl = normalizeGoogleMapsEmbedInput(googleMapsUrl);

      if (googleMapsUrl.trim() && !normalizedMapsEmbedUrl) {
        throw new Error('Use um link de incorporacao valido do Google Maps.');
      }

      const { error } = await supabase
        .from('companies' as any)
        .update({
          opening_hours: hours,
          payment_methods: payments,
          description: publicCustomizationLocked ? (company.description || '') : description,
          logo_url: publicCustomizationLocked ? (company.logo_url || '') : logoUrl,
          address,
          phone,
          instagram,
          whatsapp: publicCustomizationLocked ? (company.whatsapp || '') : whatsapp,
          show_public_whatsapp_button: publicCustomizationLocked
            ? (company.show_public_whatsapp_button ?? true)
            : showPublicWhatsappButton === 'show',
          public_waitlist_enabled: publicWaitlistEnabled,
          google_maps_url: normalizedMapsEmbedUrl || null,
          reservation_duration: reservationDuration,
          max_guests_per_slot: maxGuestsPerSlot,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', companyId);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-settings', companyId] });
      qc.invalidateQueries({ queryKey: ['company-public', slug] });
      toast.success('Configurações salvas!');
    },
    onError: (error: any) => {
      toast.error(`Erro ao salvar: ${error.message}`);
    },
  });

  const updateHour = (index: number, field: keyof OpeningHour, value: string | boolean) => {
    setHours((current) => current.map((hour, currentIndex) => (
      currentIndex === index ? { ...hour, [field]: value } : hour
    )));
  };

  const publicWaitlistUrl = typeof window === 'undefined'
    ? `/${slug}/fila`
    : `${window.location.origin}/${slug}/fila`;
  const activeTab: SettingsTab = isSettingsTab(searchParams.get('tab'))
    ? searchParams.get('tab')!
    : 'hours';

  const handleTabChange = (value: string) => {
    if (!isSettingsTab(value)) return;

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (value === 'hours') {
        next.delete('tab');
      } else {
        next.set('tab', value);
      }

      return next;
    }, { replace: true });
  };

  const copyPublicWaitlistUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicWaitlistUrl);
      toast.success('Link da fila copiado!');
    } catch {
      toast.error('Não foi possível copiar o link.');
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
      const slugBase = slugify(slug || companyName || 'empresa');
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

      setLogoUrl(publicUrlData.publicUrl);
      toast.success('Logo enviado com sucesso');
    } catch (error: any) {
      toast.error(`Erro ao enviar logo: ${error.message}`);
    } finally {
      setUploadingLogo(false);
      event.target.value = '';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Configuracoes</h1>
          <p className="mt-1 text-sm text-muted-foreground">Configuracoes da unidade {companyName}</p>
        </div>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="h-10 gap-2 self-start rounded-lg px-4"
        >
          <Save className="h-4 w-4" />
          Salvar tudo
        </Button>
      </div>

      {publicCustomizationLocked && (
        <Card className="rounded-xl border border-primary/20 bg-primary-soft shadow-none">
          <CardContent className="py-3">
            <p className="text-sm font-medium text-primary">Pagina publica customizada indisponivel neste plano.</p>
            <p className="mt-1 text-sm text-primary/85">
              Logo, descricao e botao do WhatsApp ficam bloqueados. Endereco, mapa e pagamentos continuam disponiveis.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto w-max min-w-full justify-start rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-1 md:min-w-0">
            {SETTINGS_TAB_ITEMS.map((tab) => {
              const Icon = tab.icon;

              return (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="min-h-[36px] shrink-0 gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="hours" className="space-y-4">
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Clock className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Horario de funcionamento</CardTitle>
                  <CardDescription>Defina os horarios de abertura e fechamento para cada dia.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div>
                {hours.map((hour, index) => (
                  <div
                    key={hour.day}
                    className={cn(
                      'flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-5',
                      index < hours.length - 1 && 'border-b border-[rgba(0,0,0,0.08)]',
                    )}
                  >
                    <span className="w-12 shrink-0 text-sm font-semibold">{hour.day}</span>
                    <div className="flex flex-1 flex-wrap items-center gap-3">
                      <Switch checked={!hour.closed} onCheckedChange={(checked) => updateHour(index, 'closed', !checked)} />
                      {!hour.closed ? (
                        <>
                          <Input
                            type="time"
                            value={hour.open}
                            onChange={(event) => updateHour(index, 'open', event.target.value)}
                            className={cn('w-full max-w-[132px]', settingsFieldClassName)}
                          />
                          <span className="text-sm text-muted-foreground">as</span>
                          <Input
                            type="time"
                            value={hour.close}
                            onChange={(event) => updateHour(index, 'close', event.target.value)}
                            className={cn('w-full max-w-[132px]', settingsFieldClassName)}
                          />
                        </>
                      ) : (
                        <span className="text-sm italic text-muted-foreground">Fechado</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card className={settingsCardClassName}>
              <CardHeader className="space-y-0 pb-2">
                <div className="flex items-start gap-3">
                  <div className={settingsBadgeClassName}>
                    <Clock className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-lg">Duracao de cada reserva</CardTitle>
                    <CardDescription>Intervalo entre os horarios disponiveis.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Duracao</Label>
                  <Select value={String(reservationDuration)} onValueChange={(value) => setReservationDuration(Number(value))}>
                    <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar duracao da reserva">
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
              </CardContent>
            </Card>

            <Card className={settingsCardClassName}>
              <CardHeader className="space-y-0 pb-2">
                <div className="flex items-start gap-3">
                  <div className={settingsBadgeClassName}>
                    <Users className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-lg">Capacidade maxima / horario</CardTitle>
                    <CardDescription>Total de pessoas por horario. 0 = sem limite.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-2">
                  <Label htmlFor="company-settings-max-guests" className="text-sm text-muted-foreground">Pessoas</Label>
                  <Input
                    id="company-settings-max-guests"
                    name="max_guests_per_slot"
                    type="number"
                    min={0}
                    value={maxGuestsPerSlot}
                    onChange={(event) => setMaxGuestsPerSlot(Number(event.target.value))}
                    className={settingsFieldClassName}
                    placeholder="0"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <CreditCard className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Formas de pagamento</CardTitle>
                  <CardDescription>Selecione quais formas de pagamento sao aceitas.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div>
                {PAYMENT_OPTIONS.map((option, index) => {
                  const Icon = option.icon;

                  return (
                    <div
                      key={option.key}
                      className={cn(
                        'flex items-center justify-between gap-4 py-4',
                        index < PAYMENT_OPTIONS.length - 1 && 'border-b border-[rgba(0,0,0,0.08)]',
                      )}
                    >
                      <Label htmlFor={`pay-${option.key}`} className="flex flex-1 cursor-pointer items-center gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-foreground">{option.label}</div>
                          <div className="text-sm text-muted-foreground">{option.description}</div>
                        </div>
                      </Label>
                      <Switch
                        id={`pay-${option.key}`}
                        checked={!!payments[option.key]}
                        onCheckedChange={(checked) => setPayments((current) => ({ ...current, [option.key]: checked }))}
                      />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="info">
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Info className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Informacoes da empresa</CardTitle>
                  <CardDescription>Dados exibidos na pagina publica e no link oculto da fila.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-8 pt-2">
              <div className="space-y-3">
                <Label>Logo da empresa</Label>
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

                  {logoUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={publicCustomizationLocked || uploadingLogo}
                      onClick={() => setLogoUrl('')}
                      className="gap-2 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Remover
                    </Button>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">Envie PNG, JPG, WEBP ou SVG com ate 2MB.</p>

                <div className="flex min-h-28 max-w-sm items-center justify-center rounded-2xl border border-dashed border-[rgba(0,0,0,0.14)] bg-muted/20 p-4">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt={companyName ? `Logo de ${companyName}` : 'Logo da empresa'}
                      className="max-h-20 w-auto max-w-full object-contain"
                    />
                  ) : (
                    <p className="text-center text-xs text-muted-foreground">Nenhum logo enviado ainda.</p>
                  )}
                </div>

                {publicCustomizationLocked && (
                  <p className="text-xs text-muted-foreground">A logo pública fica bloqueada quando a página pública customizada está desativada.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="company-settings-description">Descricao</Label>
                <Textarea
                  id="company-settings-description"
                  name="description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Descreva seu restaurante para os clientes..."
                  rows={4}
                  disabled={publicCustomizationLocked}
                  className={settingsTextAreaClassName}
                  autoComplete="off"
                />
                {publicCustomizationLocked && (
                  <p className="mt-1 text-xs text-muted-foreground">A descrição pública fica bloqueada quando a página pública customizada está desativada.</p>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="company-settings-phone" className="flex items-center gap-1.5"><Phone className="h-4 w-4" /> Telefone</Label>
                  <Input
                    id="company-settings-phone"
                    name="phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="(84) 3333-4444"
                    className={settingsFieldClassName}
                    autoComplete="tel"
                    inputMode="tel"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="company-settings-instagram" className="flex items-center gap-1.5"><Instagram className="h-4 w-4" /> Instagram</Label>
                  <Input
                    id="company-settings-instagram"
                    name="instagram"
                    value={instagram}
                    onChange={(event) => setInstagram(event.target.value)}
                    placeholder="@restaurante"
                    className={settingsFieldClassName}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="company-settings-whatsapp" className="flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> WhatsApp</Label>
                  <Input
                    id="company-settings-whatsapp"
                    name="whatsapp"
                    value={whatsapp}
                    onChange={(event) => setWhatsapp(event.target.value)}
                    placeholder="5584999999999"
                    disabled={publicCustomizationLocked}
                    className={settingsFieldClassName}
                    autoComplete="tel"
                    inputMode="tel"
                  />
                  {publicCustomizationLocked && (
                    <p className="text-xs text-muted-foreground">O WhatsApp publico fica bloqueado enquanto a feature estiver desativada.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Botao de WhatsApp na pagina publica</Label>
                  <Select value={showPublicWhatsappButton} onValueChange={setShowPublicWhatsappButton} disabled={publicCustomizationLocked}>
                    <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar exibicao do botao de WhatsApp">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="show">Mostrar botao</SelectItem>
                      <SelectItem value="hide">Ocultar botao</SelectItem>
                    </SelectContent>
                  </Select>
                  {publicCustomizationLocked && (
                    <p className="text-xs text-muted-foreground">O botao de WhatsApp fica bloqueado enquanto a feature estiver desativada.</p>
                  )}
                </div>
              </div>

              <div className="border-t border-[rgba(0,0,0,0.08)] pt-4">
                <div className="space-y-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/20 p-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <Label className="flex items-center gap-1.5 text-base font-semibold">
                        <Users className="h-4 w-4" />
                        Entrada publica na fila de espera
                      </Label>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Este link nao aparece na pagina publica. So entra quem receber a URL direta.
                      </p>
                    </div>
                    <Switch checked={publicWaitlistEnabled} onCheckedChange={setPublicWaitlistEnabled} />
                  </div>

                  <div className="flex flex-col gap-3 md:flex-row">
                    <Input value={publicWaitlistUrl} readOnly className={cn('font-mono text-sm', settingsFieldClassName)} />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 shrink-0 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-4"
                      onClick={copyPublicWaitlistUrl}
                    >
                      <Copy className="h-4 w-4" />
                      Copiar
                    </Button>
                  </div>

                  {!publicWaitlistEnabled && (
                    <p className="text-xs text-muted-foreground">
                      Quando desabilitado, quem acessar este link vera uma mensagem orientando a se dirigir a unidade para entrar na fila de espera.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="location">
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <MapPin className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Localizacao</CardTitle>
                  <CardDescription>Endereco e mapa exibidos na pagina publica.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-2">
              <div className="space-y-2">
                <Label htmlFor="company-settings-address">Endereco completo</Label>
                <Textarea
                  id="company-settings-address"
                  name="address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Rua, numero, bairro, cidade - UF"
                  rows={3}
                  className={settingsTextAreaClassName}
                  autoComplete="street-address"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="company-settings-google-maps">Link do Google Maps (embed)</Label>
                <Input
                  id="company-settings-google-maps"
                  name="google_maps_url"
                  type="url"
                  value={googleMapsUrl}
                  onChange={(event) => setGoogleMapsUrl(event.target.value)}
                  placeholder="https://www.google.com/maps/embed?pb=..."
                  className={settingsFieldClassName}
                  autoComplete="url"
                  inputMode="url"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  No Google Maps: "Compartilhar" -&gt; "Incorporar mapa" -&gt; copie o valor do atributo{' '}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">src</span> do iframe gerado.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Previa do mapa</Label>
                <div className="overflow-hidden rounded-xl border border-dashed border-[rgba(0,0,0,0.14)] bg-muted/15">
                  {getGoogleMapsEmbedUrl(googleMapsUrl, address || 'Brasil') ? (
                    <iframe
                      src={getGoogleMapsEmbedUrl(googleMapsUrl, address || 'Brasil') ?? undefined}
                      width="100%"
                      height="280"
                      style={{ border: 0 }}
                      allowFullScreen
                      loading="lazy"
                      sandbox="allow-scripts allow-same-origin allow-popups"
                      title="Previa do mapa"
                    />
                  ) : (
                    <div className="flex h-[180px] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/90 text-muted-foreground">
                        <MapPin className="h-5 w-5" />
                      </div>
                      <p>Cole o link acima para visualizar o mapa</p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blocked">
          <BlockedDatesTab companyId={companyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
