import { Suspense, useEffect, useMemo, useState, type CSSProperties, type SVGProps } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Banknote,
  CalendarCheck,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  MapPin,
  Phone,
  QrCode,
  Star,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import PublicPageSkeleton from '@/components/PublicPageSkeleton';
import instagramLogoUrl from '@/assets/brands/instagram-logo.svg';
import whatsappGlyphUrl from '@/assets/brands/whatsapp-glyph.svg';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RichTextContent } from '@/components/ui/rich-text-editor';
import { useFunnelTracking } from '@/hooks/useFunnelTracking';
import type { Company } from '@/hooks/useCompanies';
import { supabase } from '@/integrations/supabase/client';
import {
  buildInstagramProfileUrl,
  formatInstagramHandleLabel,
  formatBrazilPhone,
  isValidCompanySlug,
  normalizeBrazilPhoneDigits,
  toBrazilWhatsAppNumber,
} from '@/lib/validation';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import { removePublicCompanyIcons, syncPublicCompanyIcons } from '@/lib/publicCompanyIcons';
import { richTextHasContent, richTextToPlainText } from '@/lib/richText';
import { cn } from '@/lib/utils';
import { lazyWithReload, preloadLazyImport } from '@/lib/lazyReload';
import { findOpeningHoursForDayIndex, getDayIndexFromName } from '@/lib/openingHours';
import { getPrefetchedPublicCompany } from '@/publicCompanyBootstrap';

const loadReservationModal = () => import('@/components/ReservationModal');
const preloadReservationModal = () => preloadLazyImport(loadReservationModal, 'reservation-modal');
const ReservationModal = lazyWithReload(loadReservationModal, 'reservation-modal');
const FunnelDebugPanel = lazyWithReload(() => import('@/components/FunnelDebugPanel'), 'funnel-debug-panel');
const DEFAULT_SEO_DESCRIPTION = 'Plataforma de reservas para restaurantes com página pública, painel por unidade e automações via WhatsApp.';
const PUBLIC_RESERVATION_JSON_LD_ID = 'public-reservation-json-ld';
// A avaliacao exibida no cabecalho moderno continua decorativa, como antes.
const PUBLIC_RATING_LABEL = '5,0';
const PUBLIC_WHATSAPP_MESSAGE = 'Ol\u00E1, vim pela p\u00E1gina de reservas e gostaria de ajuda.';

interface OpeningHour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

interface BlockedDate {
  date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
}

interface PublicNotice {
  id: string;
  text: string | null;
  image_url: string | null;
  active_until: string | null;
}

function WhatsAppIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.25a9.75 9.75 0 0 0-8.35 14.78L2.3 21.7l4.84-1.27A9.75 9.75 0 1 0 12 2.25Z"
      />
      <path
        fill="white"
        d="M9.25 6.65c-.23 0-.45.11-.63.31-.31.33-.82.83-.82 1.94s.81 2.18.92 2.33c.11.14 1.58 2.52 3.83 3.44 1.87.75 2.25.6 2.66.56.41-.04 1.32-.54 1.51-1.06.19-.53.19-.97.13-1.06-.05-.09-.19-.15-.39-.25-.2-.1-1.16-.57-1.34-.64-.18-.06-.31-.09-.45.12-.13.2-.52.63-.63.77-.12.13-.24.15-.43.05-.2-.1-.84-.31-1.6-1-.59-.53-.99-1.19-1.12-1.39-.12-.2-.02-.3.09-.4.09-.09.2-.23.3-.34.1-.11.13-.2.2-.32.07-.13.03-.25-.01-.34-.05-.1-.44-1.12-.61-1.53-.16-.39-.33-.4-.45-.4h-.38Z"
      />
    </svg>
  );
}

// O arquivo externo evita ids de gradiente duplicados quando os layouts mobile
// e desktop coexistem no DOM e tambem deixa a origem da marca rastreavel.
function InstagramLogo({ className }: { className?: string }) {
  return <img src={instagramLogoUrl} alt="" aria-hidden="true" className={className} />;
}

function HeroOrnamentDivider({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3', className)} aria-hidden="true">
      <span className="h-px w-14 bg-gradient-to-r from-transparent via-[#C98A3A]/70 to-[#F2D2A1]/25" />
      <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] border border-[#E3B36A]/70 bg-[radial-gradient(circle_at_30%_30%,rgba(255,224,173,0.65),rgba(96,49,11,0.9))] shadow-[0_0_14px_rgba(201,138,58,0.2)]" />
      <span className="h-px w-14 bg-gradient-to-l from-transparent via-[#C98A3A]/70 to-[#F2D2A1]/25" />
    </div>
  );
}

function RefinedRatingStarsLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Avaliações no Google"
      className={cn(
        'group inline-flex items-center rounded-full border border-[#A46A1D]/45 bg-[linear-gradient(180deg,rgba(66,34,9,0.88)_0%,rgba(29,15,4,0.94)_100%)] px-3 py-1.5 shadow-[0_10px_26px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,236,201,0.18)] ring-1 ring-black/18 backdrop-blur-md transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-[#D69A42]/55 hover:shadow-[0_14px_34px_rgba(0,0,0,0.42),0_0_24px_rgba(214,154,66,0.16)]',
        className,
      )}
    >
      <span className="flex items-center gap-0.5 text-[#F5D08A]">
        {Array.from({ length: 5 }).map((_, index) => (
          <span
            key={index}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,229,163,0.34),rgba(168,102,26,0.08)_70%)]"
          >
            <Star className="h-3 w-3 fill-current text-current drop-shadow-[0_1px_4px_rgba(255,208,138,0.45)]" />
          </span>
        ))}
      </span>
    </a>
  );
}

function HeroMedia({
  url,
  type,
  className,
}: {
  url: string;
  type: 'image' | 'video';
  className: string;
}) {
  if (type === 'video') {
    return (
      <video
        key={url}
        src={url}
        className={className}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        tabIndex={-1}
      />
    );
  }

  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      width={1600}
      height={900}
      loading="eager"
      decoding="async"
      fetchPriority="high"
      className={className}
    />
  );
}

const PAYMENT_LABELS: Record<string, { label: string; icon: typeof CreditCard }> = {
  dinheiro: { label: 'Dinheiro', icon: Banknote },
  credito: { label: 'Cr\u00E9dito', icon: CreditCard },
  debito: { label: 'D\u00E9bito', icon: CreditCard },
  pix: { label: 'Pix', icon: QrCode },
  vale_refeicao: { label: 'Vale Refeiç\u00E3o', icon: Wallet },
};

