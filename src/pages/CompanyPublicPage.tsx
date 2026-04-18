import { lazy, Suspense, useEffect, useMemo, useState, type SVGProps } from 'react';
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
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RichTextContent } from '@/components/ui/rich-text-editor';
import { useFunnelTracking } from '@/hooks/useFunnelTracking';
import type { Company } from '@/hooks/useCompanies';
import { supabase } from '@/integrations/supabase/client';
import { getGoogleMapsEmbedUrl } from '@/lib/maps';
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

const loadReservationModal = () => import('@/components/ReservationModal');
const ReservationModal = lazy(loadReservationModal);
const FunnelDebugPanel = lazy(() => import('@/components/FunnelDebugPanel'));
const DEFAULT_SEO_DESCRIPTION = 'Plataforma de reservas para restaurantes com página pública, painel por unidade e automações via WhatsApp.';
const PUBLIC_RESERVATION_JSON_LD_ID = 'public-reservation-json-ld';
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

function InstagramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="3.75" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
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

function RatingStarsLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Avaliações no Google"
      className={cn(
        'inline-flex items-center rounded-md border border-amber-300/30 bg-black/25 px-3 py-1.5 shadow-[0_0_22px_rgba(251,191,36,0.24)] backdrop-blur-sm transition-[background-color,box-shadow,transform] duration-200 hover:bg-black/35 hover:shadow-[0_0_30px_rgba(251,191,36,0.36)]',
        className,
      )}
    >
      <span className="bg-gradient-to-r from-amber-200 via-yellow-300 to-amber-500 bg-clip-text text-lg font-black leading-none text-transparent drop-shadow-[0_0_8px_rgba(251,191,36,0.9)]">
        ★★★★★
      </span>
    </a>
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

function HeroOrnamentDivider({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3', className)} aria-hidden="true">
      <span className="h-px w-14 bg-gradient-to-r from-transparent via-[#C98A3A]/70 to-[#F2D2A1]/25" />
      <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] border border-[#E3B36A]/70 bg-[radial-gradient(circle_at_30%_30%,rgba(255,224,173,0.65),rgba(96,49,11,0.9))] shadow-[0_0_14px_rgba(201,138,58,0.2)]" />
      <span className="h-px w-14 bg-gradient-to-l from-transparent via-[#C98A3A]/70 to-[#F2D2A1]/25" />
    </div>
  );
}

