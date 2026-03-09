import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, MapPin, Phone, Instagram, MessageCircle, CalendarCheck, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import type { Company } from '@/hooks/useCompanies';

export default function CompanyPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [showLogin, setShowLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoginLoading(false);
    if (error) {
      toast.error('Email ou senha inválidos');
      return;
    }
    navigate(`/${slug}/admin`);
  };

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

  // Extract Google Maps embed URL from a regular maps link
  const mapsEmbedUrl = company.google_maps_url
    ? company.google_maps_url.includes('/embed')
      ? company.google_maps_url
      : `https://www.google.com/maps?q=${encodeURIComponent(company.address || company.name)}&output=embed`
    : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-sidebar text-sidebar-foreground">
        <div className="max-w-lg mx-auto flex items-center gap-4 px-6 py-5">
          {company.logo_url ? (
            <img src={company.logo_url} alt={company.name} className="h-16 w-16 rounded-full object-cover border-2 border-sidebar-border" />
          ) : (
            <div className="h-16 w-16 rounded-full bg-sidebar-accent flex items-center justify-center text-2xl font-bold text-sidebar-primary">
              {company.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold">{company.name}</h1>
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
            className="ml-auto text-sidebar-foreground/50 hover:text-sidebar-primary transition-colors"
            title="Login administrativo"
          >
            <LogIn className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-lg mx-auto px-6 py-8 space-y-6">
        {/* CTA: Reservar Mesa */}
        <Button className="w-full py-6 text-base gap-2 rounded-xl" size="lg">
          <CalendarCheck className="h-5 w-5" />
          Reservar Mesa
        </Button>

        {/* WhatsApp button */}
        {whatsappUrl && (
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" className="w-full py-5 text-base gap-2 rounded-xl border-primary text-primary hover:bg-primary/5 mt-3">
              <MessageCircle className="h-5 w-5" />
              Falar pelo WhatsApp
            </Button>
          </a>
        )}

        {/* Description */}
        {company.description && (
          <Card className="border-none shadow-sm">
            <CardContent className="pt-5">
              <h2 className="text-sm font-semibold text-primary uppercase tracking-wider mb-2">Descrição</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{company.description}</p>
            </CardContent>
          </Card>
        )}

        {/* Contact info */}
        {(company.phone || company.address) && (
          <Card className="border-none shadow-sm">
            <CardContent className="pt-5 space-y-3">
              {company.phone && (
                <div className="flex items-center gap-3">
                  <Phone className="h-4 w-4 text-primary" />
                  <a href={`tel:${company.phone}`} className="text-sm text-muted-foreground hover:text-foreground">
                    {company.phone}
                  </a>
                </div>
              )}
              {company.address && (
                <div className="flex items-start gap-3">
                  <MapPin className="h-4 w-4 text-primary mt-0.5" />
                  <p className="text-sm text-muted-foreground">{company.address}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Google Maps */}
        {mapsEmbedUrl && (
          <Card className="border-none shadow-sm overflow-hidden">
            <CardContent className="p-0">
              <h2 className="text-sm font-semibold text-primary uppercase tracking-wider px-5 pt-5 mb-3">
                <MapPin className="h-4 w-4 inline mr-1" />
                Localização
              </h2>
              <iframe
                src={mapsEmbedUrl}
                width="100%"
                height="280"
                style={{ border: 0 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title="Localização"
              />
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground pt-4">
          Powered by <span className="font-semibold text-primary">ReservaFácil</span>
        </p>
      </div>
    </div>
  );
}
