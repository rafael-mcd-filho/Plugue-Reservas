import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, MapPin, Phone, Instagram, MessageCircle, CalendarCheck,
  LogIn, Clock, CreditCard, Star, FileText, ExternalLink, Users,
  Banknote, Smartphone, QrCode, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import type { Company } from '@/hooks/useCompanies';
import ReservationModal from '@/components/ReservationModal';
import { useFunnelTracking } from '@/hooks/useFunnelTracking';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const PAYMENT_LABELS: Record<string, { label: string; icon: typeof CreditCard }> = {
  dinheiro: { label: 'Dinheiro', icon: Banknote },
  credito: { label: 'Crédito', icon: CreditCard },
  debito: { label: 'Débito', icon: CreditCard },
  pix: { label: 'Pix', icon: QrCode },
  vale_refeicao: { label: 'Vale Refeição', icon: Wallet },
};

const DAY_MAP: Record<string, number> = {
  'Dom': 0, 'Seg': 1, 'Ter': 2, 'Qua': 3, 'Qui': 4, 'Sex': 5, 'Sáb': 6,
};

export default function CompanyPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [showLogin, setShowLogin] = useState(false);
  const [showReservation, setShowReservation] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const { data: company, isLoading, error } = useQuery({
    queryKey: ['company-public', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies_public' as any)
        .select('*')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Company | null;
    },
    enabled: !!slug,
  });

  const { trackStep } = useFunnelTracking(company?.id);

  // SEO meta tags
  useEffect(() => {
    if (!company) return;
    document.title = `${company.name} — Reservar Mesa`;
    
    const setMeta = (name: string, content: string, attr = 'name') => {
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    
    const desc = company.description || `Reserve sua mesa no ${company.name}. Confirmação imediata.`;
    setMeta('description', desc);
    setMeta('og:title', company.name, 'property');
    setMeta('og:description', desc, 'property');
    setMeta('og:type', 'website', 'property');
    setMeta('og:url', window.location.href, 'property');
    if (company.logo_url) setMeta('og:image', company.logo_url, 'property');
    
    return () => { document.title = 'ReservaFácil'; };
  }, [company]);

  useEffect(() => {
    if (company?.id) trackStep('page_view');
  }, [company?.id, trackStep]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
    setLoginLoading(false);
    if (loginErr) {
      toast.error('Email ou senha inválidos');
      return;
    }
    navigate(`/${slug}/admin`);
  };

  const todayDayName = useMemo(() => {
    const dayIndex = new Date().getDay();
    return Object.entries(DAY_MAP).find(([, v]) => v === dayIndex)?.[0] || '';
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !company) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background gap-4">
        <h1 className="text-2xl font-bold text-foreground">Página não encontrada</h1>
        <p className="text-muted-foreground">Este restaurante não existe ou está temporariamente indisponível.</p>
      </div>
    );
  }

  const whatsappUrl = company.whatsapp
    ? `https://wa.me/${company.whatsapp.replace(/\D/g, '')}`
    : null;

  const instagramUrl = company.instagram
    ? (company.instagram.startsWith('http') ? company.instagram : `https://instagram.com/${company.instagram.replace('@', '')}`)
    : null;

  const googleMapsSearchUrl = company.google_maps_url
    ? company.google_maps_url
    : company.address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(company.address)}`
      : null;

  const mapsEmbedUrl = company.google_maps_url
    ? company.google_maps_url.includes('/embed')
      ? company.google_maps_url
      : `https://www.google.com/maps?q=${encodeURIComponent(company.address || company.name)}&output=embed`
    : company.address
      ? `https://www.google.com/maps?q=${encodeURIComponent(company.address)}&output=embed`
      : null;

  const openingHours = (company.opening_hours as any[]) || [];
  const paymentMethods = (company.payment_methods as Record<string, boolean>) || {};
  const acceptedPayments = Object.entries(paymentMethods).filter(([, accepted]) => accepted);

  // Check if today is open
  const todayHours = openingHours.find(h => h.day === todayDayName);
  const isOpenToday = todayHours && !todayHours.closed;

  return (
    <div className="min-h-screen bg-secondary pb-24 md:pb-0">
      {/* Top bar */}
      <div style={{ background: '#130D06' }} className="text-primary-foreground">
        <div className="max-w-lg md:max-w-5xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            {company.logo_url ? (
              <img src={company.logo_url} alt={company.name} className="h-10 w-10 rounded-full object-cover border-2 border-primary" />
            ) : (
              <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center text-lg font-bold text-primary-foreground shrink-0">
                {company.name.charAt(0)}
              </div>
            )}
            <div>
              <h1 className="text-sm font-bold">{company.name}</h1>
              <div className="flex gap-2 mt-0.5">
                {instagramUrl && (
                  <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="text-primary-foreground/60 hover:text-primary transition-colors">
                    <Instagram className="h-4 w-4" />
                  </a>
                )}
                {whatsappUrl && (
                  <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="text-primary-foreground/60 hover:text-primary transition-colors">
                    <MessageCircle className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={() => setShowLogin(!showLogin)}
            className="text-primary-foreground/30 hover:text-primary-foreground/60 transition-colors"
            aria-label="Login administrativo"
          >
            <LogIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Hero */}
      <div
        className="relative text-primary-foreground px-4 pt-6 pb-10 md:pt-12 md:pb-16 md:rounded-none rounded-b-3xl overflow-hidden"
        style={{ background: 'linear-gradient(170deg, #130D06 0%, #1C1108 50%, #2E1800 100%)' }}
      >
        {/* Radial glow — center warm */}
        <div
          className="absolute inset-0 rounded-b-3xl md:rounded-none pointer-events-none"
          style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 60%, rgba(232,105,10,0.18) 0%, transparent 70%)' }}
        />
        {/* Secondary glow — top-left accent */}
        <div
          className="absolute inset-0 rounded-b-3xl md:rounded-none pointer-events-none"
          style={{ background: 'radial-gradient(ellipse 40% 40% at 20% 30%, rgba(232,105,10,0.08) 0%, transparent 60%)' }}
        />
        {/* Bottom warm edge */}
        <div
          className="absolute bottom-0 left-0 right-0 h-32 rounded-b-3xl md:rounded-none pointer-events-none"
          style={{ background: 'linear-gradient(to top, rgba(46,24,0,0.6) 0%, transparent 100%)' }}
        />
        {/* Subtle noise texture overlay */}
        <div
          className="absolute inset-0 rounded-b-3xl md:rounded-none pointer-events-none opacity-[0.03]"
          style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")', backgroundSize: '128px 128px' }}
        />

        <div className="max-w-lg md:max-w-5xl mx-auto relative z-10 md:flex md:items-center md:gap-16">
          {/* Hero text */}
          <div className="space-y-5 md:flex-1">
            {/* Rating */}
            <Badge className="bg-primary text-primary-foreground border-none gap-1 text-xs font-semibold px-2.5 py-1 shadow-lg shadow-primary/20">
              <Star className="h-3 w-3 fill-current" /> 4.8 · 127 avaliações
            </Badge>

            <div>
              <h2 className="text-2xl md:text-5xl font-bold tracking-tight leading-tight">{company.name}</h2>
              {company.description && (
                <p className="text-sm md:text-lg text-primary-foreground/60 mt-2 leading-relaxed max-w-xl">{company.description}</p>
              )}
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-2">
              {company.address && (
                <Badge variant="secondary" className="bg-primary-foreground/10 text-primary-foreground/80 border-none text-xs gap-1 backdrop-blur-sm">
                  <MapPin className="h-3 w-3" /> {company.address.split(',')[0]?.split(' – ')[0]?.split('-')[0]?.trim()}
                </Badge>
              )}
              <Badge variant="secondary" className="bg-primary-foreground/10 text-primary-foreground/80 border-none text-xs gap-1 backdrop-blur-sm">
                <Users className="h-3 w-3" /> Até 12 pessoas
              </Badge>
              <Badge variant="secondary" className="bg-primary text-primary-foreground border-none text-xs gap-1">
                <CalendarCheck className="h-3 w-3" /> Confirmação imediata
              </Badge>
            </div>
          </div>

          {/* CTA Buttons — stacked on mobile, side panel on desktop */}
          <div className="space-y-3 pt-6 md:pt-0 md:w-80 md:shrink-0">
            <Button
              className="w-full py-6 text-base gap-2 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-xl shadow-primary/30"
              size="lg"
              onClick={() => setShowReservation(true)}
            >
              <CalendarCheck className="h-5 w-5" />
              Reservar Mesa
            </Button>

            {whatsappUrl && (
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="block">
                <Button
                  variant="secondary"
                  className="w-full py-6 text-base gap-2 rounded-full bg-background text-foreground hover:bg-background/90 font-semibold shadow-md border-none"
                  size="lg"
                >
                  <MessageCircle className="h-5 w-5 text-green-600" />
                  Falar pelo WhatsApp
                </Button>
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Content cards */}
      <div className="max-w-lg md:max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* About — full width */}
        {company.description && (
          <Card className="border-none shadow-sm rounded-2xl">
            <CardContent className="pt-5 pb-5">
              <h3 className="text-xs font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <FileText className="h-4 w-4" /> Sobre o Restaurante
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed italic">{company.description}</p>
            </CardContent>
          </Card>
        )}

        {/* Two columns: Hours + Location */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          {/* Opening Hours */}
          {openingHours.length > 0 && (
            <Card className="border-none shadow-sm rounded-2xl">
              <CardContent className="pt-5 pb-5">
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-1.5">
                  <Clock className="h-4 w-4" /> Horário de Funcionamento
                </h3>
                <div className="space-y-0">
                  {openingHours.map((h: any) => {
                    const isToday = h.day === todayDayName;
                    return (
                      <div
                        key={h.day}
                        className={`flex items-center justify-between py-2.5 border-b border-border/50 last:border-b-0 ${isToday ? 'font-semibold text-foreground' : 'text-foreground'}`}
                      >
                        <span className={`text-sm ${isToday ? 'text-primary font-bold' : ''}`}>{h.day}</span>
                        <div className="flex items-center gap-2">
                          <span className={`text-sm ${h.closed ? 'text-muted-foreground' : ''}`}>
                            {h.closed ? 'Fechado' : `${h.open} – ${h.close}`}
                          </span>
                          {isToday && !h.closed && (
                            <div className="flex items-center gap-1.5">
                              <Badge className="bg-primary text-primary-foreground border-none text-[10px] px-1.5 py-0">HOJE</Badge>
                              <Badge variant="outline" className="border-primary text-primary text-[10px] px-1.5 py-0">Aberto</Badge>
                            </div>
                          )}
                          {isToday && h.closed && (
                            <Badge variant="outline" className="border-destructive text-destructive text-[10px] px-1.5 py-0">Fechado</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Location & Contact */}
          {(company.phone || company.address) && (
            <Card className="border-none shadow-sm rounded-2xl">
              <CardContent className="pt-5 pb-5 space-y-4">
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <MapPin className="h-4 w-4" /> Localização & Contato
                </h3>
                {company.phone && (
                  <a href={`tel:${company.phone}`} className="flex items-center gap-3 text-foreground hover:text-primary transition-colors">
                    <Phone className="h-5 w-5 text-primary" />
                    <span className="text-base font-medium">{company.phone}</span>
                  </a>
                )}
                {company.address && (
                  <p className="text-sm text-muted-foreground leading-relaxed">{company.address}</p>
                )}

                {mapsEmbedUrl && (
                  <div className="rounded-xl overflow-hidden border border-border">
                    <iframe
                      src={mapsEmbedUrl}
                      width="100%"
                      height="180"
                      style={{ border: 0 }}
                      allowFullScreen
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      title="Localização"
                    />
                  </div>
                )}

                {googleMapsSearchUrl && (
                  <a
                    href={googleMapsSearchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between w-full py-2.5 px-3 rounded-xl border border-border hover:bg-muted/50 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" /> Abrir no Google Maps
                    </span>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Payment Methods — centered, full width */}
        {acceptedPayments.length > 0 && (
          <Card className="border-none shadow-sm rounded-2xl">
            <CardContent className="pt-5 pb-5">
              <h3 className="text-xs font-semibold text-primary uppercase tracking-wider mb-4 flex items-center gap-1.5 md:justify-center">
                <CreditCard className="h-4 w-4" /> Formas de Pagamento
              </h3>
              <div className="flex flex-wrap gap-2 md:gap-3 md:justify-center">
                {acceptedPayments.map(([key]) => {
                  const pm = PAYMENT_LABELS[key];
                  const Icon = pm?.icon || CreditCard;
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-background text-sm"
                    >
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-foreground">{pm?.label || key}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Admin Login */}
        {showLogin && (
          <Card className="border-none shadow-sm rounded-2xl md:max-w-md md:mx-auto">
            <CardContent className="pt-5 pb-5">
              <h3 className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">Acesso Administrativo</h3>
              <form onSubmit={handleLogin} className="space-y-3">
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@empresa.com" required />
                </div>
                <div>
                  <Label className="text-xs">Senha</Label>
                  <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
                </div>
                <Button type="submit" className="w-full" disabled={loginLoading}>
                  {loginLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Entrar
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground pt-2 pb-4">
          Powered by <span className="font-semibold text-primary">ReservaFácil</span>
        </p>
      </div>

      {/* Sticky bottom CTA — mobile only */}
      <div className="fixed bottom-0 left-0 right-0 bg-background/80 backdrop-blur-lg border-t border-border px-4 py-3 z-50 md:hidden">
        <div className="max-w-lg mx-auto">
          <Button
            className="w-full py-5 text-base gap-2 rounded-2xl font-semibold"
            size="lg"
            onClick={() => setShowReservation(true)}
          >
            <CalendarCheck className="h-5 w-5" />
            Reservar Mesa
          </Button>
        </div>
      </div>

      <ReservationModal
        open={showReservation}
        onOpenChange={setShowReservation}
        companyId={company.id}
        companyName={company.name}
        openingHours={openingHours}
        reservationDuration={(company as any).reservation_duration ?? 30}
        maxGuestsPerSlot={(company as any).max_guests_per_slot ?? 0}
        onStepChange={(step) => trackStep(step)}
      />
    </div>
  );
}
