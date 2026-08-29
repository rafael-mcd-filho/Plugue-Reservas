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
  Video,
  Users,
  Copy,
  Banknote,
  QrCode,
  Wallet,
  CalendarCheck,
  CalendarClock,
  Globe,
  LayoutTemplate,
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
import { normalizeLargePartyThreshold, normalizeReservationLateToleranceMinutes } from '@/lib/reservation-flow';
import { validateHeroMediaFile, type HeroMediaType } from '@/lib/hero-media';
import {
  DEFAULT_COMPANY_TIME_ZONE,
  buildCompanyTimeZoneOptions,
  normalizeCompanyTimeZone,
} from '@/lib/company-time-zones';
import { ReservationScheduleRulesCard } from '@/components/company/ReservationScheduleRulesCard';

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

interface CompanyNpsConfigSettings {
  company_id: string;
  google_review_url: string | null;
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

const SETTINGS_TABS = ['info', 'location', 'hours', 'reservations', 'availability', 'payments', 'public-page'] as const;
const SETTINGS_TAB_ITEMS = [
  { value: 'info', label: 'Empresa', icon: Info },
  { value: 'location', label: 'Localização', icon: MapPin },
  { value: 'hours', label: 'Agenda', icon: Clock },
  { value: 'reservations', label: 'Reservas', icon: CalendarCheck },
  { value: 'availability', label: 'Disponibilidade', icon: CalendarClock },
  { value: 'payments', label: 'Pagamentos', icon: CreditCard },
  { value: 'public-page', label: 'Página Pública', icon: Megaphone },
] as const;
const settingsCardClassName = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const settingsFieldClassName = 'h-10 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsTextAreaClassName = 'rounded-xl border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsBadgeClassName = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const SHOW_LEGACY_RESERVATION_CAPACITY_SETTINGS = false;
const SHOW_PUBLIC_WAITLIST_DIRECT_LINK_SETTINGS = false;
const SHOW_PUBLIC_NOTICE_SETTINGS_IN_PUBLIC_TAB = false;
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

const settingsFieldGroupClassName = 'flex min-w-0 flex-col gap-2';
const settingsLabelClassName = 'flex min-h-5 items-center gap-1.5 leading-5';
const PUBLIC_HEADER_STYLE_OPTIONS = [
  {
    value: 'classic' as const,
    label: 'Clássico',
    description: 'Banner escuro com a mídia ao fundo e a logo no topo.',
  },
  {
    value: 'modern' as const,
    label: 'Moderno',
    description: 'Fundo claro com a mídia em destaque e a logo sobreposta.',
  },
];

// Miniatura do topo da pagina publica, so para o lojista comparar os dois estilos.
function PublicHeaderStylePreview({ variant }: { variant: 'classic' | 'modern' }) {
  const faixa = 'rounded-full';

  if (variant === 'modern') {
    return (
      <div className="overflow-hidden rounded-lg border border-[rgba(0,0,0,0.08)] bg-[#F0ECE5] p-2" aria-hidden="true">
        <div className="relative">
          <div className="h-14 rounded-md bg-[linear-gradient(150deg,#7A3608_0%,#3A1B06_55%,#1C1108_100%)]" />
          <div className="absolute -bottom-3 left-1/2 h-6 w-6 -translate-x-1/2 rounded-full bg-[#8B2F2F] ring-2 ring-[#F0ECE5]" />
        </div>
        <div className="mt-5 flex flex-col items-center gap-1.5">
          <span className={cn(faixa, 'h-1.5 w-20 bg-foreground/25')} />
          <span className={cn(faixa, 'h-1 w-12 bg-foreground/15')} />
          <span className="mt-1 h-3 w-full rounded bg-white" />
          <span className="mt-0.5 h-3 w-full rounded bg-primary/70" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-lg border border-[rgba(0,0,0,0.08)] p-2"
      style={{ background: 'linear-gradient(170deg, #130D06 0%, #1C1108 50%, #2E1800 100%)' }}
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-1.5 py-1">
        <span className="h-6 w-6 rounded-full bg-[#8B2F2F] ring-1 ring-white/20" />
        <span className={cn(faixa, 'h-1.5 w-10 bg-[#F5D08A]/70')} />
        <span className={cn(faixa, 'h-1.5 w-20 bg-white/70')} />
        <span className={cn(faixa, 'h-1 w-12 bg-white/25')} />
        <span className="mt-1 h-3 w-full rounded bg-white/90" />
        <span className="mt-0.5 h-3 w-full rounded bg-primary/80" />
      </div>
    </div>
  );
}

const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;
const MAX_NOTICE_IMAGE_FILE_SIZE = 2 * 1024 * 1024;
const COMPANY_SETTINGS_SELECT = 'description, logo_url, time_zone, hero_media_url, hero_media_type, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, show_public_reservation_exit_prompt, public_waitlist_enabled, google_maps_url, reservation_duration, reservation_slot_interval_minutes, max_guests_per_slot, public_header_style, large_party_whatsapp_threshold, reservation_late_tolerance_minutes, public_reservation_exit_prompt_primary_text, public_reservation_exit_prompt_primary_text_size, public_reservation_exit_prompt_secondary_text, public_reservation_exit_prompt_secondary_text_size';
const COMPANY_SETTINGS_SELECT_WITH_EXIT_PROMPT = 'description, logo_url, time_zone, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, show_public_reservation_exit_prompt, public_waitlist_enabled, google_maps_url, reservation_duration, reservation_slot_interval_minutes, max_guests_per_slot';
const COMPANY_SETTINGS_SELECT_WITH_STICKY = 'description, logo_url, time_zone, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, show_public_sticky_reserve_button, public_waitlist_enabled, google_maps_url, reservation_duration, reservation_slot_interval_minutes, max_guests_per_slot';
const COMPANY_SETTINGS_SELECT_LEGACY = 'description, logo_url, time_zone, opening_hours, payment_methods, address, phone, instagram, whatsapp, show_public_whatsapp_button, public_waitlist_enabled, google_maps_url, reservation_duration, max_guests_per_slot';

type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && SETTINGS_TABS.includes(value as SettingsTab);
}

function normalizeSettingsTab(value: string | null): SettingsTab | null {
  if (isSettingsTab(value)) return value;
  if (value === 'blocked') return 'hours';
  if (value === 'schedule-rules' || value === 'rules') return 'availability';
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

function normalizeOptionalHttpUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
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
            'hero_media_url',
            'hero_media_type',
            'public_header_style',
            'public_reservation_exit_prompt_primary_text',
            'public_reservation_exit_prompt_primary_text_size',
            'public_reservation_exit_prompt_secondary_text',
            'public_reservation_exit_prompt_secondary_text_size',
            'large_party_whatsapp_threshold',
            'reservation_late_tolerance_minutes',
            'reservation_slot_interval_minutes',
          ],
        },
        {
          select: COMPANY_SETTINGS_SELECT_WITH_EXIT_PROMPT,
          missingColumns: ['show_public_reservation_exit_prompt', 'reservation_slot_interval_minutes'],
        },
        {
          select: COMPANY_SETTINGS_SELECT_WITH_STICKY,
          missingColumns: ['show_public_sticky_reserve_button', 'reservation_slot_interval_minutes'],
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

  const { data: npsConfig } = useQuery({
    queryKey: ['company-nps-config', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_nps_configs' as any)
        .select('company_id, google_review_url')
        .eq('company_id', companyId!)
        .maybeSingle();

      if (error) {
        console.warn('NPS config not available yet:', error);
        return null;
      }

      return data as CompanyNpsConfigSettings | null;
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
  const [googleReviewUrl, setGoogleReviewUrl] = useState('');
  const [timeZone, setTimeZone] = useState(DEFAULT_COMPANY_TIME_ZONE);
  const [reservationDuration, setReservationDuration] = useState(30);
  const [reservationSlotIntervalMinutes, setReservationSlotIntervalMinutes] = useState(30);
  const [maxGuestsPerSlot, setMaxGuestsPerSlot] = useState(0);
  const [largePartyThreshold, setLargePartyThreshold] = useState(10);
  const [reservationLateToleranceMinutes, setReservationLateToleranceMinutes] = useState(10);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [heroMediaUrl, setHeroMediaUrl] = useState('');
  const [heroMediaType, setHeroMediaType] = useState<HeroMediaType | ''>('');
  const [publicHeaderStyle, setPublicHeaderStyle] = useState<'classic' | 'modern'>('classic');
  const [uploadingHeroMedia, setUploadingHeroMedia] = useState(false);
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
    setGoogleReviewUrl('');
  }, [companyId]);

  useEffect(() => {
    if (!company || initialized) return;

    setHours((company.opening_hours as OpeningHour[]) || DEFAULT_HOURS);
    setPayments((company.payment_methods as Record<string, boolean>) || DEFAULT_PAYMENTS);
    setDescription(company.description || '');
    setLogoUrl(company.logo_url || '');
    setHeroMediaUrl(company.hero_media_url || '');
    setHeroMediaType((company.hero_media_type as HeroMediaType) || '');
    setPublicHeaderStyle((company as any).public_header_style === 'modern' ? 'modern' : 'classic');
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
    setTimeZone(normalizeCompanyTimeZone((company as any).time_zone));
    setReservationDuration((company as any).reservation_duration ?? 30);
    setReservationSlotIntervalMinutes((company as any).reservation_slot_interval_minutes ?? (company as any).reservation_duration ?? 30);
    setMaxGuestsPerSlot((company as any).max_guests_per_slot ?? 0);
    setLargePartyThreshold(normalizeLargePartyThreshold((company as any).large_party_whatsapp_threshold));
    setReservationLateToleranceMinutes(normalizeReservationLateToleranceMinutes((company as any).reservation_late_tolerance_minutes));
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

  useEffect(() => {
    if (npsConfig === undefined) return;
    setGoogleReviewUrl(npsConfig?.google_review_url || '');
  }, [npsConfig]);

  const publicCustomizationLocked = featureFlags
    ? !featureFlags.features.custom_public_page
    : false;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!company) throw new Error('Empresa não encontrada');

      const normalizedMapsEmbedUrl = normalizeGoogleMapsEmbedInput(googleMapsUrl);
      const normalizedGoogleReviewUrl = normalizeOptionalHttpUrl(googleReviewUrl);

      if (googleMapsUrl.trim() && !normalizedMapsEmbedUrl) {
        throw new Error('Use um link de incorporação válido do Google Maps.');
      }

      if (googleReviewUrl.trim() && !normalizedGoogleReviewUrl) {
        throw new Error('Use um link valido para avaliacao no Google.');
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
      const normalizedLargePartyThreshold = normalizeLargePartyThreshold(largePartyThreshold);
      const normalizedReservationLateToleranceMinutes = normalizeReservationLateToleranceMinutes(reservationLateToleranceMinutes);

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
        time_zone: normalizeCompanyTimeZone(timeZone),
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
        reservation_slot_interval_minutes: reservationSlotIntervalMinutes,
        max_guests_per_slot: maxGuestsPerSlot,
        updated_at: new Date().toISOString(),
      } as any;
      const {
        reservation_slot_interval_minutes: _reservationSlotIntervalMinutes,
        ...legacyBaseCompanyUpdate
      } = baseCompanyUpdate;
      const companyUpdateWithLargePartyThreshold = {
        ...baseCompanyUpdate,
        large_party_whatsapp_threshold: normalizedLargePartyThreshold,
        reservation_late_tolerance_minutes: normalizedReservationLateToleranceMinutes,
      } as any;
      const companyUpdateWithHeroMedia = {
        ...companyUpdateWithLargePartyThreshold,
        hero_media_url: publicCustomizationLocked ? (company.hero_media_url ?? null) : (heroMediaUrl || null),
        hero_media_type: publicCustomizationLocked ? (company.hero_media_type ?? null) : (heroMediaType || null),
        public_header_style: publicCustomizationLocked
          ? ((company as any).public_header_style ?? 'classic')
          : publicHeaderStyle,
      } as any;

      const updateAttempts = [
        {
          payload: {
            ...companyUpdateWithHeroMedia,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
            show_public_reservation_exit_prompt: showPublicReservationExitPrompt,
            public_reservation_exit_prompt_primary_text: normalizedReservationExitPromptPrimaryText,
            public_reservation_exit_prompt_primary_text_size: publicReservationExitPromptPrimaryTextSize,
            public_reservation_exit_prompt_secondary_text: normalizedReservationExitPromptSecondaryText,
            public_reservation_exit_prompt_secondary_text_size: publicReservationExitPromptSecondaryTextSize,
          } as any,
          missingColumns: [
            'hero_media_url',
            'hero_media_type',
            'public_header_style',
            'public_reservation_exit_prompt_primary_text',
            'public_reservation_exit_prompt_primary_text_size',
            'public_reservation_exit_prompt_secondary_text',
            'public_reservation_exit_prompt_secondary_text_size',
            'large_party_whatsapp_threshold',
            'reservation_late_tolerance_minutes',
            'reservation_slot_interval_minutes',
          ],
        },
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
            'reservation_slot_interval_minutes',
          ],
        },
        {
          payload: {
            ...companyUpdateWithLargePartyThreshold,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
            show_public_reservation_exit_prompt: showPublicReservationExitPrompt,
          } as any,
          missingColumns: ['show_public_reservation_exit_prompt', 'large_party_whatsapp_threshold', 'reservation_late_tolerance_minutes', 'reservation_slot_interval_minutes'],
        },
        {
          payload: {
            ...companyUpdateWithLargePartyThreshold,
            show_public_sticky_reserve_button: showPublicStickyReserveButton,
          } as any,
          missingColumns: ['show_public_sticky_reserve_button', 'large_party_whatsapp_threshold', 'reservation_late_tolerance_minutes', 'reservation_slot_interval_minutes'],
        },
        {
          payload: companyUpdateWithLargePartyThreshold,
          missingColumns: ['large_party_whatsapp_threshold', 'reservation_late_tolerance_minutes', 'reservation_slot_interval_minutes'],
        },
        {
          payload: baseCompanyUpdate,
          missingColumns: ['reservation_slot_interval_minutes'],
        },
        {
          payload: legacyBaseCompanyUpdate,
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

      const { error: npsConfigError } = await supabase
        .from('company_nps_configs' as any)
        .upsert({
          company_id: companyId,
          google_review_url: normalizedGoogleReviewUrl,
          updated_at: new Date().toISOString(),
        } as any, { onConflict: 'company_id' });

      if (npsConfigError) {
        throw npsConfigError;
      }

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
      qc.invalidateQueries({ queryKey: ['company-nps-config', companyId] });
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

  const handleHeroMediaUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || publicCustomizationLocked) {
      event.target.value = '';
      return;
    }

    const validation = validateHeroMediaFile(file);
    if (!validation.valid) {
      toast.error(validation.error);
      event.target.value = '';
      return;
    }

    setUploadingHeroMedia(true);

    try {
      const extension = (file.name.split('.').pop() || (validation.type === 'video' ? 'mp4' : 'png')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const slugBase = slugify(slug || companyName || 'empresa');
      const filePath = `company-hero-media/${companyId}/${slugBase || 'empresa'}-${Date.now()}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from('system-assets')
        .upload(filePath, file, { upsert: false });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from('system-assets')
        .getPublicUrl(filePath);

      setHeroMediaUrl(publicUrlData.publicUrl);
      setHeroMediaType(validation.type);
      toast.success('Mídia de fundo enviada com sucesso');
    } catch (error: any) {
      toast.error(`Erro ao enviar mídia de fundo: ${error.message}`);
    } finally {
      setUploadingHeroMedia(false);
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

          {SHOW_LEGACY_RESERVATION_CAPACITY_SETTINGS && (
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

        <TabsContent value="reservations" className="space-y-4">
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <CalendarCheck className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Configurações de reservas</CardTitle>
                  <CardDescription>Defina como o fluxo público cria reservas e quando ele direciona o cliente para o WhatsApp.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div className="grid gap-3 md:grid-cols-2 min-[920px]:grid-cols-3">
                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-3">
                  <div className="space-y-1">
                    <Label className="text-sm font-semibold text-foreground">Duração padrão da reserva</Label>
                    <p className="text-xs leading-snug text-muted-foreground">Tempo que mesa/capacidade fica ocupada sem regra específica.</p>
                  </div>
                  <div className="mt-auto">
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
                </div>

                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-3">
                  <div className="space-y-1">
                    <Label className="text-sm font-semibold text-foreground">Intervalo da grade pública</Label>
                    <p className="text-xs leading-snug text-muted-foreground">Gera horários públicos quando não houver regra ativa.</p>
                  </div>
                  <div className="mt-auto">
                    <Select value={String(reservationSlotIntervalMinutes)} onValueChange={(value) => setReservationSlotIntervalMinutes(Number(value))}>
                      <SelectTrigger className={settingsFieldClassName} aria-label="Selecionar intervalo da grade pública">
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
                </div>

                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-3">
                  <div className="space-y-1">
                    <Label htmlFor="company-settings-max-guests" className="text-sm font-semibold text-foreground">Capacidade máxima / horário</Label>
                    <p className="text-xs leading-snug text-muted-foreground">Teto de pessoas no horário. Use 0 para sem limite.</p>
                  </div>
                  <div className="mt-auto">
                    <Input
                      id="company-settings-max-guests"
                      name="max_guests_per_slot"
                      type="number"
                      min={0}
                      value={maxGuestsPerSlot}
                      onChange={(event) => setMaxGuestsPerSlot(Math.max(0, Number(event.target.value) || 0))}
                      className={settingsFieldClassName}
                      placeholder="0"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-3">
                  <div className="space-y-1">
                    <Label htmlFor="company-settings-large-party-threshold" className="text-sm font-semibold text-foreground">Limite de pessoas por reserva</Label>
                    <p className="text-xs leading-snug text-muted-foreground">A partir deste tamanho, o cliente vai para o WhatsApp.</p>
                  </div>
                  <div className="mt-auto space-y-1.5">
                    <Input
                      id="company-settings-large-party-threshold"
                      name="large_party_whatsapp_threshold"
                      type="number"
                      min={2}
                      max={20}
                      value={largePartyThreshold}
                      onChange={(event) => setLargePartyThreshold(normalizeLargePartyThreshold(Number(event.target.value)))}
                      className={settingsFieldClassName}
                      placeholder="10"
                    />
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Ex.: 20 manda grupos de 20+ para o WhatsApp.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-3">
                  <div className="space-y-1">
                    <Label htmlFor="company-settings-late-tolerance" className="text-sm font-semibold text-foreground">Tolerância de atraso</Label>
                    <p className="text-xs leading-snug text-muted-foreground">Aviso exibido no acompanhamento. Use 0 para ocultar.</p>
                  </div>
                  <div className="mt-auto space-y-1.5">
                    <Input
                      id="company-settings-late-tolerance"
                      name="reservation_late_tolerance_minutes"
                      type="number"
                      min={0}
                      max={120}
                      value={reservationLateToleranceMinutes}
                      onChange={(event) => setReservationLateToleranceMinutes(normalizeReservationLateToleranceMinutes(Number(event.target.value)))}
                      className={settingsFieldClassName}
                      placeholder="10"
                    />
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Ex.: 10 mostra tolerância de até 10 min.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {featureFlags?.features.flow_protection !== false && <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Info className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Recuperação ao sair</CardTitle>
                  <CardDescription>Recupera a pessoa antes de fechar a reserva quando ela já escolheu data e horário.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Ativar recuperação ao sair da reserva</Label>
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

              <div className="space-y-5 rounded-xl border border-[rgba(0,0,0,0.08)] bg-[linear-gradient(180deg,rgba(252,248,243,0.9)_0%,rgba(255,255,255,0.96)_100%)] p-4">
                <div className="space-y-1">
                  <Label className="text-base font-semibold">Modal de recuperação</Label>
                  <p className="text-sm text-muted-foreground">
                    Edite os textos do modal e confira a prévia visual antes de salvar.
                  </p>
                </div>

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
              </div>
            </CardContent>
          </Card>}
        </TabsContent>

        <TabsContent value="availability" className="space-y-4">
          {companyId && <ReservationScheduleRulesCard companyId={companyId} />}
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
                  <CardTitle className="text-lg">Empresa</CardTitle>
                  <CardDescription>Cadastro, identidade visual e canais da empresa.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-8 pt-2">
              <div className="grid gap-8 md:grid-cols-2">
                <div className="flex flex-col space-y-3">
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

                  <div className="flex flex-1 min-h-28 items-center justify-center rounded-2xl border border-dashed border-[rgba(0,0,0,0.14)] bg-muted/20 p-4">
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

                <div className="space-y-4">
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
                      placeholder="pluguereservas"
                      className={settingsFieldClassName}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-xs text-muted-foreground">Informe só o usuário. O link do Instagram é montado automaticamente.</p>
                  </div>

                  <div className={settingsFieldGroupClassName}>
                    <Label htmlFor="company-settings-whatsapp" className={settingsLabelClassName}><WhatsAppIcon className="h-4 w-4" /> WhatsApp</Label>
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

                  <div className={settingsFieldGroupClassName}>
                    <Label htmlFor="company-settings-time-zone" className={settingsLabelClassName}><Globe className="h-4 w-4" /> Fuso horário</Label>
                    <Select value={timeZone} onValueChange={setTimeZone}>
                      <SelectTrigger id="company-settings-time-zone" className={settingsFieldClassName}>
                        <SelectValue placeholder="Selecione o fuso horário" />
                      </SelectTrigger>
                      <SelectContent>
                        {buildCompanyTimeZoneOptions(timeZone).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label} ({option.offsetLabel})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Define o dia usado nos relatórios. Afeta reservas próximas à meia-noite.
                    </p>
                  </div>
                </div>
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

              {SHOW_PUBLIC_WAITLIST_DIRECT_LINK_SETTINGS && (
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

              {SHOW_PUBLIC_NOTICE_SETTINGS_IN_PUBLIC_TAB && (
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
          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <ImageIcon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Mídia de fundo do banner</CardTitle>
                  <CardDescription>
                    Foto ou vídeo exibido atrás do topo da página pública. Os botões de reserva, o título e o logo continuam sempre em destaque por cima da mídia.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <input
                    type="file"
                    accept="image/*,video/mp4,video/webm"
                    onChange={handleHeroMediaUpload}
                    disabled={publicCustomizationLocked || uploadingHeroMedia}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={publicCustomizationLocked || uploadingHeroMedia}
                    className="pointer-events-none gap-2 bg-white"
                  >
                    {uploadingHeroMedia ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : heroMediaType === 'video' ? (
                      <Video className="h-4 w-4" />
                    ) : (
                      <ImageIcon className="h-4 w-4" />
                    )}
                    {uploadingHeroMedia ? 'Enviando...' : 'Enviar foto ou vídeo'}
                  </Button>
                </div>

                {heroMediaUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={publicCustomizationLocked || uploadingHeroMedia}
                    onClick={() => {
                      setHeroMediaUrl('');
                      setHeroMediaType('');
                    }}
                    className="gap-2 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remover
                  </Button>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Foto: recomendado 1920×1080px, até 5MB. Vídeo: MP4, 1920×1080px, 6 a 12 segundos em loop e sem áudio, até 15MB.
              </p>

              <div className="flex min-h-36 max-w-md items-center justify-center overflow-hidden rounded-xl border border-dashed border-[rgba(0,0,0,0.14)] bg-white p-3">
                {heroMediaUrl && heroMediaType === 'video' ? (
                  <video
                    src={heroMediaUrl}
                    className="max-h-48 w-full rounded-lg object-contain"
                    muted
                    loop
                    autoPlay
                    playsInline
                  />
                ) : heroMediaUrl ? (
                  <img
                    src={heroMediaUrl}
                    alt="Prévia da mídia de fundo do banner"
                    className="max-h-48 w-full rounded-lg object-contain"
                  />
                ) : (
                  <p className="text-center text-xs text-muted-foreground">Nenhuma mídia de fundo enviada ainda.</p>
                )}
              </div>

              {publicCustomizationLocked && (
                <p className="text-xs text-muted-foreground">
                  A mídia de fundo do banner fica bloqueada quando a página pública customizada está desativada.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <LayoutTemplate className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Estilo do topo da página</CardTitle>
                  <CardDescription>
                    Muda apenas o topo da página pública no celular. Horários, endereço, formas de pagamento e o botão do
                    WhatsApp continuam iguais nos dois estilos, e no computador o topo é sempre o mesmo.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-2">
              <div className="grid gap-3 md:grid-cols-2">
                {PUBLIC_HEADER_STYLE_OPTIONS.map((option) => {
                  const selected = publicHeaderStyle === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={publicCustomizationLocked}
                      aria-pressed={selected}
                      onClick={() => setPublicHeaderStyle(option.value)}
                      className={cn(
                        'flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                        selected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-[rgba(0,0,0,0.08)] bg-muted/15 hover:bg-muted/30',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-base font-semibold text-foreground">{option.label}</p>
                          <p className="text-sm text-muted-foreground">{option.description}</p>
                        </div>
                        <span
                          className={cn(
                            'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                            selected ? 'border-primary' : 'border-muted-foreground/40',
                          )}
                        >
                          {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                      </div>
                      <PublicHeaderStylePreview variant={option.value} />
                    </button>
                  );
                })}
              </div>

              {publicCustomizationLocked && (
                <p className="text-xs text-muted-foreground">
                  O estilo do topo fica bloqueado quando a página pública customizada está desativada.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <MessageCircle className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Ações e acessos do usuário</CardTitle>
                  <CardDescription>Controles dos botões públicos e do acesso direto à fila de espera.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <Label className="text-base font-semibold">Botão do WhatsApp</Label>
                    <p className="text-sm text-muted-foreground">Controla se o botão flutuante aparece na página pública.</p>
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

          {featureFlags?.features.active_communication !== false && <Card className={settingsCardClassName}>
            <CardHeader className="space-y-0 pb-2">
              <div className="flex items-start gap-3">
                <div className={settingsBadgeClassName}>
                  <Megaphone className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-lg">Aviso na página pública</CardTitle>
                  <CardDescription>Aviso temporário exibido como modal para visitantes enquanto estiver ativo.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <div className="space-y-5 rounded-xl border border-amber-200/70 bg-amber-50/50 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <Label className="flex items-center gap-1.5 text-base font-semibold">
                      <Megaphone className="h-4 w-4 text-primary" />
                      Aviso na página pública
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

                <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_16rem]">
                  <div className="space-y-2">
                    <Label htmlFor="company-settings-notice-text">Texto</Label>
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
                    <Label htmlFor="company-settings-notice-active-until">Data de expiração</Label>
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
                  <Label>Imagem</Label>
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
          </Card>}
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
                  placeholder={'Rua Exemplo, 123\nBairro, Cidade - UF, 00000-000'}
                  rows={3}
                  className={settingsTextAreaClassName}
                  autoComplete="street-address"
                />
                <p className="text-xs text-muted-foreground">
                  A primeira linha aparece em destaque na página pública. Use uma quebra de linha para separar o restante (bairro, cidade, CEP).
                </p>
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
                <Label htmlFor="company-settings-google-review">Link de avaliacao no Google</Label>
                <Input
                  id="company-settings-google-review"
                  name="google_review_url"
                  type="url"
                  value={googleReviewUrl}
                  onChange={(event) => setGoogleReviewUrl(event.target.value)}
                  placeholder="https://g.page/r/.../review"
                  className={settingsFieldClassName}
                  autoComplete="url"
                  inputMode="url"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  Usado na pesquisa de satisfacao para convidar clientes com nota 9 ou 10 a avaliar a empresa no Google.
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