const DAY_MAP: Record<string, number> = {
  Dom: 0,
  Seg: 1,
  Ter: 2,
  Qua: 3,
  Qui: 4,
  Sex: 5,
  'S\u00E1b': 6,
};

const DAY_NAMES_BY_INDEX = Object.entries(DAY_MAP).reduce<Record<number, string>>((acc, [day, index]) => {
  acc[index] = day;
  return acc;
}, {});

const FULL_DAY_NAME_BY_ABBR: Record<string, string> = {
  Seg: 'Segunda',
  Ter: 'Terça',
  Qua: 'Quarta',
  Qui: 'Quinta',
  Sex: 'Sexta',
  'Sáb': 'Sábado',
  Dom: 'Domingo',
};

interface OpeningHourGroup {
  label: string;
  closed: boolean;
  open: string;
  close: string;
  isToday: boolean;
}

interface OpeningSlot {
  day: string;
  open: string;
  close: string;
  start: Date;
  end: Date;
}

interface OpeningStatus {
  title: string;
  description: string | null;
  variant: 'open' | 'closed';
}

function parseTimeToMinutes(time?: string | null) {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isSameCalendarDate(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function getOpeningHourByDayIndex(hours: OpeningHour[], dayIndex: number) {
  return findOpeningHoursForDayIndex(hours, dayIndex);
}

function buildOpeningSlots(hours: OpeningHour[], now: Date) {
  const slots: OpeningSlot[] = [];
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  for (let offset = -1; offset <= 8; offset += 1) {
    const dayStart = new Date(todayStart);
    dayStart.setDate(todayStart.getDate() + offset);

    const hour = getOpeningHourByDayIndex(hours, dayStart.getDay());
    if (!hour || hour.closed) continue;

    const openMinutes = parseTimeToMinutes(hour.open);
    const closeMinutes = parseTimeToMinutes(hour.close);
    if (openMinutes === null || closeMinutes === null) continue;

    const closeOffset = closeMinutes <= openMinutes ? 24 * 60 : 0;
    const start = new Date(dayStart.getTime() + openMinutes * 60_000);
    const end = new Date(dayStart.getTime() + (closeMinutes + closeOffset) * 60_000);

    slots.push({
      day: hour.day,
      open: hour.open,
      close: hour.close,
      start,
      end,
    });
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function describeOpeningDay(slot: OpeningSlot, now: Date) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameCalendarDate(slot.start, tomorrow)) return 'Abre amanhã';
  return `Abre ${format(slot.start, "EEEE, dd/MM", { locale: ptBR })}`;
}

function hasUniformOpenHours(hours: OpeningHour[]) {
  const openDays = hours.filter((hour) => !hour.closed);
  if (openDays.length === 0) return false;

  const [first, ...rest] = openDays;
  return rest.every((hour) => hour.open === first.open && hour.close === first.close);
}

function getOpeningStatus(hours: OpeningHour[], now: Date): OpeningStatus | null {
  if (hours.length === 0) return null;

  const uniformSuffix = hasUniformOpenHours(hours) ? ' · todos os dias' : '';
  const slots = buildOpeningSlots(hours, now);
  const currentSlot = slots.find((slot) => now >= slot.start && now < slot.end);

  if (currentSlot) {
    return {
      title: 'Aberto agora',
      description: `Fecha às ${currentSlot.close}${uniformSuffix}`,
      variant: 'open',
    };
  }

  const upcomingTodaySlot = slots.find((slot) => slot.start > now && isSameCalendarDate(slot.start, now));
  if (upcomingTodaySlot) {
    return {
      title: 'Abre hoje',
      description: `Abre às ${upcomingTodaySlot.open}${uniformSuffix}`,
      variant: 'closed',
    };
  }

  const nextSlot = slots.find((slot) => slot.start > now);
  if (!nextSlot) {
    return {
      title: 'Fechado hoje',
      description: null,
      variant: 'closed',
    };
  }

  return {
    title: describeOpeningDay(nextSlot, now),
    description: null,
    variant: 'closed',
  };
}

function buildOpeningHourGroups(hours: OpeningHour[], now: Date): OpeningHourGroup[] {
  const todayIndex = now.getDay();
  const groups: { startDay: string; endDay: string; closed: boolean; open: string; close: string; isToday: boolean }[] = [];

  for (const hour of hours) {
    const isToday = getDayIndexFromName(hour.day) === todayIndex;
    const last = groups[groups.length - 1];
    const sameAsLast = last
      && !isToday
      && !last.isToday
      && last.closed === hour.closed
      && last.open === hour.open
      && last.close === hour.close;

    if (sameAsLast) {
      last.endDay = hour.day;
    } else {
      groups.push({
        startDay: hour.day,
        endDay: hour.day,
        closed: hour.closed,
        open: hour.open,
        close: hour.close,
        isToday,
      });
    }
  }

  return groups.map((group) => {
    if (group.isToday) {
      return {
        label: `${FULL_DAY_NAME_BY_ABBR[group.startDay] || group.startDay} · hoje`,
        closed: group.closed,
        open: group.open,
        close: group.close,
        isToday: true,
      };
    }

    return {
      label: group.startDay === group.endDay ? group.startDay : `${group.startDay} a ${group.endDay}`,
      closed: group.closed,
      open: group.open,
      close: group.close,
      isToday: false,
    };
  });
}

function flattenAddress(address: string | null | undefined) {
  if (!address) return '';

  return address
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

function getGoogleMapsOpenUrl(company: Company | null) {
  if (!company) return null;

  if (company.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(flattenAddress(company.address))}`;
  }

  if (company.google_maps_url && !company.google_maps_url.includes('/embed')) {
    return company.google_maps_url;
  }

  if (company.name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(company.name)}`;
  }

  return null;
}

function truncateSeoText(value: string, maxLength = 155) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const trimmed = normalized.slice(0, maxLength - 1);
  const lastSpace = trimmed.lastIndexOf(' ');
  return `${trimmed.slice(0, lastSpace > 80 ? lastSpace : trimmed.length).trim()}...`;
}

function upsertMeta(attribute: 'name' | 'property', key: string, content: string) {
  if (typeof document === 'undefined') return;

  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }

  element.content = content;
}

