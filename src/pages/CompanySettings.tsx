import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
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
  Trash2,
  Upload,
  Megaphone,
  ImageIcon,
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
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import type { Company } from '@/hooks/useCompanies';
import { useCompanyFeatureFlags } from '@/hooks/useCompanyFeatures';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { getGoogleMapsEmbedUrl, normalizeGoogleMapsEmbedInput } from '@/lib/maps';
import {
  DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT,
  DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT_SIZE,
  DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT,
  DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE,
  PUBLIC_RESERVATION_EXIT_PROMPT_SIZE_OPTIONS,
  PUBLIC_RESERVATION_EXIT_PROMPT_TEXT_HELPER,
  getPublicReservationExitPromptTextClassName,
  getPublicReservationExitPromptTextValue,
  normalizePublicReservationExitPromptTextSize,
  renderPublicReservationExitPromptText,
  type PublicReservationExitPromptMarkupTag,
} from '@/lib/publicReservationExitPrompt';
import { cn } from '@/lib/utils';
import { toSafeRichTextHtml } from '@/lib/richText';
import { formatBrazilPhone, getPhoneValidationMessage, normalizeInstagramHandle } from '@/lib/validation';

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
}

interface CompanyPublicNoticeSettings {
  id: string;
  company_id: string;
  text: string | null;
  image_url: string | null;
  is_active: boolean;
  active_until: string | null;
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

const SETTINGS_TABS = ['info', 'location', 'hours', 'payments', 'public-page'] as const;
const SETTINGS_TAB_ITEMS = [
  { value: 'info', label: 'Informações', icon: Info },
  { value: 'location', label: 'Localização', icon: MapPin },
  { value: 'hours', label: 'Horários', icon: Clock },
  { value: 'payments', label: 'Pagamentos', icon: CreditCard },
  { value: 'public-page', label: 'Página Pública', icon: Megaphone },
] as const;
const settingsCardClassName = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const settingsFieldClassName = 'h-10 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsTextAreaClassName = 'rounded-xl border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsBadgeClassName = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const settingsFieldGroupClassName = 'flex min-w-0 flex-col gap-2';
const settingsLabelClassName = 'flex min-h-5 items-center gap-1.5 leading-5';
const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;
const MAX_NOTICE_IMAGE_FILE_SIZE = 2 * 1024 * 1024;
const COMPANY_SETTINGS_SELECT = 'description, logo_url, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, show_public_reservation_exit_prompt, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot, public_reservation_exit_prompt_primary_text, public_reservation_exit_prompt_primary_text_size, public_reservation_exit_prompt_secondary_text, public_reservation_exit_prompt_secondary_text_size';
const COMPANY_SETTINGS_SELECT_WITH_EXIT_PROMPT = 'description, logo_url, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, show_public_reservation_exit_prompt, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot';
const COMPANY_SETTINGS_SELECT_WITH_STICKY = 'description, logo_url, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot';
const COMPANY_SETTINGS_SELECT_LEGACY = 'description, logo_url, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot';

type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && SETTINGS_TABS.includes(value as SettingsTab);
}

function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (isSettingsTab(value)) return value;
  if (value === 'blocked') return 'hours';
  return null;
}

function isMissingCompanySettingsColumnError(error: unknown, columnName: string) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';

  return (code === '42703' || message.toLowerCase().includes('does not exist'))
    && message.includes(columnName);
}

function isMissingAnyCompanySettingsColumnError(error: unknown, columnNames: string[]) {
  return columnNames.some((columnName) => isMissingCompanySettingsColumnError(error, columnName));
}

function slugify(text: string) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function toDateTimeLocalValue(value?: string | null) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value: string) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

