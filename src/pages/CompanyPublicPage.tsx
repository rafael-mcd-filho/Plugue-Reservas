import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, MapPin, Phone, Instagram, MessageCircle, CalendarCheck,
  LogIn, Clock, CreditCard, Check, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import type { Company } from '@/hooks/useCompanies';
import ReservationModal from '@/components/ReservationModal';
import { useFunnelTracking } from '@/hooks/useFunnelTracking';

const PAYMENT_LABELS: Record<string, string> = {
  dinheiro: 'Dinheiro',
  credito: 'Cartão de crédito',
  debito: 'Cartão de débito',
  pix: 'Pix',
  vale_refeicao: 'Vale refeição',
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
        .from('companies' as any)
        .select('*')
        .eq('slug', slug!)
        .eq('status', 'active')
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Company | null;
    },
    enabled: !!slug,
  });

  const { trackStep } = useFunnelTracking(company?.id);

  // Track page view
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

  const mapsEmbedUrl = company.google_maps_url
    ? company.google_maps_url.includes('/embed')
      ? company.google_maps_url
      : `https://www.google.com/maps?q=${encodeURIComponent(company.address || company.name)}&output=embed`
    : null;

  const openingHours = (company.opening_hours as any[]) || [];
  const paymentMethods = (company.payment_methods as Record<string, boolean>) || {};

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-sidebar text-sidebar-foreground">
        <div className="max-w-2xl mx-auto flex items-center gap-4 px-6 py-5">
          {company.logo_url ? (
            <img src={company.logo_url} alt={company.name} className="h-16 w-16 rounded-full object-cover border-2 border-sidebar-border" />
          ) : (
            <div className="h-16 w-16 rounded-full bg-sidebar-accent flex items-center justify-center text-2xl font-bold text-sidebar-primary shrink-0">
              {company.name.charAt(0)}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold truncate">{company.name}</h1>
            <div className="flex gap-3 mt-1">
              {instagramUrl && (
                <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="text-sidebar-foreground/70 hover:text-sidebar-primary transition-colors">
                  <Instagram className="h-5 w-5" />
                </a>
              )}
              {whatsappUrl && (
                <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="text-sidebar-foreground/70 hover:text-sidebar-primary transition-colors">
                  <MessageCircle className="h-5 w-5" />
                </a>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowLogin(!showLogin)}
            className="ml-auto text-sidebar-foreground/50 hover:text-sidebar-primary transition-colors shrink-0"
            title="Login administrativo"
          >
            <LogIn className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
        {/* CTA Buttons */}
        <div className="space-y-3">
          <Button className="w-full py-6 text-base gap-2 rounded-xl" size="lg" onClick={() => setShowReservation(true)}>
            <CalendarCheck className="h-5 w-5" />
            Reservar Mesa
          </Button>

          {whatsappUrl && (
            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" className="w-full py-5 text-base gap-2 rounded-xl border-primary text-primary hover:bg-primary/5">
                <MessageCircle className="h-5 w-5" />
                Falar pelo WhatsApp
              </Button>
            </a>
          )}
        </div>

        {/* Description + Opening Hours — side by side */}
        {(company.description || openingHours.length > 0) && (
          <div className="grid gap-6 md:grid-cols-2">
            {/* Description */}
            {company.description && (
              <Card className="border-none shadow-sm">
                <CardContent className="pt-5">
                  <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-3">Descrição</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">{company.description}</p>
                </CardContent>
              </Card>
            )}

            {/* Opening Hours */}
            {openingHours.length > 0 && (
              <Card className="border-none shadow-sm">
                <CardContent className="pt-5">
                  <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <Clock className="h-4 w-4" />
                    Horário de Funcionamento
                  </h2>
                  <div className="space-y-1.5">
                    {openingHours.map((h: any) => (
                      <div key={h.day} className="flex justify-between text-sm">
                        <span className="font-medium text-foreground">{h.day}:</span>
                        <span className="text-muted-foreground">
                          {h.closed ? 'Fechado' : `${h.open} às ${h.close}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Payment Methods + Location — side by side */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Payment Methods */}
          {Object.keys(paymentMethods).length > 0 && (
            <Card className="border-none shadow-sm">
              <CardContent className="pt-5">
                <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <CreditCard className="h-4 w-4" />
                  Formas de Pagamento
                </h2>
                <div className="space-y-2">
                  {Object.entries(paymentMethods).map(([key, accepted]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      {accepted ? (
                        <Check className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <X className="h-4 w-4 text-destructive" />
                      )}
                      <span className={accepted ? 'text-foreground' : 'text-muted-foreground line-through'}>
                        {PAYMENT_LABELS[key] || key}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Contact + Address */}
          {(company.phone || company.address) && (
            <Card className="border-none shadow-sm">
              <CardContent className="pt-5 space-y-3">
                <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <MapPin className="h-4 w-4" />
                  Localização
                </h2>
                {company.phone && (
                  <div className="flex items-center gap-3">
                    <Phone className="h-4 w-4 text-primary" />
                    <a href={`tel:${company.phone}`} className="text-sm text-muted-foreground hover:text-foreground">
                      {company.phone}
                    </a>
                  </div>
                )}
                {company.address && (
                  <p className="text-sm text-muted-foreground">{company.address}</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Google Maps */}
        {mapsEmbedUrl && (
          <Card className="border-none shadow-sm overflow-hidden">
            <CardContent className="p-0">
              <iframe
                src={mapsEmbedUrl}
                width="100%"
                height="300"
                style={{ border: 0 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title="Localização"
              />
            </CardContent>
          </Card>
        )}

        {/* Admin Login */}
        {showLogin && (
          <Card className="border-none shadow-sm">
            <CardContent className="pt-5">
              <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-3">Acesso Administrativo</h2>
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
        <p className="text-center text-xs text-muted-foreground pt-4 pb-12">
          Powered by <span className="font-semibold text-primary">ReservaFácil</span>
        </p>
      </div>

      <ReservationModal
        open={showReservation}
        onOpenChange={setShowReservation}
        companyName={company.name}
        openingHours={openingHours}
        reservationDuration={(company as any).reservation_duration ?? 30}
      />
    </div>
  );
}
