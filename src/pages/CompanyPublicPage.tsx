import { lazy, Suspense, useEffect, useState, type SVGProps } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichTextContent } from '@/components/ui/rich-text-editor';
import { useAuth } from '@/contexts/AuthContext';
import { useFunnelTracking } from '@/hooks/useFunnelTracking';
import type { Company } from '@/hooks/useCompanies';
import { supabase } from '@/integrations/supabase/client';
import { getGoogleMapsEmbedUrl } from '@/lib/maps';
import { isValidCompanySlug } from '@/lib/validation';
import { DEFAULT_SYSTEM_NAME } from '@/lib/branding';
import { richTextHasContent } from '@/lib/richText';

const loadReservationModal = () => import('@/components/ReservationModal');
const ReservationModal = lazy(loadReservationModal);
const FunnelDebugPanel = lazy(() => import('@/components/FunnelDebugPanel'));

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

export default function CompanyPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const slugIsValid = isValidCompanySlug(slug);
  const { signIn } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showReservation, setShowReservation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

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
    if (!company) return;

    document.title = `${company.name} - Reservar Mesa`;
    return () => {
      document.title = DEFAULT_SYSTEM_NAME;
    };
  }, [company]);

  useEffect(() => {
    if (company?.id) trackStep('page_view');
  }, [company?.id, trackStep]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    const { error: loginErr } = await signIn(email, password, { slug: slug ?? null });
    setLoginLoading(false);

    if (loginErr) {
      toast.error(
        loginErr.message === 'Invalid login credentials'
          ? 'Email ou senha inv\u00E1lidos'
          : loginErr.message,
      );
      return;
    }

    navigate(`/${slug}/admin`);
  };

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

  const whatsappUrl = company?.whatsapp
    ? `https://wa.me/${company.whatsapp.replace(/\D/g, '')}`
    : null;
  const instagramUrl = company?.instagram
    ? (company.instagram.startsWith('http') ? company.instagram : `https://instagram.com/${company.instagram.replace('@', '')}`)
    : null;
  const googleMapsSearchUrl = getGoogleMapsOpenUrl(company);
  const mapsEmbedUrl = getGoogleMapsEmbedUrl(company?.google_maps_url, company?.address || company?.name || null);
  const openingHours = (((company?.opening_hours as any[]) || [])) as OpeningHour[];
  const paymentMethods = (company?.payment_methods as Record<string, boolean>) || {};
  const acceptedPayments = Object.entries(paymentMethods).filter(([, accepted]) => accepted);
  const customPublicPageEnabled = (company as any)?.custom_public_page_enabled ?? true;
  const publicWhatsappButtonEnabled = (company as any)?.show_public_whatsapp_button ?? true;
  const showCustomLogo = customPublicPageEnabled && !!company?.logo_url;
  const showDescription = customPublicPageEnabled && richTextHasContent(company?.description);
  const showWhatsappButton = customPublicPageEnabled && publicWhatsappButtonEnabled && !!whatsappUrl;
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
  const todayHours = getOpeningHourForDate(new Date());

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
      const contactWhatsapp = companyStatus.whatsapp
        ? `https://wa.me/${companyStatus.whatsapp.replace(/\D/g, '')}`
        : null;

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
                  href={`tel:${companyStatus.phone}`}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-white transition-colors hover:bg-white/20"
                >
                  <Phone className="h-4 w-4" />
                  Ligar: {companyStatus.phone}
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
    <div className="min-h-screen bg-secondary pb-28 md:pb-0">
      <div style={{ background: '#130D06' }} className="text-primary-foreground">
        <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3 md:max-w-5xl">
          {showCustomLogo ? (
            <img
              src={company.logo_url}
              alt={company.name}
              className="h-9 w-9 shrink-0 rounded-full border border-white/20 object-cover"
            />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
              {company.name.charAt(0)}
            </div>
          )}
          <span className="text-sm font-semibold text-white/90 truncate">{company.name}</span>
        </div>
      </div>

      <div
        className="relative overflow-hidden px-4 pb-8 pt-5 text-primary-foreground md:pb-14 md:pt-10"
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

        <div className="relative z-10 mx-auto max-w-lg md:grid md:max-w-5xl md:grid-cols-[minmax(0,1fr)_22rem] md:gap-10">
          <div className="space-y-4 animate-slide-up">
            {googleMapsSearchUrl && (
              <a
                href={googleMapsSearchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-colors hover:bg-white/15"
              >
                <Star className="h-3.5 w-3.5 fill-current text-amber-300" />
                <span>Google 4,9 / 5</span>
              </a>
            )}

            <div>
              <div className="flex items-center gap-3">
                {instagramUrl && (
                  <a
                    href={instagramUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Instagram"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-pink-200 transition-colors hover:bg-white/15 hover:text-white"
                  >
                    <InstagramIcon className="h-4 w-4" />
                  </a>
                )}
                <h2 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl">{company.name}</h2>
              </div>
              {showDescription && (
                <RichTextContent
                  value={company.description}
                  className="mt-3 max-h-36 max-w-xl overflow-hidden text-sm text-primary-foreground/75 md:max-h-44 md:text-base [&_h1]:text-2xl [&_h2]:text-xl [&_p]:text-sm md:[&_p]:text-base"
                />
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {todayHours && !todayHours.closed && (
                <Badge variant="secondary" className="gap-1 border-none bg-primary-foreground/10 text-xs text-primary-foreground/85 backdrop-blur-sm">
                  <Clock className="h-3 w-3" />
                  Hoje até {todayHours.close}
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-5 space-y-3 animate-slide-up [animation-delay:80ms] md:mt-0 md:self-end">
            <Button
              className="group w-full gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-200 hover:bg-primary/90"
              size="lg"
              onMouseEnter={() => void loadReservationModal()}
              onFocus={() => void loadReservationModal()}
              onClick={handleOpenReservation}
            >
              <CalendarCheck className="h-5 w-5 transition-transform duration-200 group-hover:scale-110" />
              Reservar agora
            </Button>

            {showWhatsappButton && (
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="block">
                <Button
                  variant="secondary"
                  className="w-full gap-2 rounded-lg border-none bg-background text-base font-semibold text-foreground shadow-sm transition-[background-color,box-shadow,transform] duration-200 hover:bg-background/90"
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

      <div className="mx-auto max-w-lg space-y-4 px-4 py-5 md:max-w-5xl md:space-y-6 md:py-6">
        <div className="grid gap-4 md:grid-cols-2 md:items-start md:gap-6">
          {openingHours.length > 0 && (
            <Card className="animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md">
              <CardContent className="pb-5 pt-5">
                <div>
                  <div>
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                      <Clock className="h-4 w-4" />
                      {'Hor\u00E1rio de Funcionamento'}
                    </h3>
                    {todayHours && (
                      <p className="mt-2 text-sm text-foreground">
                        {todayHours.closed ? 'Hoje est\u00E1 fechado.' : `Hoje: ${todayHours.open} - ${todayHours.close}`}
                      </p>
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
            <Card className="animate-fade-in rounded-lg border-none shadow-sm transition-shadow duration-200 hover:shadow-md [animation-delay:60ms]">
              <CardContent className="space-y-4 pb-5 pt-5">
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
                    <a href={`tel:${company.phone}`} className="shrink-0 text-sm font-medium text-primary hover:text-primary/80">
                      Ligar
                    </a>
                  )}
                </div>

                {company.phone && (
                  <a href={`tel:${company.phone}`} className="flex items-center gap-3 text-foreground transition-colors hover:text-primary">
                    <Phone className="h-5 w-5 text-primary" />
                    <span className="text-base font-medium">{company.phone}</span>
                  </a>
                )}

                {mapsEmbedUrl && (
                  <div className="overflow-hidden rounded-md border border-border">
                    <iframe
                      src={mapsEmbedUrl}
                      width="100%"
                      height="180"
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

        {showLogin && (
          <Card className="rounded-lg border-none shadow-sm md:mx-auto md:max-w-md">
            <CardContent className="pb-5 pt-5">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Acesso administrativo</h3>
              <form onSubmit={handleLogin} className="space-y-3">
                <div>
                  <Label htmlFor="company-login-email" className="text-xs">Email</Label>
                  <Input
                    id="company-login-email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="admin@empresa.com"
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="company-login-password" className="text-xs">Senha</Label>
                  <Input
                    id="company-login-password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="********"
                    autoComplete="current-password"
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loginLoading}>
                  {loginLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Entrar
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col items-center gap-2 pb-4 pt-1 text-center">
          <button
            type="button"
            onClick={() => setShowLogin((current) => !current)}
            aria-expanded={showLogin}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {showLogin ? 'Ocultar acesso administrativo' : 'Acesso administrativo'}
          </button>
          <p className="text-xs text-muted-foreground">
            {'Powered by '}
            <span className="font-semibold text-primary">{DEFAULT_SYSTEM_NAME}</span>
          </p>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 bg-background/95 px-4 pb-safe pt-3 backdrop-blur-xl md:hidden" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <div className="mx-auto max-w-lg">
          <Button
            className="group w-full gap-2 rounded-lg text-base font-semibold shadow-sm transition-[background-color,box-shadow,transform] duration-200"
            size="lg"
            onClick={handleOpenReservation}
            onMouseEnter={() => void loadReservationModal()}
          >
            <CalendarCheck className="h-5 w-5 transition-transform duration-200 group-hover:scale-110" />
            Reservar agora
          </Button>
        </div>
      </div>

      <Suspense fallback={null}>
        <FunnelDebugPanel />
      </Suspense>

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
            openingHours={openingHours}
            reservationDuration={(company as any).reservation_duration ?? 30}
            maxGuestsPerSlot={(company as any).max_guests_per_slot ?? 0}
            initialDate={null}
            initialPartySize={2}
            onStepChange={(step) => trackStep(step)}
            getTrackingSnapshot={getTrackingSnapshot}
            clearTrackingJourney={clearJourney}
          />
        </Suspense>
      )}
    </div>
  );
}