const PAYMENT_LABELS: Record<string, { label: string; icon: typeof CreditCard }> = {
  dinheiro: { label: 'Dinheiro', icon: Banknote },
  credito: { label: 'Cr\u00E9dito', icon: CreditCard },
  debito: { label: 'D\u00E9bito', icon: CreditCard },
  pix: { label: 'Pix', icon: QrCode },
  vale_refeicao: { label: 'Vale Refei\u00E7\u00E3o', icon: Wallet },
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

const CLOSING_SOON_THRESHOLD_MINUTES = 60;

interface OpeningSlot {
  day: string;
  open: string;
  close: string;
  start: Date;
  end: Date;
}

interface OpeningStatus {
  title: string;
  description: string;
  variant: 'open' | 'closing' | 'closed';
}

function parseTimeToMinutes(time?: string | null) {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function describeDuration(totalMinutes: number) {
  const minutes = Math.max(1, Math.ceil(totalMinutes));
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h${String(remainingMinutes).padStart(2, '0')}`;
}

function isSameCalendarDate(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function getOpeningHourByDayIndex(hours: OpeningHour[], dayIndex: number) {
  const dayName = DAY_NAMES_BY_INDEX[dayIndex];
  return dayName ? hours.find((hour) => hour.day === dayName) || null : null;
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

function describeOpeningMoment(slot: OpeningSlot, now: Date) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameCalendarDate(slot.start, now)) return `hoje às ${slot.open}`;
  if (isSameCalendarDate(slot.start, tomorrow)) return `amanhã às ${slot.open}`;
  return `${slot.day} às ${slot.open}`;
}

function getOpeningStatus(hours: OpeningHour[], now: Date): OpeningStatus | null {
  if (hours.length === 0) return null;

  const slots = buildOpeningSlots(hours, now);
  const currentSlot = slots.find((slot) => now >= slot.start && now < slot.end);

  if (currentSlot) {
    const minutesToClose = Math.ceil((currentSlot.end.getTime() - now.getTime()) / 60_000);
    const nextSlot = slots.find((slot) => slot.start > currentSlot.end);

    if (minutesToClose <= CLOSING_SOON_THRESHOLD_MINUTES) {
      return {
        title: `Fechando em ${describeDuration(minutesToClose)}`,
        description: nextSlot
          ? `Depois, abrimos novamente ${describeOpeningMoment(nextSlot, now)}.`
          : 'Consulte o restaurante para confirmar a próxima abertura.',
        variant: 'closing',
      };
    }

    return {
      title: 'Aberto agora',
      description: `Hoje até ${currentSlot.close}.`,
      variant: 'open',
    };
  }

  const nextSlot = slots.find((slot) => slot.start > now);
  if (!nextSlot) {
    return {
      title: 'Fechado agora',
      description: 'Consulte o restaurante para confirmar a próxima abertura.',
      variant: 'closed',
    };
  }

  return {
    title: 'Fechado agora',
    description: `Próxima abertura ${describeOpeningMoment(nextSlot, now)}.`,
    variant: 'closed',
  };
}

function getGoogleMapsOpenUrl(company: Company | null) {
  if (!company) return null;

  if (company.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(company.address)}`;
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

  const { data: company, isLoading, error } = useQuery({
    queryKey: ['company-public', slug],
    queryFn: async () => {
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

  const { trackStep, startJourney, getTrackingSnapshot, clearJourney } = useFunnelTracking(undefined, slug);

  const handleOpenReservation = () => {
    void startJourney();
    void loadReservationModal();
    setShowReservation(true);
  };

  useEffect(() => {
    if (company?.id) trackStep('page_view');
  }, [company?.id, trackStep]);

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
  const mapsEmbedUrl = getGoogleMapsEmbedUrl(company?.google_maps_url, company?.address || company?.name || null);
  const openingHours = useMemo(
    () => (((company?.opening_hours as any[]) || [])) as OpeningHour[],
    [company?.opening_hours],
  );
  const paymentMethods = (company?.payment_methods as Record<string, boolean>) || {};
  const acceptedPayments = Object.entries(paymentMethods).filter(([, accepted]) => accepted);
  const customPublicPageEnabled = (company as any)?.custom_public_page_enabled ?? true;
  const publicWhatsappButtonEnabled = (company as any)?.show_public_whatsapp_button ?? true;
  const publicStickyReserveButtonEnabled = (company as any)?.show_public_sticky_reserve_button ?? true;
  const publicReservationExitPromptEnabled = (company as any)?.show_public_reservation_exit_prompt ?? false;
  const showCustomLogo = customPublicPageEnabled && !!company?.logo_url;
  const showDescription = customPublicPageEnabled && richTextHasContent(company?.description);
  const showWhatsappButton = customPublicPageEnabled && publicWhatsappButtonEnabled && !!whatsappUrl;
  const activePublicNotice = publicNotice && publicNotice.id !== dismissedNoticeId ? publicNotice : null;
  const getOpeningHourForDate = (date: Date) => {
    const dayIndex = date.getDay();
    const dayName = Object.entries(DAY_MAP).find(([, value]) => value === dayIndex)?.[0];
    return openingHours.find((hour) => hour.day === dayName) || null;
  };

  const isAllDayBlocked = (iso: string) => blockedDates.some((blocked) => blocked.date === iso && blocked.all_day);
  const isDateClosed = (date: Date) => {
    const iso = format(date, 'yyyy-MM-dd');
    const hours = getOpeningHourForDate(date);
    return !hours || hours.closed || isAllDayBlocked(iso);
  };
  const openingStatus = useMemo(() => getOpeningStatus(openingHours, statusNow), [openingHours, statusNow]);

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
        : `Página de reserva do ${company.name}${company.address ? ` em ${company.address}` : ''}. Consulte horários, localização e faça sua reserva online.`,
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
          streetAddress: company.address,
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
    return (
      <div className="min-h-screen bg-secondary">
        {/* Header skeleton */}
        <div className="h-16 bg-[#130D06]" />
        {/* Hero skeleton */}
        <div className="bg-[#1C1108] px-4 pb-8 pt-5">
          <div className="mx-auto max-w-lg space-y-4">
            <div className="h-6 w-40 animate-pulse rounded-full bg-white/10" />
            <div className="space-y-2">
              <div className="h-10 w-3/4 animate-pulse rounded-lg bg-white/10" />
              <div className="h-4 w-full animate-pulse rounded bg-white/10" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-white/10" />
            </div>
            <div className="h-12 w-full animate-pulse rounded-lg bg-primary/30" />
          </div>
        </div>
        {/* Cards skeleton */}
        <div className="mx-auto max-w-lg space-y-4 px-4 py-5">
          <div className="h-48 animate-pulse rounded-lg bg-muted" />
          <div className="h-48 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
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
    <div className="min-h-screen bg-secondary pb-24 md:pb-0">
      <div
        className="relative overflow-hidden px-4 pb-8 pt-5 text-primary-foreground md:pb-14 md:pt-6"
        style={{ background: 'linear-gradient(170deg, #130D06 0%, #1C1108 50%, #2E1800 100%)' }}
      >
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 60%, rgba(232,105,10,0.16) 0%, transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-24"
          style={{ background: 'linear-gradient(to top, rgba(46,24,0,0.58) 0%, transparent 100%)' }}
        />

        <div className="relative z-10 mx-auto max-w-lg md:max-w-5xl">
          <div className="flex flex-col items-center md:items-start">
            {showCustomLogo ? (
              <img
                src={company.logo_url}
                alt={company.name}
                className="h-[6.2rem] w-[6.2rem] shrink-0 rounded-full border border-white/20 object-cover shadow-lg md:h-[5.5rem] md:w-[5.5rem]"
              />
            ) : (
              <div className="flex h-[6.2rem] w-[6.2rem] shrink-0 items-center justify-center rounded-full bg-primary text-[2rem] font-bold text-primary-foreground shadow-lg md:h-[5.5rem] md:w-[5.5rem] md:text-[2.2rem]">
                {company.name.charAt(0)}
              </div>
            )}
            {googleMapsSearchUrl && (
              <RefinedRatingStarsLink href={googleMapsSearchUrl} className="mt-4 md:hidden" />
            )}
            {googleMapsSearchUrl && <HeroOrnamentDivider className="mt-4 md:hidden" />}
          </div>

          <div className="mt-5 md:grid md:grid-cols-[minmax(0,1fr)_22rem] md:gap-10">
            <div className="space-y-5 animate-slide-up">
              {googleMapsSearchUrl && (
                <RefinedRatingStarsLink href={googleMapsSearchUrl} className="hidden md:inline-flex" />
              )}

              <div className="space-y-3 text-center md:text-left">
                <h2 className="mx-auto w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(1.7rem,6.2vw,2.15rem)] font-bold leading-tight tracking-tight md:mx-0 md:text-[clamp(2rem,3vw,2.7rem)]">
                  {company.name}
                </h2>
                {instagramUrl && instagramLabel && (
                  <a
                    href={instagramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Instagram"
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-[0.72rem] font-medium text-[#F1D6DE] transition-[background-color,border-color,color] hover:border-white/20 hover:bg-white/10 hover:text-white"
                  >
                    <span className="inline-flex h-5.5 w-5.5 items-center justify-center rounded-full bg-white/10 text-pink-200">
                      <InstagramIcon className="h-[0.7rem] w-[0.7rem]" />
                    </span>
                    <span className="text-[0.72rem] tracking-[0.01em]">{instagramLabel}</span>
                  </a>
                )}
                {showDescription && (
                  <div className="mt-4 max-w-2xl rounded-lg border border-white/15 bg-background p-4 text-foreground shadow-lg">
                    <RichTextContent
                      value={company.description}
                      className="text-sm leading-relaxed text-muted-foreground md:text-base [&_h1]:text-2xl [&_h1]:text-foreground [&_h2]:text-xl [&_h2]:text-foreground [&_p]:text-sm md:[&_p]:text-base"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 space-y-3 animate-slide-up [animation-delay:80ms] md:mt-0 md:self-end">
              <Button
                className="group animate-attention-pulse-fast w-full gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary/90"
                size="lg"
                onMouseEnter={() => void loadReservationModal()}
                onFocus={() => void loadReservationModal()}
                onClick={handleOpenReservation}
              >
                <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
                Reservar agora
              </Button>

              {showWhatsappButton && (
                <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="block">
                  <Button
                    variant="secondary"
                    className="w-full gap-2 rounded-lg border-none bg-background text-base font-semibold text-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-150 hover:bg-background/90"
                    size="lg"
                  >
                    <WhatsAppIcon className="h-5 w-5 text-emerald-600" />
                    Falar pelo WhatsApp
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-lg space-y-4 px-4 py-5 md:max-w-5xl md:space-y-6 md:py-6">
        <div className="grid items-stretch gap-4 md:grid-cols-2 md:gap-6">
          {openingHours.length > 0 && (
            <Card className="h-full animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md">
              <CardContent className="h-full pb-5 pt-5">
                <div>
                  <div>
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                      <Clock className="h-4 w-4" />
                      {'Hor\u00E1rio de Funcionamento'}
                    </h3>
                    {openingStatus && (
                      <div
                        className={cn(
                          'mt-3 rounded-md border px-3 py-2.5',
                          openingStatus.variant === 'open' && 'border-emerald-200 bg-emerald-50 text-emerald-950',
                          openingStatus.variant === 'closing' && 'border-red-200 bg-red-50 text-red-950',
                          openingStatus.variant === 'closed' && 'border-amber-200 bg-amber-50 text-amber-950',
                        )}
                        role="status"
                      >
                        <p className="text-sm font-semibold">{openingStatus.title}</p>
                        <p
                          className={cn(
                            'mt-0.5 text-xs leading-relaxed',
                            openingStatus.variant === 'open' && 'text-emerald-800',
                            openingStatus.variant === 'closing' && 'text-red-800',
                            openingStatus.variant === 'closed' && 'text-amber-800',
                          )}
                        >
                          {openingStatus.description}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 space-y-0">
                  {openingHours.map((hour) => (
                    <div
                      key={hour.day}
                      className={`flex items-center justify-between border-b border-border/50 py-2.5 last:border-b-0 ${hour.day === (Object.entries(DAY_MAP).find(([, value]) => value === new Date().getDay())?.[0] || '') ? 'font-semibold text-foreground' : 'text-foreground'}`}
                    >
                      <span className={`text-sm ${hour.day === (Object.entries(DAY_MAP).find(([, value]) => value === new Date().getDay())?.[0] || '') ? 'font-bold text-primary' : ''}`}>{hour.day}</span>
                      <span className={`text-sm ${hour.closed ? 'text-muted-foreground' : ''}`}>
                        {hour.closed ? 'Fechado' : `${hour.open} - ${hour.close}`}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {(company.phone || company.address) && (
            <Card className="h-full animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md [animation-delay:60ms]">
              <CardContent className="flex h-full flex-col gap-4 pb-5 pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                      <MapPin className="h-4 w-4" />
                      {'Localiza\u00E7\u00E3o e Contato'}
                    </h3>
                    {company.address && (
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{company.address}</p>
                    )}
                  </div>
                  {company.phone && (
                    <a href={`tel:${normalizeBrazilPhoneDigits(company.phone)}`} className="shrink-0 text-sm font-medium text-primary hover:text-primary/80">
                      Ligar
                    </a>
                  )}
                </div>

                {company.phone && (
                  <a href={`tel:${normalizeBrazilPhoneDigits(company.phone)}`} className="flex items-center gap-3 text-foreground transition-colors hover:text-primary">
                    <Phone className="h-5 w-5 text-primary" />
                    <span className="text-base font-medium">{formatBrazilPhone(company.phone)}</span>
                  </a>
                )}

                {mapsEmbedUrl && (
                  <div className="min-h-[180px] flex-1 overflow-hidden rounded-md border border-border">
                    <iframe
                      src={mapsEmbedUrl}
                      width="100%"
                      height="100%"
                      className="h-full min-h-[180px]"
                      style={{ border: 0 }}
                      allowFullScreen
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      sandbox="allow-scripts allow-same-origin allow-popups"
                      title={'Localiza\u00E7\u00E3o'}
                    />
                  </div>
                )}

                {googleMapsSearchUrl && (
                  <a
                    href={googleMapsSearchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      Abrir no Google Maps
                    </span>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {acceptedPayments.length > 0 && (
          <Card className="rounded-lg border-none shadow-sm">
            <CardContent className="pb-5 pt-5 text-center">
              <h3 className="mb-4 flex items-center justify-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <CreditCard className="h-4 w-4" />
                Formas de Pagamento
              </h3>
              <div className="flex flex-wrap justify-center gap-2">
                {acceptedPayments.map(([key]) => {
                  const paymentMethod = PAYMENT_LABELS[key];
                  const Icon = paymentMethod?.icon || CreditCard;
                  return (
                    <div key={key} className="flex items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 text-sm">
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="text-foreground">{paymentMethod?.label || key}</span>
                    </div>
                  );
                })}
              </div>
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

      {publicStickyReserveButtonEnabled && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 border-t border-border/50 bg-background/95 px-4 pt-3 shadow-[0_-12px_32px_rgba(0,0,0,0.14)] backdrop-blur-xl md:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto max-w-lg">
            <Button
              className="group animate-attention-pulse-fast w-full gap-2 rounded-lg text-base font-semibold shadow-sm transition-[background-color,box-shadow,transform] duration-150"
              size="lg"
              onClick={handleOpenReservation}
              onMouseEnter={() => void loadReservationModal()}
              onFocus={() => void loadReservationModal()}
            >
              <CalendarCheck className="h-5 w-5 transition-transform duration-150 group-hover:scale-110" />
              Reservar agora
            </Button>
          </div>
        </div>
      )}

      {showReservation && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Carregando...</p>
            </div>
          </div>
        }>
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
            initialDate={null}
            initialPartySize={2}
            onStepChange={(step) => trackStep(step)}
            getTrackingSnapshot={getTrackingSnapshot}
            clearTrackingJourney={clearJourney}
            exitRecoveryEnabled={publicReservationExitPromptEnabled}
          />
        </Suspense>
      )}
    </div>
  );
}