export default function CompanySettings() {
  const { companyId, companyName, slug } = useCompanySlug();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: company, isLoading, error: companyError } = useQuery({
    queryKey: ['company-settings', companyId],
    queryFn: async () => {
      const selectAttempts = [
        {
          select: COMPANY_SETTINGS_SELECT,
          missingColumns: [
            'public_reservation_exit_prompt_primary_text',
            'public_reservation_exit_prompt_primary_text_size',
            'public_reservation_exit_prompt_secondary_text',
            'public_reservation_exit_prompt_secondary_text_size',
          ],
        },
        {
          select: COMPANY_SETTINGS_SELECT_WITH_EXIT_PROMPT,
          missingColumns: ['show_public_reservation_exit_prompt'],
        },
        {
          select: COMPANY_SETTINGS_SELECT_WITH_STICKY,
          missingColumns: ['show_public_sticky_reserve_button'],
        },
        {
          select: COMPANY_SETTINGS_SELECT_LEGACY,
          missingColumns: [],
        },
      ] as const;

      for (const attempt of selectAttempts) {
        const result = await supabase
          .from('companies' as any)
          .select(attempt.select)
          .eq('id', companyId)
          .maybeSingle();

        if (!result.error) {
          return result.data as Company | null;
        }

        if (attempt.missingColumns.length > 0 && isMissingAnyCompanySettingsColumnError(result.error, attempt.missingColumns)) {
          continue;
        }

        throw result.error;
      }

      return null;
    },
    enabled: !!companyId,
    retry: false,
  });

  const { data: featureFlags } = useCompanyFeatureFlags(companyId);

  const { data: publicNotice } = useQuery({
    queryKey: ['company-public-notice-settings', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_public_notices' as any)
        .select('id, company_id, text, image_url, is_active, active_until')
        .eq('company_id', companyId!)
        .maybeSingle();

      if (error) throw error;
      return data as CompanyPublicNoticeSettings | null;
    },
    enabled: !!companyId,
  });

  const [hours, setHours] = useState<OpeningHour[]>(DEFAULT_HOURS);
  const [payments, setPayments] = useState<Record<string, boolean>>(DEFAULT_PAYMENTS);
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [showPublicWhatsappButton, setShowPublicWhatsappButton] = useState('show');
  const [showPublicStickyReserveButton, setShowPublicStickyReserveButton] = useState(true);
  const [showPublicReservationExitPrompt, setShowPublicReservationExitPrompt] = useState(false);
  const [publicReservationExitPromptPrimaryText, setPublicReservationExitPromptPrimaryText] = useState(DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT);
  const [publicReservationExitPromptPrimaryTextSize, setPublicReservationExitPromptPrimaryTextSize] = useState(DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT_SIZE);
  const [publicReservationExitPromptSecondaryText, setPublicReservationExitPromptSecondaryText] = useState(DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT);
  const [publicReservationExitPromptSecondaryTextSize, setPublicReservationExitPromptSecondaryTextSize] = useState(DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE);
  const [publicWaitlistEnabled, setPublicWaitlistEnabled] = useState(false);
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [reservationDuration, setReservationDuration] = useState(30);
  const [maxGuestsPerSlot, setMaxGuestsPerSlot] = useState(0);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [noticeText, setNoticeText] = useState('');
  const [noticeImageUrl, setNoticeImageUrl] = useState('');
  const [noticeActive, setNoticeActive] = useState(false);
  const [noticeActiveUntil, setNoticeActiveUntil] = useState('');
  const [uploadingNoticeImage, setUploadingNoticeImage] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const publicReservationExitPromptPrimaryTextRef = useRef<HTMLTextAreaElement | null>(null);
  const publicReservationExitPromptSecondaryTextRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setInitialized(false);
  }, [companyId]);

  useEffect(() => {
    if (!company || initialized) return;

    setHours((company.opening_hours as OpeningHour[]) || DEFAULT_HOURS);
    setPayments((company.payment_methods as Record<string, boolean>) || DEFAULT_PAYMENTS);
    setDescription(company.description || '');
    setLogoUrl(company.logo_url || '');
    setAddress(company.address || '');
    setPhone(formatBrazilPhone(company.phone));
    setInstagram(normalizeInstagramHandle(company.instagram));
    setWhatsapp(formatBrazilPhone(company.whatsapp));
    setShowPublicWhatsappButton((company.show_public_whatsapp_button ?? true) ? 'show' : 'hide');
    setShowPublicStickyReserveButton((company as any).show_public_sticky_reserve_button ?? true);
    setShowPublicReservationExitPrompt((company as any).show_public_reservation_exit_prompt ?? false);
    setPublicReservationExitPromptPrimaryText(getPublicReservationExitPromptTextValue(
      (company as any).public_reservation_exit_prompt_primary_text,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT,
    ));
    setPublicReservationExitPromptPrimaryTextSize(normalizePublicReservationExitPromptTextSize(
      (company as any).public_reservation_exit_prompt_primary_text_size,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT_SIZE,
    ));
    setPublicReservationExitPromptSecondaryText(getPublicReservationExitPromptTextValue(
      (company as any).public_reservation_exit_prompt_secondary_text,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT,
    ));
    setPublicReservationExitPromptSecondaryTextSize(normalizePublicReservationExitPromptTextSize(
      (company as any).public_reservation_exit_prompt_secondary_text_size,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE,
    ));
    setPublicWaitlistEnabled(company.public_waitlist_enabled ?? false);
    setGoogleMapsUrl(company.google_maps_url || '');
    setReservationDuration((company as any).reservation_duration ?? 30);
    setMaxGuestsPerSlot((company as any).max_guests_per_slot ?? 0);
    setInitialized(true);
  }, [company, initialized]);

  useEffect(() => {
    if (publicNotice === undefined) return;

    if (!publicNotice) {
      setNoticeText('');
      setNoticeImageUrl('');
      setNoticeActive(false);
      setNoticeActiveUntil('');
      return;
    }

    const noticeExpiresAt = publicNotice.active_until ? new Date(publicNotice.active_until) : null;
    const isNoticeStillActive = publicNotice.is_active
      && !!noticeExpiresAt
      && noticeExpiresAt.getTime() > Date.now();

    setNoticeText(publicNotice.text || '');
    setNoticeImageUrl(publicNotice.image_url || '');
    setNoticeActive(isNoticeStillActive);
    setNoticeActiveUntil(toDateTimeLocalValue(publicNotice.active_until));
  }, [publicNotice]);

  const publicCustomizationLocked = featureFlags
    ? !featureFlags.features.custom_public_page
    : false;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!company) throw new Error('Empresa não encontrada');

      const normalizedMapsEmbedUrl = normalizeGoogleMapsEmbedInput(googleMapsUrl);

      if (googleMapsUrl.trim() && !normalizedMapsEmbedUrl) {
        throw new Error('Use um link de incorporação válido do Google Maps.');
      }

      const phoneError = getPhoneValidationMessage(phone, 'um telefone');
      if (phoneError) {
        throw new Error(phoneError);
      }

      const whatsappError = getPhoneValidationMessage(whatsapp, 'um WhatsApp');
      if (whatsappError) {
        throw new Error(whatsappError);
      }

      const trimmedNoticeText = noticeText.trim();
      const hasNoticeContent = !!trimmedNoticeText || !!noticeImageUrl;
      const noticeActiveUntilIso = fromDateTimeLocalValue(noticeActiveUntil);
      const normalizedReservationExitPromptPrimaryText = publicReservationExitPromptPrimaryText.replace(/\r\n/g, '\n');
      const normalizedReservationExitPromptSecondaryText = publicReservationExitPromptSecondaryText.replace(/\r\n/g, '\n');

      if (!publicCustomizationLocked && noticeActive) {
        if (!hasNoticeContent) {
          throw new Error('Informe um texto ou uma imagem para ativar o aviso.');
        }

        if (!noticeActiveUntilIso) {
          throw new Error('Informe até quando o aviso deve ficar ativo.');
        }

        if (new Date(noticeActiveUntilIso).getTime() <= Date.now()) {
          throw new Error('A data final do aviso precisa ser futura.');
        }
      }

      const baseCompanyUpdate = {
        opening_hours: hours,
        payment_methods: payments,
        description: publicCustomizationLocked ? (company.description || '') : toSafeRichTextHtml(description),
        logo_url: publicCustomizationLocked ? (company.logo_url || '') : logoUrl,
        address,
        phone: formatBrazilPhone(phone),
        instagram: normalizeInstagramHandle(instagram) || null,
        whatsapp: publicCustomizationLocked ? (company.whatsapp || '') : formatBrazilPhone(whatsapp),
        show_public_whatsapp_button: publicCustomizationLocked
          ? (company.show_public_whatsapp_button ?? true)
          : showPublicWhatsappButton === 'show',
        public_waitlist_enabled: publicWaitlistEnabled,
        google_maps_url: normalizedMapsEmbedUrl || null,
        reservation_duration: reservationDuration,
        max_guests_per_slot: maxGuestsPerSlot,
        updated_at: new Date().toISOString(),
      } as any;

      const updateAttempts = [
        {
          payload: {
            ...baseCompanyUpdate,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
            show_public_reservation_exit_prompt: showPublicReservationExitPrompt,
            public_reservation_exit_prompt_primary_text: normalizedReservationExitPromptPrimaryText,
            public_reservation_exit_prompt_primary_text_size: publicReservationExitPromptPrimaryTextSize,
            public_reservation_exit_prompt_secondary_text: normalizedReservationExitPromptSecondaryText,
            public_reservation_exit_prompt_secondary_text_size: publicReservationExitPromptSecondaryTextSize,
          } as any,
          missingColumns: [
            'public_reservation_exit_prompt_primary_text',
            'public_reservation_exit_prompt_primary_text_size',
            'public_reservation_exit_prompt_secondary_text',
            'public_reservation_exit_prompt_secondary_text_size',
          ],
        },
        {
          payload: {
            ...baseCompanyUpdate,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
            show_public_reservation_exit_prompt: showPublicReservationExitPrompt,
          } as any,
          missingColumns: ['show_public_reservation_exit_prompt'],
        },
        {
          payload: {
            ...baseCompanyUpdate,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
          } as any,
          missingColumns: ['show_public_sticky_reserve_button'],
        },
        {
          payload: baseCompanyUpdate,
          missingColumns: [],
        },
      ] as const;

      let updatedCompany: { id: string } | null = null;
      let error: unknown = null;

      for (const attempt of updateAttempts) {
        const result = await supabase
          .from('companies' as any)
          .update(attempt.payload)
          .eq('id', companyId)
          .select('id')
          .maybeSingle();

        if (!result.error) {
          updatedCompany = result.data;
          error = null;
          break;
        }

        error = result.error;

        if (attempt.missingColumns.length > 0 && isMissingAnyCompanySettingsColumnError(result.error, attempt.missingColumns)) {
          continue;
        }

        throw result.error;
      }

      if (error) throw error;
      if (!updatedCompany) throw new Error('Sem permissão para salvar as configurações desta unidade.');

      if (!publicCustomizationLocked && (publicNotice || hasNoticeContent || noticeActiveUntilIso || noticeActive)) {
        const { error: noticeError } = await supabase
          .from('company_public_notices' as any)
          .upsert({
            company_id: companyId,
            text: trimmedNoticeText || null,
            image_url: noticeImageUrl || null,
            is_active: noticeActive,
            active_until: noticeActiveUntilIso,
          }, { onConflict: 'company_id' });

        if (noticeError) throw noticeError;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-settings', companyId] });
      qc.invalidateQueries({ queryKey: ['company-public', slug] });
      qc.invalidateQueries({ queryKey: ['reservation-settings', companyId] });
      qc.invalidateQueries({ queryKey: ['company-public-notice', companyId] });
      qc.invalidateQueries({ queryKey: ['company-public-notice-settings', companyId] });
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
  const activeTab: SettingsTab = normalizeSettingsTab(searchParams.get('tab')) ?? 'info';

  const handleTabChange = (value: string) => {
    if (!isSettingsTab(value)) return;

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (value === 'info') {
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

  const previewCompanyName = companyName || 'sua empresa';
  const previewReservationExitPromptPrimaryText = useMemo(
    () => getPublicReservationExitPromptTextValue(
      publicReservationExitPromptPrimaryText,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT,
    ),
    [publicReservationExitPromptPrimaryText],
  );
  const previewReservationExitPromptSecondaryText = useMemo(
    () => getPublicReservationExitPromptTextValue(
      publicReservationExitPromptSecondaryText,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT,
    ),
    [publicReservationExitPromptSecondaryText],
  );
  const previewReservationExitPromptPrimaryTextSize = useMemo(
    () => normalizePublicReservationExitPromptTextSize(
      publicReservationExitPromptPrimaryTextSize,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_PRIMARY_TEXT_SIZE,
    ),
    [publicReservationExitPromptPrimaryTextSize],
  );
  const previewReservationExitPromptSecondaryTextSize = useMemo(
    () => normalizePublicReservationExitPromptTextSize(
      publicReservationExitPromptSecondaryTextSize,
      DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE,
    ),
    [publicReservationExitPromptSecondaryTextSize],
  );

  const wrapPublicReservationExitPromptSelection = (
    field: 'primary' | 'secondary',
    tag: PublicReservationExitPromptMarkupTag,
  ) => {
    const textarea = field === 'primary'
      ? publicReservationExitPromptPrimaryTextRef.current
      : publicReservationExitPromptSecondaryTextRef.current;
    const value = field === 'primary'
      ? publicReservationExitPromptPrimaryText
      : publicReservationExitPromptSecondaryText;
    const setValue = field === 'primary'
      ? setPublicReservationExitPromptPrimaryText
      : setPublicReservationExitPromptSecondaryText;
    const openTag = `{${tag}}`;
    const closeTag = `{/${tag}}`;

    if (!textarea) {
      setValue((current) => `${current}${openTag}texto${closeTag}`);
      return;
    }

    const selectionStart = textarea.selectionStart ?? value.length;
    const selectionEnd = textarea.selectionEnd ?? value.length;
    const selectedText = value.slice(selectionStart, selectionEnd);
    const wrappedText = selectedText || 'texto';
    const nextValue = `${value.slice(0, selectionStart)}${openTag}${wrappedText}${closeTag}${value.slice(selectionEnd)}`;

    setValue(nextValue);

    requestAnimationFrame(() => {
      textarea.focus();
      const innerStart = selectionStart + openTag.length;
      const innerEnd = innerStart + wrappedText.length;
      textarea.setSelectionRange(innerStart, innerEnd);
    });
  };

  const insertPublicReservationExitPromptToken = (field: 'primary' | 'secondary', token: '{empresa}') => {
    const textarea = field === 'primary'
      ? publicReservationExitPromptPrimaryTextRef.current
      : publicReservationExitPromptSecondaryTextRef.current;
    const value = field === 'primary'
      ? publicReservationExitPromptPrimaryText
      : publicReservationExitPromptSecondaryText;
    const setValue = field === 'primary'
      ? setPublicReservationExitPromptPrimaryText
      : setPublicReservationExitPromptSecondaryText;

    if (!textarea) {
      setValue((current) => `${current}${token}`);
      return;
    }

    const selectionStart = textarea.selectionStart ?? value.length;
    const selectionEnd = textarea.selectionEnd ?? value.length;
    const nextValue = `${value.slice(0, selectionStart)}${token}${value.slice(selectionEnd)}`;

    setValue(nextValue);

    requestAnimationFrame(() => {
      const cursor = selectionStart + token.length;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
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
      const filePath = `company-logos/${companyId}/${slugBase || 'empresa'}-${Date.now()}.${extension}`;

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

  const handleNoticeImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
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

    if (file.size > MAX_NOTICE_IMAGE_FILE_SIZE) {
      toast.error('A imagem do aviso deve ter no máximo 2MB');
      event.target.value = '';
      return;
    }

    setUploadingNoticeImage(true);

    try {
      const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const slugBase = slugify(slug || companyName || 'empresa');
      const filePath = `company-notices/${companyId}/${slugBase || 'empresa'}-${Date.now()}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from('system-assets')
        .upload(filePath, file, { upsert: false });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from('system-assets')
        .getPublicUrl(filePath);

      setNoticeImageUrl(publicUrlData.publicUrl);
      toast.success('Imagem do aviso enviada com sucesso');
    } catch (error: any) {
      toast.error(`Erro ao enviar imagem: ${error.message}`);
    } finally {
      setUploadingNoticeImage(false);
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

  if (companyError) {
    return (
      <Card className="rounded-xl border-destructive/30">
        <CardHeader>
          <CardTitle>Erro ao carregar configurações</CardTitle>
          <CardDescription>
            {companyError instanceof Error ? companyError.message : 'Não foi possível carregar os dados desta unidade.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Configurações</h1>
          <p className="mt-1 text-sm text-muted-foreground">Configurações da unidade {companyName}</p>
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
            <p className="text-sm font-medium text-primary">Página pública customizada indisponível neste plano.</p>
            <p className="mt-1 text-sm text-primary/85">
              Logo, descrição e botão do WhatsApp ficam bloqueados. Endereço, mapa e pagamentos continuam disponíveis.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-auto w-max min-w-full justify-start rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-1 md:min-w-0">
            {SETTINGS_TABS.map((tabValue) => {
              const tab = SETTINGS_TAB_ITEMS.find((item) => item.value === tabValue);
              if (!tab) return null;
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
                  <CardTitle className="text-lg">Horário de funcionamento</CardTitle>
                  <CardDescription>Defina os horários de abertura e fechamento para cada dia.</CardDescription>
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
                          <span className="text-sm text-muted-foreground">às</span>
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

          <BlockedDatesTab companyId={companyId} />

          {false && (
            <div className="grid gap-4 xl:grid-cols-2">
            <Card className={settingsCardClassName}>
              <CardHeader className="space-y-0 pb-2">
                <div className="flex items-start gap-3">
                  <div className={settingsBadgeClassName}>
                    <Clock className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-lg">Duração de cada reserva</CardTitle>
                    <CardDescription>Intervalo entre os horários disponíveis.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Duração</Label>
                  <Select value={String(reservationDuration)} onValueChange={(value) => setReservationDuration(Number(value))}>
                    <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar duração da reserva">
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
                    <CardTitle className="text-lg">Capacidade máxima / horário</CardTitle>
                    <CardDescription>Total de pessoas por horário. 0 = sem limite.</CardDescription>
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
          )}
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
                  <CardDescription>Selecione quais formas de pagamento são aceitas.</CardDescription>
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
                  <CardTitle className="text-lg">Informações da empresa</CardTitle>
                  <CardDescription>Cadastro, identidade visual e canais da empresa.</CardDescription>
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

                <p className="text-xs text-muted-foreground">Envie PNG, JPG, WEBP ou SVG com até 2MB.</p>

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
                <Label htmlFor="company-settings-description">Descrição</Label>
                <RichTextEditor
                  id="company-settings-description"
                  value={description}
                  onChange={setDescription}
                  placeholder="Descreva seu restaurante para os clientes..."
                  disabled={publicCustomizationLocked}
                  className={settingsTextAreaClassName}
                />
                {publicCustomizationLocked && (
                  <p className="mt-1 text-xs text-muted-foreground">A descrição pública fica bloqueada quando a página pública customizada está desativada.</p>
                )}
              </div>

              <div className="grid items-start gap-4 md:grid-cols-2">
                <div className={settingsFieldGroupClassName}>
                  <Label htmlFor="company-settings-phone" className={settingsLabelClassName}><Phone className="h-4 w-4" /> Telefone</Label>
                  <Input
                    id="company-settings-phone"
                    name="phone"
                    value={phone}
                    onChange={(event) => setPhone(formatBrazilPhone(event.target.value))}
                    placeholder="(84) 3333-4444"
                    className={settingsFieldClassName}
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={15}
                  />
                </div>

                <div className={settingsFieldGroupClassName}>
                  <Label htmlFor="company-settings-instagram" className={settingsLabelClassName}><Instagram className="h-4 w-4" /> Instagram</Label>
                  <Input
                    id="company-settings-instagram"
                    name="instagram"
                    value={instagram}
                    onChange={(event) => setInstagram(event.target.value)}
                    onBlur={() => setInstagram((current) => normalizeInstagramHandle(current))}
                    placeholder="becomagicojoaopessoa"
                    className={settingsFieldClassName}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">Informe só o usuário. O link do Instagram é montado automaticamente.</p>
                </div>

                <div className={settingsFieldGroupClassName}>
                  <Label htmlFor="company-settings-whatsapp" className={settingsLabelClassName}><MessageCircle className="h-4 w-4" /> WhatsApp</Label>
                  <Input
                    id="company-settings-whatsapp"
                    name="whatsapp"
                    value={whatsapp}
                    onChange={(event) => setWhatsapp(formatBrazilPhone(event.target.value))}
                    placeholder="(84) 99999-9999"
                    disabled={publicCustomizationLocked}
                    className={settingsFieldClassName}
                    autoComplete="tel"
                    inputMode="tel"
                    maxLength={15}
                  />
                  {publicCustomizationLocked && (
                    <p className="text-xs text-muted-foreground">O WhatsApp público fica bloqueado enquanto a feature estiver desativada.</p>
                  )}
                </div>

                {false && (
                  <div className={settingsFieldGroupClassName}>
                    <Label className={settingsLabelClassName}><MessageCircle className="h-4 w-4" /> Botão do WhatsApp</Label>
                    <Select value={showPublicWhatsappButton} onValueChange={setShowPublicWhatsappButton} disabled={publicCustomizationLocked}>
                      <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar exibição do botão de WhatsApp">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="show">Mostrar botão</SelectItem>
                        <SelectItem value="hide">Ocultar botão</SelectItem>
                      </SelectContent>
                    </Select>
                    {publicCustomizationLocked && (
                      <p className="text-xs text-muted-foreground">O botão de WhatsApp fica bloqueado enquanto a feature estiver desativada.</p>
                    )}
                    {!publicCustomizationLocked && (
                      <p className="text-xs text-muted-foreground">Controla se o botão aparece na página pública.</p>
                    )}
                  </div>
                )}
              </div>

              {false && (
                <div className="border-t border-[rgba(0,0,0,0.08)] pt-4">
                  <div className="space-y-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/20 p-4">
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <Label className="flex items-center gap-1.5 text-base font-semibold">
                          <Users className="h-4 w-4" />
                          Entrada pública na fila de espera
                        </Label>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Este link não aparece na página pública. Só entra quem receber a URL direta.
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
                        Quando desabilitado, quem acessar este link verá uma mensagem orientando a se dirigir à unidade para entrar na fila de espera.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {false && (
                <div className="border-t border-[rgba(0,0,0,0.08)] pt-4">
                  <div className="space-y-5 rounded-xl border border-amber-200/70 bg-amber-50/50 p-4">
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <Label className="flex items-center gap-1.5 text-base font-semibold">
                          <Megaphone className="h-4 w-4 text-primary" />
                          Aviso na página pública
                        </Label>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Abre um modal central para visitantes enquanto estiver ativo. Apenas um aviso fica disponível por empresa.
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-sm">
                        <span className="text-sm font-medium text-muted-foreground">Ativar agora</span>
                        <Switch
                          checked={noticeActive}
                          onCheckedChange={setNoticeActive}
                          disabled={publicCustomizationLocked}
                          aria-label="Ativar aviso público"
                        />
                      </div>
                    </div>

                    <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
                      <div className="space-y-2">
                        <Label htmlFor="company-settings-notice-text">Texto do aviso</Label>
                        <Textarea
                          id="company-settings-notice-text"
                          value={noticeText}
                          onChange={(event) => setNoticeText(event.target.value)}
                          placeholder="Ex.: Hoje teremos menu especial. Reserve sua mesa com antecedência."
                          rows={5}
                          disabled={publicCustomizationLocked}
                          className={cn(settingsTextAreaClassName, 'min-h-[128px] resize-y bg-white')}
                        />
                        <p className="text-xs text-muted-foreground">
                          O aviso pode ter apenas texto, apenas imagem, ou os dois.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="company-settings-notice-active-until">Ativo até</Label>
                        <Input
                          id="company-settings-notice-active-until"
                          type="datetime-local"
                          value={noticeActiveUntil}
                          onChange={(event) => setNoticeActiveUntil(event.target.value)}
                          disabled={publicCustomizationLocked}
                          min={toDateTimeLocalValue(new Date().toISOString())}
                          className={settingsFieldClassName}
                        />
                        <p className="text-xs text-muted-foreground">
                          Depois desse horário o modal para de aparecer automaticamente.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <Label>Imagem do aviso</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleNoticeImageUpload}
                            disabled={publicCustomizationLocked || uploadingNoticeImage}
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={publicCustomizationLocked || uploadingNoticeImage}
                            className="pointer-events-none gap-2 bg-white"
                          >
                            {uploadingNoticeImage ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                            {uploadingNoticeImage ? 'Enviando...' : 'Enviar imagem'}
                          </Button>
                        </div>

                        {noticeImageUrl && (
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={publicCustomizationLocked || uploadingNoticeImage}
                            onClick={() => setNoticeImageUrl('')}
                            className="gap-2 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                            Remover
                          </Button>
                        )}
                      </div>

                      <div className="flex min-h-36 max-w-md items-center justify-center overflow-hidden rounded-xl border border-dashed border-[rgba(0,0,0,0.14)] bg-white p-3">
                        {noticeImageUrl ? (
                          <img
                            src={noticeImageUrl}
                            alt="Prévia do aviso público"
                            className="max-h-48 w-full rounded-lg object-contain"
                          />
                        ) : (
                          <p className="text-center text-xs text-muted-foreground">Nenhuma imagem enviada para o aviso.</p>
                        )}
                      </div>

                      {publicCustomizationLocked && (
                        <p className="text-xs text-muted-foreground">
                          Avisos da página pública ficam bloqueados quando a página pública customizada está desativada.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="public-page" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Card className={settingsCardClassName}>
              <CardHeader className="space-y-0 pb-2">
                <div className="flex items-start gap-3">
                  <div className={settingsBadgeClassName}>
                    <Clock className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <CardTitle className="text-lg">Duração de cada reserva</CardTitle>
                    <CardDescription>Intervalo entre os horários disponíveis.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">Duração</Label>
                  <Select value={String(reservationDuration)} onValueChange={(value) => setReservationDuration(Number(value))}>
                    <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar duração da reserva">
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
                    <CardTitle className="text-lg">Capacidade máxima / horário</CardTitle>
                    <CardDescription>Total de pessoas por horário. 0 = sem limite.</CardDescription>
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

          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Megaphone className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Botões e acessos</CardTitle>
                  <CardDescription>Controle os elementos de ação e os fluxos públicos da unidade.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Botão do WhatsApp</Label>
                  <p className="text-sm text-muted-foreground">Controla se o botão aparece na página pública.</p>
                  {publicCustomizationLocked && (
                    <p className="text-xs text-muted-foreground">O botão de WhatsApp fica bloqueado enquanto a feature estiver desativada.</p>
                  )}
                </div>
                <Switch
                  checked={showPublicWhatsappButton === 'show'}
                  onCheckedChange={(checked) => setShowPublicWhatsappButton(checked ? 'show' : 'hide')}
                  disabled={publicCustomizationLocked}
                  aria-label="Ativar botão do WhatsApp na página pública"
                />
              </div>

              <div className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Botão sticky "Reservar agora"</Label>
                  <p className="text-sm text-muted-foreground">Aparece fixo no rodapé da versão mobile da página pública.</p>
                </div>
                <Switch
                  checked={showPublicStickyReserveButton}
                  onCheckedChange={setShowPublicStickyReserveButton}
                  aria-label="Ativar botão sticky reservar agora"
                />
              </div>

              <div className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Confirmação ao sair da reserva</Label>
                  <p className="text-sm text-muted-foreground">
                    Se a pessoa já tiver escolhido data e horário, mostramos uma tela de recuperação antes de fechar o modal.
                  </p>
                  <p className="text-xs text-muted-foreground">Não aparece se a pessoa ainda não tiver selecionado o horário.</p>
                </div>
                <Switch
                  checked={showPublicReservationExitPrompt}
                  onCheckedChange={setShowPublicReservationExitPrompt}
                  aria-label="Ativar confirmação ao sair do modal de reserva"
                />
              </div>

              <div className="space-y-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/20 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <Label className="flex items-center gap-1.5 text-base font-semibold">
                      <Users className="h-4 w-4" />
                      Entrada pública na fila de espera
                    </Label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Este link não aparece na página pública. Só entra quem receber a URL direta.
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
                    Quando desabilitado, quem acessar este link verá uma mensagem orientando a se dirigir à unidade para entrar na fila de espera.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Info className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Texto do modal de recuperação</CardTitle>
                  <CardDescription>
                    Personalize os dois blocos de texto do modal que aparece ao tentar sair da reserva depois de escolher data e horário.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(18rem,0.92fr)]">
                <div className="space-y-5">
                  <div className="space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Label htmlFor="public-reservation-exit-primary-text" className="text-base font-semibold">
                        Texto de apoio
                      </Label>
                      <Select
                        value={publicReservationExitPromptPrimaryTextSize}
                        onValueChange={(value) => setPublicReservationExitPromptPrimaryTextSize(normalizePublicReservationExitPromptTextSize(value))}
                      >
                        <SelectTrigger className="h-9 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none sm:w-40" aria-label="Selecionar tamanho do texto de apoio">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PUBLIC_RESERVATION_EXIT_PROMPT_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold"
                        onClick={() => insertPublicReservationExitPromptToken('primary', '{empresa}')}
                      >
                        Empresa
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold"
                        onClick={() => wrapPublicReservationExitPromptSelection('primary', 'b')}
                      >
                        B
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold underline decoration-foreground/45 underline-offset-2"
                        onClick={() => wrapPublicReservationExitPromptSelection('primary', 'u')}
                      >
                        U
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold underline decoration-foreground/45 underline-offset-2"
                        onClick={() => wrapPublicReservationExitPromptSelection('primary', 'bu')}
                      >
                        B+U
                      </Button>
                    </div>

                    <Textarea
                      id="public-reservation-exit-primary-text"
                      ref={publicReservationExitPromptPrimaryTextRef}
                      value={publicReservationExitPromptPrimaryText}
                      onChange={(event) => setPublicReservationExitPromptPrimaryText(event.target.value)}
                      rows={4}
                      className={settingsTextAreaClassName}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Label htmlFor="public-reservation-exit-secondary-text" className="text-base font-semibold">
                        Texto de fechamento
                      </Label>
                      <Select
                        value={publicReservationExitPromptSecondaryTextSize}
                        onValueChange={(value) => setPublicReservationExitPromptSecondaryTextSize(normalizePublicReservationExitPromptTextSize(value, DEFAULT_PUBLIC_RESERVATION_EXIT_PROMPT_SECONDARY_TEXT_SIZE))}
                      >
                        <SelectTrigger className="h-9 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none sm:w-40" aria-label="Selecionar tamanho do texto de fechamento">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PUBLIC_RESERVATION_EXIT_PROMPT_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold"
                        onClick={() => insertPublicReservationExitPromptToken('secondary', '{empresa}')}
                      >
                        Empresa
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold"
                        onClick={() => wrapPublicReservationExitPromptSelection('secondary', 'b')}
                      >
                        B
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold underline decoration-foreground/45 underline-offset-2"
                        onClick={() => wrapPublicReservationExitPromptSelection('secondary', 'u')}
                      >
                        U
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-3 text-xs font-semibold underline decoration-foreground/45 underline-offset-2"
                        onClick={() => wrapPublicReservationExitPromptSelection('secondary', 'bu')}
                      >
                        B+U
                      </Button>
                    </div>

                    <Textarea
                      id="public-reservation-exit-secondary-text"
                      ref={publicReservationExitPromptSecondaryTextRef}
                      value={publicReservationExitPromptSecondaryText}
                      onChange={(event) => setPublicReservationExitPromptSecondaryText(event.target.value)}
                      rows={3}
                      className={settingsTextAreaClassName}
                    />
                  </div>

                  <div className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/20 px-4 py-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {PUBLIC_RESERVATION_EXIT_PROMPT_TEXT_HELPER}
                    </p>
                  </div>
                </div>

                <div className="rounded-[1.55rem] border border-primary/25 bg-[linear-gradient(180deg,#fffdfa_0%,#fff8f0_100%)] p-4 shadow-[0_18px_36px_rgba(86,52,20,0.08)]">
                  <div className="space-y-5 rounded-[1.2rem] border border-primary/18 bg-white/92 px-5 py-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                    <div className="space-y-4">
                      <h3 className="font-serif text-[clamp(1.22rem,4vw,1.72rem)] font-semibold leading-[1.02] tracking-[-0.03em] text-foreground">
                        <span className="block whitespace-nowrap">Tem certeza que quer</span>
                        <span className="mt-1 block text-primary">parar por aqui?</span>
                      </h3>

                      <div className="space-y-3">
                        {previewReservationExitPromptPrimaryText.trim() && (
                          <p className={getPublicReservationExitPromptTextClassName('primary', previewReservationExitPromptPrimaryTextSize)}>
                            {renderPublicReservationExitPromptText(previewReservationExitPromptPrimaryText, previewCompanyName, 'foreground')}
                          </p>
                        )}

                        {previewReservationExitPromptSecondaryText.trim() && (
                          <p className={getPublicReservationExitPromptTextClassName('secondary', previewReservationExitPromptSecondaryTextSize)}>
                            {renderPublicReservationExitPromptText(previewReservationExitPromptSecondaryText, previewCompanyName)}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <div className="flex h-[3.15rem] items-center justify-center rounded-xl bg-primary px-4 text-base font-semibold text-primary-foreground shadow-[0_16px_28px_rgba(201,129,58,0.22)]">
                        Quero garantir minha vaga
                      </div>
                      <p className="text-sm font-medium text-foreground/60 underline decoration-foreground/35 underline-offset-4">
                        Sair mesmo assim
                      </p>
                    </div>

                    <div className="rounded-xl border border-dashed border-primary/18 bg-primary/5 px-3 py-2">
                      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-primary/80">
                        Prévia
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Megaphone className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Aviso na página pública</CardTitle>
                  <CardDescription>Exibe um modal temporário para visitantes enquanto o aviso estiver ativo.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div className="space-y-5 rounded-xl border border-amber-200/70 bg-amber-50/50 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <Label className="flex items-center gap-1.5 text-base font-semibold">
                      <Megaphone className="h-4 w-4 text-primary" />
                      Aviso ativo
                    </Label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Apenas um aviso fica disponível por empresa e ele some automaticamente ao expirar.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-sm">
                    <span className="text-sm font-medium text-muted-foreground">Ativar agora</span>
                    <Switch
                      checked={noticeActive}
                      onCheckedChange={setNoticeActive}
                      disabled={publicCustomizationLocked}
                      aria-label="Ativar aviso público"
                    />
                  </div>
                </div>

                <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
                  <div className="space-y-2">
                    <Label htmlFor="company-settings-notice-text">Texto do aviso</Label>
                    <Textarea
                      id="company-settings-notice-text"
                      value={noticeText}
                      onChange={(event) => setNoticeText(event.target.value)}
                      placeholder="Ex.: Hoje teremos menu especial. Reserve sua mesa com antecedência."
                      rows={5}
                      disabled={publicCustomizationLocked}
                      className={cn(settingsTextAreaClassName, 'min-h-[128px] resize-y bg-white')}
                    />
                    <p className="text-xs text-muted-foreground">
                      O aviso pode ter apenas texto, apenas imagem, ou os dois.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="company-settings-notice-active-until">Ativo até</Label>
                    <Input
                      id="company-settings-notice-active-until"
                      type="datetime-local"
                      value={noticeActiveUntil}
                      onChange={(event) => setNoticeActiveUntil(event.target.value)}
                      disabled={publicCustomizationLocked}
                      min={toDateTimeLocalValue(new Date().toISOString())}
                      className={settingsFieldClassName}
                    />
                    <p className="text-xs text-muted-foreground">
                      Depois desse horário o modal para de aparecer automaticamente.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Imagem do aviso</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleNoticeImageUpload}
                        disabled={publicCustomizationLocked || uploadingNoticeImage}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={publicCustomizationLocked || uploadingNoticeImage}
                        className="pointer-events-none gap-2 bg-white"
                      >
                        {uploadingNoticeImage ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                        {uploadingNoticeImage ? 'Enviando...' : 'Enviar imagem'}
                      </Button>
                    </div>

                    {noticeImageUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={publicCustomizationLocked || uploadingNoticeImage}
                        onClick={() => setNoticeImageUrl('')}
                        className="gap-2 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remover
                      </Button>
                    )}
                  </div>

                  <div className="flex min-h-36 max-w-md items-center justify-center overflow-hidden rounded-xl border border-dashed border-[rgba(0,0,0,0.14)] bg-white p-3">
                    {noticeImageUrl ? (
                      <img
                        src={noticeImageUrl}
                        alt="Prévia do aviso público"
                        className="max-h-48 w-full rounded-lg object-contain"
                      />
                    ) : (
                      <p className="text-center text-xs text-muted-foreground">Nenhuma imagem enviada para o aviso.</p>
                    )}
                  </div>

                  {publicCustomizationLocked && (
                    <p className="text-xs text-muted-foreground">
                      Avisos da página pública ficam bloqueados quando a página pública customizada está desativada.
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
                  <CardTitle className="text-lg">Localização</CardTitle>
                  <CardDescription>Endereço e mapa exibidos na página pública.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 pt-2">
              <div className="space-y-2">
                <Label htmlFor="company-settings-address">Endereço completo</Label>
                <Textarea
                  id="company-settings-address"
                  name="address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Rua, número, bairro, cidade - UF"
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
                <Label>Prévia do mapa</Label>
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
                      title="Prévia do mapa"
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

      </Tabs>
    </div>
  );
}