function removeMeta(attribute: 'name' | 'property', key: string) {
  if (typeof document === 'undefined') return;
  document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`)?.remove();
}

function upsertCanonical(url: string) {
  if (typeof document === 'undefined') return;

  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.appendChild(element);
  }

  element.href = url;
}

function removeCanonical() {
  if (typeof document === 'undefined') return;
  document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.remove();
}

function upsertJsonLd(data: Record<string, unknown>) {
  if (typeof document === 'undefined') return;

  let element = document.getElementById(PUBLIC_RESERVATION_JSON_LD_ID) as HTMLScriptElement | null;
  if (!element) {
    element = document.createElement('script');
    element.id = PUBLIC_RESERVATION_JSON_LD_ID;
    element.type = 'application/ld+json';
    document.head.appendChild(element);
  }

  element.text = JSON.stringify(data);
}

function removeJsonLd() {
  if (typeof document === 'undefined') return;
  document.getElementById(PUBLIC_RESERVATION_JSON_LD_ID)?.remove();
}

function getSchemaDayName(day: string) {
  const map: Record<string, string> = {
    Dom: 'Sunday',
    Seg: 'Monday',
    Ter: 'Tuesday',
    Qua: 'Wednesday',
    Qui: 'Thursday',
    Sex: 'Friday',
    'S\u00E1b': 'Saturday',
  };

  return map[day] ?? null;
}

function compactJsonLd<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (Array.isArray(entry)) return entry.length > 0;
      return entry !== null && entry !== undefined && entry !== '';
    }),
  );
}

function toAbsoluteUrl(url: string | null | undefined) {
  if (!url || typeof window === 'undefined') return null;

  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return null;
  }
}

function buildPublicWhatsappUrl(phone: string | null | undefined) {
  const whatsappNumber = toBrazilWhatsAppNumber(phone);
  if (!whatsappNumber) return null;

  return `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(PUBLIC_WHATSAPP_MESSAGE)}`;
}

export default function CompanyPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const slugIsValid = isValidCompanySlug(slug);
  const [showReservation, setShowReservation] = useState(false);
  const [statusNow, setStatusNow] = useState(() => new Date());
  const [dismissedNoticeId, setDismissedNoticeId] = useState<string | null>(null);
  const [isHoursExpanded, setIsHoursExpanded] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 768,
  );

  const { data: company, isLoading, error } = useQuery({
    queryKey: ['company-public', slug],
    queryFn: async () => {
      const prefetchedCompany = getPrefetchedPublicCompany(slug!);
      if (prefetchedCompany) {
        try {
          return await prefetchedCompany as Company | null;
        } catch {
          // A falha do atalho nao deve impedir o fallback oficial do cliente.
        }
      }

      const rpcResult = await (supabase as any).rpc('get_public_company_by_slug', { _slug: slug! });

      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as Company[];
        return rows.length > 0 ? rows[0] : null;
      }

      const { data, error } = await supabase
        .from('companies_public' as any)
        .select('*')
        .eq('slug', slug!)
        .maybeSingle();

      if (error) throw error;
      return data as unknown as Company | null;
    },
    enabled: slugIsValid,
  });

  const { data: companyStatus } = useQuery({
    queryKey: ['company-status', slug],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_company_status_by_slug', { _slug: slug! });
      if (error) throw error;

      const rows = data as any[];
      return rows && rows.length > 0 ? rows[0] : null;
    },
    enabled: slugIsValid && !company && !isLoading,
  });

  const { trackStep, startJourney, getTrackingSnapshot, clearJourney } = useFunnelTracking(company?.id, slug);

  const handleOpenReservation = () => {
    void startJourney();
    setShowReservation(true);
  };

  useEffect(() => {
    if (company?.id) trackStep('page_view');
  }, [company?.id, trackStep]);

  useEffect(() => {
    if (!company?.id) return;

    let timer: number | undefined;
    const schedulePreload = () => {
      timer = window.setTimeout(() => void preloadReservationModal(), 600);
    };

    if (document.readyState === 'complete') {
      schedulePreload();
    } else {
      window.addEventListener('load', schedulePreload, { once: true });
    }

    return () => {
      window.removeEventListener('load', schedulePreload);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [company?.id]);

  const { data: blockedDates = [] } = useQuery({
    queryKey: ['blocked-dates-public-page', company?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('blocked_dates' as any)
        .select('date, all_day, start_time, end_time')
        .eq('company_id', company!.id)
        .gte('date', format(new Date(), 'yyyy-MM-dd'));

      if (error) throw error;
      return (data ?? []) as BlockedDate[];
    },
    enabled: !!company?.id,
  });

  const { data: publicNotice } = useQuery({
    queryKey: ['company-public-notice', company?.id],
    queryFn: async () => {
      const rpcResult = await (supabase as any).rpc('get_active_company_public_notice', {
        _company_id: company!.id,
      });

      if (!rpcResult.error) {
        const rows = (rpcResult.data ?? []) as PublicNotice[];
        return rows.length > 0 ? rows[0] : null;
      }

      const { data, error } = await supabase
        .from('company_public_notices' as any)
        .select('id, text, image_url, active_until, created_at')
        .eq('company_id', company!.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .maybeSingle();

      if (error) throw error;
      return data as PublicNotice | null;
    },
    enabled: !!company?.id,
  });

  useEffect(() => {
    setDismissedNoticeId(null);
  }, [company?.id, publicNotice?.id]);

  const whatsappUrl = buildPublicWhatsappUrl(company?.whatsapp);
  const instagramUrl = buildInstagramProfileUrl(company?.instagram);
  const instagramLabel = useMemo(() => formatInstagramHandleLabel(company?.instagram), [company?.instagram]);
  const googleMapsSearchUrl = getGoogleMapsOpenUrl(company);
  const addressLines = (company?.address || '').split('\n');
  const addressTitle = addressLines[0]?.trim() || '';
  const addressSubtitle = addressLines.slice(1).join('\n').trim();
  const openingHours = useMemo(
    () => (((company?.opening_hours as any[]) || [])) as OpeningHour[],
    [company?.opening_hours],
  );
  const paymentMethods = (company?.payment_methods as Record<string, boolean>) || {};
  const acceptedPayments = Object.entries(paymentMethods).filter(([, accepted]) => accepted);
  const customPublicPageEnabled = company?.custom_public_page_enabled ?? true;
  const publicWhatsappButtonEnabled = (company as any)?.show_public_whatsapp_button ?? true;
  const publicStickyReserveButtonEnabled = (company as any)?.show_public_sticky_reserve_button ?? true;
  const publicReservationExitPromptEnabled = (company as any)?.show_public_reservation_exit_prompt ?? false;
  const publicReservationExitPromptPrimaryText = (company as any)?.public_reservation_exit_prompt_primary_text ?? null;
  const publicReservationExitPromptPrimaryTextSize = (company as any)?.public_reservation_exit_prompt_primary_text_size ?? null;
  const publicReservationExitPromptSecondaryText = (company as any)?.public_reservation_exit_prompt_secondary_text ?? null;
  const publicReservationExitPromptSecondaryTextSize = (company as any)?.public_reservation_exit_prompt_secondary_text_size ?? null;
  const showCustomLogo = customPublicPageEnabled && !!company?.logo_url;
  const showDescription = customPublicPageEnabled && richTextHasContent(company?.description);
  const showHeroMedia = customPublicPageEnabled && !!company?.hero_media_url;
  const heroMediaType = company?.hero_media_type === 'video' ? 'video' : 'image';
  const showWhatsappButton = customPublicPageEnabled && publicWhatsappButtonEnabled && !!whatsappUrl;
  // O estilo escolhido vale para todos os tamanhos de tela. Manter os ramos
  // mutuamente exclusivos evita montar (e baixar) duas copias da mesma midia.
  const useModernHeader = customPublicPageEnabled && company?.public_header_style === 'modern';
  // A barra fixa de reserva mede pt-3 (0.75rem) + botao lg (2.5rem) + padding inferior seguro.
  // O botao flutuante fica 1.25rem acima dela para nao encostar no CTA.
  const whatsappFabStyle = {
    '--wa-fab-bottom': publicStickyReserveButtonEnabled
      ? 'calc(4.5rem + max(0.75rem, env(safe-area-inset-bottom, 0px)))'
      : 'calc(1.25rem + env(safe-area-inset-bottom, 0px))',
  } as CSSProperties;
  const activePublicNotice = publicNotice && publicNotice.id !== dismissedNoticeId ? publicNotice : null;
  const getOpeningHourForDate = (date: Date) => {
    return findOpeningHoursForDayIndex(openingHours, date.getDay());
  };

  const isAllDayBlocked = (iso: string) => blockedDates.some((blocked) => blocked.date === iso && blocked.all_day);
  const isDateClosed = (date: Date) => {
    const iso = format(date, 'yyyy-MM-dd');
    const hours = getOpeningHourForDate(date);
    return !hours || hours.closed || isAllDayBlocked(iso);
  };
  const openingStatus = useMemo(() => getOpeningStatus(openingHours, statusNow), [openingHours, statusNow]);
  const openingHourGroups = useMemo(() => buildOpeningHourGroups(openingHours, statusNow), [openingHours, statusNow]);
  const canMatchContactCardHeight = Boolean(company?.phone || company?.address);
  const openingHoursDensity = openingHourGroups.length >= 6
    ? 'tight'
    : openingHourGroups.length >= 5
      ? 'compact'
      : 'comfortable';

  useEffect(() => {
    const interval = window.setInterval(() => setStatusNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!company || typeof window === 'undefined') return;

    const canonicalUrl = `${window.location.origin}${window.location.pathname}`;
    const descriptionText = richTextToPlainText(company.description);
    const seoTitle = `Reservar mesa no ${company.name} | ${DEFAULT_SYSTEM_NAME}`;
    const seoDescription = truncateSeoText(
      descriptionText
        ? descriptionText
        : `Página de reserva do ${company.name}${company.address ? ` em ${flattenAddress(company.address)}` : ''}. Consulte horários, localização e faça sua reserva online.`,
    );
    const seoImage = toAbsoluteUrl(company.logo_url);
    const sameAs = [instagramUrl, googleMapsSearchUrl].filter(Boolean) as string[];
    const openingHoursSpecification = openingHours
      .map((hour) => {
        const dayOfWeek = getSchemaDayName(hour.day);
        if (!dayOfWeek || hour.closed) return null;

        return compactJsonLd({
          '@type': 'OpeningHoursSpecification',
          dayOfWeek,
          opens: hour.open,
          closes: hour.close,
        });
      })
      .filter((item): item is Record<string, unknown> => Boolean(item));

    document.title = seoTitle;
    upsertCanonical(canonicalUrl);
    upsertMeta('name', 'description', seoDescription);
    upsertMeta('name', 'author', DEFAULT_SYSTEM_NAME);
    upsertMeta('name', 'robots', 'index, follow');
    upsertMeta('property', 'og:title', seoTitle);
    upsertMeta('property', 'og:description', seoDescription);
    upsertMeta('property', 'og:site_name', DEFAULT_SYSTEM_NAME);
    upsertMeta('property', 'og:type', 'website');
    upsertMeta('property', 'og:locale', 'pt_BR');
    upsertMeta('property', 'og:url', canonicalUrl);
    upsertMeta('name', 'twitter:card', seoImage ? 'summary_large_image' : 'summary');
    upsertMeta('name', 'twitter:title', seoTitle);
    upsertMeta('name', 'twitter:description', seoDescription);

    if (seoImage) {
      upsertMeta('property', 'og:image', seoImage);
      upsertMeta('property', 'og:image:secure_url', seoImage);
      upsertMeta('property', 'og:image:alt', `Logo do ${company.name}`);
      upsertMeta('name', 'twitter:image', seoImage);
      upsertMeta('name', 'twitter:image:alt', `Logo do ${company.name}`);
      syncPublicCompanyIcons(seoImage);
    } else {
      removeMeta('property', 'og:image');
      removeMeta('property', 'og:image:secure_url');
      removeMeta('property', 'og:image:alt');
      removeMeta('name', 'twitter:image');
      removeMeta('name', 'twitter:image:alt');
      removePublicCompanyIcons();
    }

    upsertJsonLd(compactJsonLd({
      '@context': 'https://schema.org',
      '@type': 'Restaurant',
      name: company.name,
      description: seoDescription,
      url: canonicalUrl,
      image: seoImage,
      telephone: formatBrazilPhone(company.phone),
      address: company.address
        ? compactJsonLd({
          '@type': 'PostalAddress',
          streetAddress: flattenAddress(company.address),
        })
        : null,
      sameAs,
      openingHoursSpecification,
      potentialAction: compactJsonLd({
        '@type': 'ReserveAction',
        name: `Reservar mesa no ${company.name}`,
        target: canonicalUrl,
      }),
    }));

    return () => {
      document.title = DEFAULT_SYSTEM_NAME;
      upsertMeta('name', 'description', DEFAULT_SEO_DESCRIPTION);
      upsertMeta('name', 'author', DEFAULT_SYSTEM_NAME);
      upsertMeta('name', 'robots', 'index, follow');
      upsertMeta('property', 'og:title', DEFAULT_SYSTEM_NAME);
      upsertMeta('property', 'og:description', DEFAULT_SEO_DESCRIPTION);
      upsertMeta('property', 'og:site_name', DEFAULT_SYSTEM_NAME);
      upsertMeta('property', 'og:type', 'website');
      upsertMeta('name', 'twitter:card', 'summary_large_image');
      upsertMeta('name', 'twitter:title', DEFAULT_SYSTEM_NAME);
      upsertMeta('name', 'twitter:description', DEFAULT_SEO_DESCRIPTION);
      removeMeta('property', 'og:locale');
      removeMeta('property', 'og:url');
      removeMeta('property', 'og:image');
      removeMeta('property', 'og:image:secure_url');
      removeMeta('property', 'og:image:alt');
      removeMeta('name', 'twitter:image');
      removeMeta('name', 'twitter:image:alt');
      removeCanonical();
      removeJsonLd();
      removePublicCompanyIcons();
    };
  }, [company, customPublicPageEnabled, googleMapsSearchUrl, instagramUrl, openingHours]);

  if (isLoading) {
    return <PublicPageSkeleton />;
  }

  if (!slugIsValid || error || !company) {
    if (companyStatus && companyStatus.status === 'paused') {
      const contactWhatsapp = buildPublicWhatsappUrl(companyStatus.whatsapp);

      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gradient-to-b from-[#130D06] to-[#2E1800] p-6 text-center">
          <div className="w-full max-w-md rounded-lg border border-border/20 bg-card/10 p-8 backdrop-blur-sm">
            <Clock className="mx-auto mb-4 h-12 w-12 text-amber-400" />
            <h1 className="mb-2 text-2xl font-bold text-white">{companyStatus.name}</h1>
            <p className="mb-6 text-white/70">
              {'Este restaurante est\u00E1 temporariamente indispon\u00EDvel para novas reservas.'}
            </p>
            <div className="space-y-3">
              {companyStatus.phone && (
                <a
                  href={`tel:${normalizeBrazilPhoneDigits(companyStatus.phone)}`}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-white transition-colors hover:bg-white/20"
                >
                  <Phone className="h-4 w-4" />
                  Ligar: {formatBrazilPhone(companyStatus.phone)}
                </a>
              )}
              {contactWhatsapp && (
                <a
                  href={contactWhatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-white transition-colors hover:bg-emerald-700"
                >
                  <WhatsAppIcon className="h-4 w-4" />
                  Falar pelo WhatsApp
                </a>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-center">
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-8 shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <MapPin className="h-7 w-7 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-foreground">Página não encontrada</h1>
            <p className="text-sm text-muted-foreground">
              Este restaurante não existe ou está temporariamente indisponível.
            </p>
          </div>
          <a
            href="/"
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Voltar ao início
          </a>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-secondary pb-24 md:pb-0">
      <div
        className={cn(
          'relative overflow-hidden px-4 pb-8 md:pb-14 md:pt-6 md:text-primary-foreground',
          useModernHeader ? 'pt-2 text-foreground' : 'pt-5 text-primary-foreground',
        )}
      >
        {/* O fundo escuro pertence apenas ao estilo classico. */}
        <div
          className={cn('pointer-events-none absolute inset-0', useModernHeader && 'hidden')}
          style={{ background: 'linear-gradient(170deg, #130D06 0%, #1C1108 50%, #2E1800 100%)' }}
        />
        {!useModernHeader && showHeroMedia && company.hero_media_url && (
          <>
            <HeroMedia
              url={company.hero_media_url}
              type={heroMediaType}
              className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover"
            />
            <div
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                background:
                  'linear-gradient(180deg, rgba(10,7,3,0.78) 0%, rgba(10,7,3,0.5) 35%, rgba(10,7,3,0.58) 70%, rgba(10,7,3,0.88) 100%)',
              }}
            />
          </>
        )}
        <div
          className={cn('pointer-events-none absolute inset-0', useModernHeader && 'hidden')}
          style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 60%, rgba(232,105,10,0.16) 0%, transparent 70%)' }}
        />
        <div
          className={cn('pointer-events-none absolute bottom-0 left-0 right-0 h-24', useModernHeader && 'hidden')}
          style={{ background: 'linear-gradient(to top, rgba(46,24,0,0.58) 0%, transparent 100%)' }}
        />

        {/* Estilo moderno: cartao claro com a midia no topo e a logo sobreposta. */}
        {useModernHeader && (
        <div className="relative z-10 mx-auto max-w-lg md:max-w-5xl">
          <div className="animate-slide-up text-foreground motion-reduce:animate-none">
            <div className="relative -mx-2 h-[400px] overflow-hidden rounded-[1.35rem] md:mx-0 md:h-auto md:aspect-[16/7] md:rounded-[1.75rem]">
              {showHeroMedia && company.hero_media_url ? (
                <HeroMedia
                  url={company.hero_media_url}
                  type={heroMediaType}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="h-full w-full"
                  style={{
                    background:
                      'repeating-linear-gradient(115deg, rgba(0,0,0,0.24) 0px, rgba(0,0,0,0.24) 16px, rgba(255,255,255,0.05) 16px, rgba(255,255,255,0.05) 32px), linear-gradient(150deg, #7A3608 0%, #3A1B06 55%, #1C1108 100%)',
                  }}
                />
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-black/15" />

              {openingStatus && (
                <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-background/95 px-2.5 py-1 shadow-md backdrop-blur-sm">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      openingStatus.variant === 'open' ? 'bg-emerald-500' : 'bg-amber-500',
                    )}
                  />
                  <span className="text-[0.72rem] font-semibold text-foreground">{openingStatus.title}</span>
                </div>
              )}
            </div>

            {/* A midia e position:relative, entao a logo precisa de z-index proprio
                para cruzar a borda por cima em vez de ficar atras dela. */}
            <div className="relative z-10 -mt-11 flex justify-center md:-mt-14">
              {showCustomLogo ? (
                <img
                  src={company.logo_url}
                  alt={company.name}
                  width={112}
                  height={112}
                  loading="eager"
                  decoding="async"
                  fetchPriority={showHeroMedia ? 'auto' : 'high'}
                  className="h-[5.5rem] w-[5.5rem] shrink-0 rounded-full object-cover shadow-[0_6px_18px_rgba(0,0,0,0.28)] ring-4 ring-secondary md:h-28 md:w-28"
                />
              ) : (
                <div className="flex h-[5.5rem] w-[5.5rem] shrink-0 items-center justify-center rounded-full bg-primary text-[2rem] font-bold text-primary-foreground shadow-[0_6px_18px_rgba(0,0,0,0.28)] ring-4 ring-secondary md:h-28 md:w-28 md:text-[2.5rem]">
                  {company.name.charAt(0)}
                </div>
              )}
            </div>

            {/* Mobile permanece visualmente identico ao layout moderno anterior. */}
            <div className="mt-3 space-y-3 px-1 pb-1 text-center md:hidden">
              <h1 className="text-balance text-[clamp(1.35rem,5.4vw,1.75rem)] font-bold leading-tight tracking-tight text-foreground">
                {company.name}
              </h1>

              {(googleMapsSearchUrl || (instagramUrl && instagramLabel)) && (
                <div className="flex items-center justify-center gap-3">
                  {googleMapsSearchUrl && (
                    <a
                      href={googleMapsSearchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Avaliações no Google"
                      className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground transition-opacity hover:opacity-75"
                    >
                      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                      {PUBLIC_RATING_LABEL}
                    </a>
                  )}

                  {googleMapsSearchUrl && instagramUrl && instagramLabel && (
                    <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                  )}

                  {instagramUrl && instagramLabel && (
                    <a
                      href={instagramUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Instagram"
                      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <InstagramLogo className="h-[1.15rem] w-[1.15rem] shrink-0" />
                      <span className="truncate tracking-[0.01em]">{instagramLabel}</span>
                    </a>
                  )}
                </div>
              )}

              {showDescription && (
                <div className="rounded-lg bg-card p-4 shadow-sm">
                  <RichTextContent
                    value={company.description}
                    className="text-sm leading-relaxed text-muted-foreground [&_h1]:text-xl [&_h1]:text-foreground [&_h2]:text-lg [&_h2]:text-foreground [&_p]:text-sm"
                  />
                </div>
              )}

              <Button
                className="group w-full animate-attention-pulse-glow gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90"
                size="lg"
                onMouseEnter={() => void preloadReservationModal()}
                onFocus={() => void preloadReservationModal()}
                onClick={handleOpenReservation}
              >
                <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                Reservar agora
              </Button>
            </div>

            {/* Desktop moderno repete a mesma hierarquia visual do mobile. */}
            <div className="mx-auto mt-5 hidden max-w-2xl space-y-4 px-1 pb-1 text-center md:block">
              <h1 className="text-balance text-[clamp(2rem,3vw,2.75rem)] font-bold leading-tight tracking-tight text-foreground">
                {company.name}
              </h1>

              {(googleMapsSearchUrl || (instagramUrl && instagramLabel)) && (
                <div className="flex items-center justify-center gap-3">
                  {googleMapsSearchUrl && (
                    <a
                      href={googleMapsSearchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Avaliações no Google"
                      className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-foreground transition-opacity hover:opacity-75"
                    >
                      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                      {PUBLIC_RATING_LABEL}
                    </a>
                  )}

                  {googleMapsSearchUrl && instagramUrl && instagramLabel && (
                    <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                  )}

                  {instagramUrl && instagramLabel && (
                    <a
                      href={instagramUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Instagram"
                      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <InstagramLogo className="h-[1.15rem] w-[1.15rem] shrink-0" />
                      <span className="truncate tracking-[0.01em]">{instagramLabel}</span>
                    </a>
                  )}
                </div>
              )}

              {showDescription && (
                <div className="mt-4 rounded-lg bg-card p-5 shadow-sm">
                  <RichTextContent
                    value={company.description}
                    className="text-base leading-relaxed text-muted-foreground [&_h1]:text-xl [&_h1]:text-foreground [&_h2]:text-lg [&_h2]:text-foreground [&_p]:text-base"
                  />
                </div>
              )}

              <Button
                className="group mx-auto mt-4 w-full max-w-md animate-attention-pulse-glow gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90 motion-reduce:animate-none"
                size="lg"
                onMouseEnter={() => void preloadReservationModal()}
                onFocus={() => void preloadReservationModal()}
                onClick={handleOpenReservation}
              >
                <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                Reservar agora
              </Button>
            </div>
          </div>
        </div>
        )}

        {/* Estilo classico: mobile preservado; nova composicao somente no desktop. */}
        {!useModernHeader && (
          <div className="relative z-10 mx-auto flex max-w-lg flex-col items-center text-center md:max-w-2xl">
            {showCustomLogo ? (
              <img
                src={company.logo_url}
                alt={company.name}
                width={112}
                height={112}
                loading="eager"
                decoding="async"
                fetchPriority={showHeroMedia ? 'auto' : 'high'}
                className="h-[6.2rem] w-[6.2rem] shrink-0 rounded-full border border-white/20 object-cover shadow-lg md:h-28 md:w-28"
              />
            ) : (
              <div className="flex h-[6.2rem] w-[6.2rem] shrink-0 items-center justify-center rounded-full bg-primary text-[2rem] font-bold text-primary-foreground shadow-lg md:h-28 md:w-28 md:text-[2.5rem]">
                {company.name.charAt(0)}
              </div>
            )}

            {googleMapsSearchUrl && (
              <RefinedRatingStarsLink href={googleMapsSearchUrl} className="mt-4 md:hidden" />
            )}
            {googleMapsSearchUrl && <HeroOrnamentDivider className="mt-4 md:hidden" />}

            <div className="mt-5 w-full md:hidden">
              <div className="animate-slide-up space-y-5">
                <div className="space-y-3 text-center">
                  <h1 className="mx-auto w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(1.7rem,6.2vw,2.15rem)] font-bold leading-tight tracking-tight">
                    {company.name}
                  </h1>
                  {instagramUrl && instagramLabel && (
                    <a
                      href={instagramUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Instagram"
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-[0.72rem] font-medium text-[#F1D6DE] transition-[background-color,border-color,color] hover:border-white/20 hover:bg-white/10 hover:text-white"
                    >
                      <span className="inline-flex h-5.5 w-5.5 items-center justify-center rounded-full bg-white/10 text-pink-200">
                        <InstagramLogo className="h-[0.7rem] w-[0.7rem]" />
                      </span>
                      <span className="text-[0.72rem] tracking-[0.01em]">{instagramLabel}</span>
                    </a>
                  )}
                  {showDescription && (
                    <div className="mt-4 max-w-2xl rounded-lg border border-white/15 bg-background p-4 text-foreground shadow-lg">
                      <RichTextContent
                        value={company.description}
                        className="text-sm leading-relaxed text-muted-foreground [&_h1]:text-2xl [&_h1]:text-foreground [&_h2]:text-xl [&_h2]:text-foreground [&_p]:text-sm"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 animate-slide-up [animation-delay:80ms]">
                <Button
                  className="group w-full animate-attention-pulse-fast gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary/90"
                  size="lg"
                  onMouseEnter={() => void preloadReservationModal()}
                  onFocus={() => void preloadReservationModal()}
                  onClick={handleOpenReservation}
                >
                  <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                  Reservar agora
                </Button>
              </div>
            </div>

            <div className="mt-4 hidden w-full animate-slide-up space-y-4 motion-reduce:animate-none md:block">
              {googleMapsSearchUrl && <RefinedRatingStarsLink href={googleMapsSearchUrl} />}
              <HeroOrnamentDivider className="mt-4" />
              <h1 className="mt-4 text-balance text-[clamp(2rem,3vw,2.75rem)] font-bold leading-tight tracking-tight">
                {company.name}
              </h1>

              {instagramUrl && instagramLabel && (
                <a
                  href={instagramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="mt-3 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-[0.78rem] font-medium text-[#F1D6DE] transition-[background-color,border-color,color] hover:border-white/20 hover:bg-white/10 hover:text-white"
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-pink-200">
                    <InstagramLogo className="h-3 w-3" />
                  </span>
                  <span className="tracking-[0.01em]">{instagramLabel}</span>
                </a>
              )}

              {showDescription && (
                <div className="mx-auto mt-4 max-w-2xl rounded-lg border border-white/15 bg-background p-5 text-left text-foreground shadow-lg">
                  <RichTextContent
                    value={company.description}
                    className="text-base leading-relaxed text-muted-foreground [&_h1]:text-2xl [&_h1]:text-foreground [&_h2]:text-xl [&_h2]:text-foreground [&_p]:text-base"
                  />
                </div>
              )}

              <Button
                className="group mx-auto mt-4 w-full max-w-md animate-attention-pulse-fast gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary/90 motion-reduce:animate-none"
                size="lg"
                onMouseEnter={() => void preloadReservationModal()}
                onFocus={() => void preloadReservationModal()}
                onClick={handleOpenReservation}
              >
                <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                Reservar agora
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-lg space-y-4 px-4 py-5 md:max-w-5xl md:space-y-6 md:py-6">
        <div className="grid items-start gap-4 md:grid-cols-2 md:gap-6">
          {openingHours.length > 0 && (
            <div
              className={cn(
                canMatchContactCardHeight && isHoursExpanded && 'md:relative md:self-stretch',
              )}
            >
              {/* No desktop, o card de contato dita a altura da linha sem ser esticado pelos horários. */}
              <Card
                className={cn(
                  'animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md',
                  canMatchContactCardHeight && isHoursExpanded && 'md:absolute md:inset-0 md:overflow-hidden',
                )}
              >
                <CardContent
                  className={cn(
                    'pb-5 pt-5',
                    canMatchContactCardHeight && isHoursExpanded && 'md:flex md:h-full md:min-h-0 md:flex-col',
                  )}
                >
                  <div>
                    <div>
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                        <Clock className="h-4 w-4" />
                        {'Hor\u00E1rio de Funcionamento'}
                      </h3>
                      {openingStatus && (
                        <div className="mt-3" role="status">
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'h-2 w-2 shrink-0 rounded-full',
                                  openingStatus.variant === 'open' && 'bg-emerald-500',
                                  openingStatus.variant === 'closed' && 'bg-amber-500',
                                )}
                                aria-hidden="true"
                              />
                              <p className="text-sm font-bold text-foreground">{openingStatus.title}</p>
                            </span>
                            <button
                              type="button"
                              onClick={() => setIsHoursExpanded((current) => !current)}
                              className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                              aria-expanded={isHoursExpanded}
                            >
                              {isHoursExpanded ? 'Recolher' : 'Ver hor\u00E1rios'}
                            </button>
                          </div>
                          {openingStatus.description && (
                            <p className="mt-1 pl-4 text-xs text-muted-foreground">{openingStatus.description}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    className={cn(
                      'grid transition-[grid-template-rows] duration-300 ease-in-out',
                      isHoursExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                      canMatchContactCardHeight && isHoursExpanded && 'md:min-h-0 md:flex-1',
                    )}
                    aria-hidden={!isHoursExpanded}
                  >
                    <div
                      className={cn(
                        'overflow-hidden',
                        canMatchContactCardHeight && isHoursExpanded
                          && 'md:h-full md:min-h-0 md:overflow-y-auto md:pr-1 scrollbar-thin',
                      )}
                      role="region"
                      aria-label="Horários da semana"
                      tabIndex={isHoursExpanded ? 0 : -1}
                    >
                      <div
                        className={cn(
                          'mt-4',
                          canMatchContactCardHeight && isHoursExpanded && 'md:flex md:min-h-[calc(100%_-_1rem)] md:flex-col',
                        )}
                      >
                        {openingHourGroups.map((group) => (
                          <div
                            key={group.label}
                            className={cn(
                              'flex items-center justify-between gap-3 border-b border-border/50 py-2.5 text-sm last:border-b-0',
                              canMatchContactCardHeight && isHoursExpanded && 'md:grow md:shrink-0 md:py-1.5',
                              canMatchContactCardHeight && isHoursExpanded && openingHoursDensity === 'compact'
                                && 'md:py-1 md:text-xs md:leading-snug',
                              canMatchContactCardHeight && isHoursExpanded && openingHoursDensity === 'tight'
                                && 'md:py-0.5 md:text-xs md:leading-snug',
                            )}
                          >
                            <span className={cn(group.isToday ? 'font-bold text-foreground' : 'text-muted-foreground')}>
                              {group.label}
                            </span>
                            <span className={cn('shrink-0 whitespace-nowrap text-right tabular-nums', group.isToday ? 'font-bold text-foreground' : 'text-muted-foreground')}>
                              {group.closed ? 'Fechado' : `${group.open} \u2013 ${group.close}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {(company.phone || company.address) && (
            <Card className="animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md [animation-delay:60ms]">
              <CardContent className="flex flex-col gap-4 pb-5 pt-5 md:gap-6 md:pb-4 md:pt-8">
                {addressTitle && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-[21px] w-[21px] shrink-0 text-primary" />
                    <div>
                      <p className="text-[18px] font-semibold leading-snug text-foreground">{addressTitle}</p>
                      {addressSubtitle && (
                        <p className="whitespace-pre-line text-sm text-muted-foreground">{addressSubtitle}</p>
                      )}
                    </div>
                  </div>
                )}

                {googleMapsSearchUrl && (
                  <a
                    href={googleMapsSearchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                  >
                    Abrir no Mapa
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}

                {company.address && company.phone && <div className="border-t border-border" />}

                {company.phone && (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Telefone</p>
                      <p className="text-base font-semibold text-foreground">{formatBrazilPhone(company.phone)}</p>
                    </div>
                    <a
                      href={`tel:${normalizeBrazilPhoneDigits(company.phone)}`}
                      className="flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                    >
                      <Phone className="h-4 w-4" />
                      Ligar
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {acceptedPayments.length > 0 && (
          <Card className="rounded-lg border-none shadow-sm">
            <CardContent className="pb-5 pt-5">
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <CreditCard className="h-4 w-4" />
                Formas de Pagamento
              </h3>
              <div className="flex flex-nowrap justify-center gap-1.5 overflow-x-auto sm:gap-2">
                {acceptedPayments.map(([key]) => {
                  const paymentMethod = PAYMENT_LABELS[key];
                  const Icon = paymentMethod?.icon || CreditCard;
                  return (
                    <div key={key} className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs sm:gap-1.5 sm:px-3 sm:py-1.5 sm:text-sm">
                      <Icon className="h-3 w-3 shrink-0 text-primary sm:h-3.5 sm:w-3.5" />
                      <span className="text-foreground">{paymentMethod?.label || key}</span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Cartões, Pix e dinheiro aceitos
              </p>
            </CardContent>
          </Card>
        )}

      </div>

      <Suspense fallback={null}>
        <FunnelDebugPanel />
      </Suspense>

      <Dialog
        open={!!activePublicNotice}
        onOpenChange={(open) => {
          if (!open && activePublicNotice) {
            setDismissedNoticeId(activePublicNotice.id);
          }
        }}
      >
        <DialogContent
          hideCloseButton
          className="bottom-auto left-[50%] right-auto top-[50%] z-[70] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] flex-col gap-0 overflow-hidden rounded-lg border-none bg-background p-0 shadow-2xl sm:max-w-md"
        >
          <DialogTitle className="sr-only">Aviso do restaurante</DialogTitle>
          <DialogDescription className="sr-only">
            Aviso ativo do restaurante para visitantes da página pública.
          </DialogDescription>

          {activePublicNotice?.image_url && (
            <div className="min-h-0 shrink overflow-hidden bg-muted">
              <img
                src={activePublicNotice.image_url}
                alt="Aviso do restaurante"
                className="max-h-[52dvh] w-full object-contain"
              />
            </div>
          )}

          <div className="flex min-h-0 shrink-0 flex-col gap-4 p-4 sm:p-5">
            {activePublicNotice?.text && (
              <p className="max-h-[34dvh] overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {activePublicNotice.text}
              </p>
            )}

            <Button
              type="button"
              className="w-full rounded-lg"
              onClick={() => {
                if (activePublicNotice) {
                  setDismissedNoticeId(activePublicNotice.id);
                }
              }}
            >
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {showWhatsappButton && (
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Falar pelo WhatsApp"
          title="Falar pelo WhatsApp"
          style={whatsappFabStyle}
          className="fixed right-4 bottom-[var(--wa-fab-bottom)] z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[linear-gradient(145deg,#3BE97C_0%,#25D366_45%,#17A94F_100%)] shadow-[0_10px_26px_-6px_rgba(15,120,60,0.55)] ring-1 ring-black/10 transition-[transform,filter] duration-150 hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] focus-visible:ring-offset-2 active:scale-95 md:right-6 md:bottom-6 md:h-[3.3rem] md:w-[3.3rem]"
        >
          <img
            src={whatsappGlyphUrl}
            alt=""
            aria-hidden="true"
            className="h-[1.6rem] w-[1.6rem] md:h-[1.73rem] md:w-[1.73rem]"
          />
        </a>
      )}

      {publicStickyReserveButtonEnabled && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 border-t border-border/50 bg-background/95 px-4 pt-3 shadow-[0_-12px_32px_rgba(0,0,0,0.14)] backdrop-blur-xl md:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto max-w-lg">
            <Button
              className="group animate-attention-pulse-glow w-full gap-2 rounded-lg text-base font-semibold transition-[background-color,transform] duration-150"
              size="lg"
              onClick={handleOpenReservation}
              onMouseEnter={() => void preloadReservationModal()}
              onFocus={() => void preloadReservationModal()}
            >
              <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
              Reservar agora
            </Button>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        <ReservationModal
          open={showReservation}
          onOpenChange={setShowReservation}
          slug={slug ?? ''}
          companyId={company.id}
          companyName={company.name}
          companyWhatsapp={company.whatsapp}
          openingHours={openingHours}
          reservationDuration={(company as any).reservation_duration ?? 30}
          maxGuestsPerSlot={(company as any).max_guests_per_slot ?? 0}
          largePartyThreshold={(company as any).large_party_whatsapp_threshold ?? 10}
          initialDate={null}
          initialPartySize={2}
          onStepChange={(step) => trackStep(step)}
          getTrackingSnapshot={getTrackingSnapshot}
          clearTrackingJourney={clearJourney}
          exitRecoveryEnabled={publicReservationExitPromptEnabled}
          exitRecoveryPrimaryText={publicReservationExitPromptPrimaryText}
          exitRecoveryPrimaryTextSize={publicReservationExitPromptPrimaryTextSize}
          exitRecoverySecondaryText={publicReservationExitPromptSecondaryText}
          exitRecoverySecondaryTextSize={publicReservationExitPromptSecondaryTextSize}
        />
      </Suspense>
    </main>
  );
}
