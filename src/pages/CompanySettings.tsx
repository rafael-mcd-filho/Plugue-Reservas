import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Save, Clock, CreditCard, MapPin, Instagram, MessageCircle, Phone, Globe } from 'lucide-react';
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
  { key: 'dinheiro', label: 'Dinheiro' },
  { key: 'credito', label: 'Cartão de crédito' },
  { key: 'debito', label: 'Cartão de débito' },
  { key: 'pix', label: 'Pix' },
  { key: 'vale_refeicao', label: 'Vale refeição' },
];

export default function CompanySettings() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();

  const { data: company, isLoading } = useQuery({
    queryKey: ['company-settings', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('*')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Company | null;
    },
    enabled: !!slug,
  });

  const [hours, setHours] = useState<OpeningHour[]>(DEFAULT_HOURS);
  const [payments, setPayments] = useState<Record<string, boolean>>({
    dinheiro: true, credito: true, debito: true, pix: true, vale_refeicao: false,
  });
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [reservationDuration, setReservationDuration] = useState(30);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (company && !initialized) {
      setHours((company.opening_hours as OpeningHour[]) || DEFAULT_HOURS);
      setPayments((company.payment_methods as Record<string, boolean>) || payments);
      setDescription(company.description || '');
      setAddress(company.address || '');
      setPhone(company.phone || '');
      setInstagram(company.instagram || '');
      setWhatsapp(company.whatsapp || '');
      setGoogleMapsUrl(company.google_maps_url || '');
      setReservationDuration((company as any).reservation_duration ?? 30);
      setInitialized(true);
    }
  }, [company, initialized]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!company) throw new Error('Empresa não encontrada');
      const { error } = await supabase
        .from('companies' as any)
        .update({
          opening_hours: hours,
          payment_methods: payments,
          description,
          address,
          phone,
          instagram,
          whatsapp,
          google_maps_url: googleMapsUrl,
          reservation_duration: reservationDuration,
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-settings', slug] });
      qc.invalidateQueries({ queryKey: ['company-public', slug] });
      toast.success('Configurações salvas!');
    },
    onError: (err: any) => toast.error(`Erro ao salvar: ${err.message}`),
  });

  const updateHour = (index: number, field: keyof OpeningHour, value: string | boolean) => {
    setHours(prev => prev.map((h, i) => i === index ? { ...h, [field]: value } : h));
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
          <p className="text-muted-foreground mt-1">Configurações da unidade {company?.name}</p>
        </div>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-2">
          <Save className="h-4 w-4" />
          Salvar Tudo
        </Button>
      </div>

      <Tabs defaultValue="hours" className="space-y-6">
        <TabsList>
          <TabsTrigger value="hours" className="gap-2"><Clock className="h-4 w-4" /> Horários</TabsTrigger>
          <TabsTrigger value="payments" className="gap-2"><CreditCard className="h-4 w-4" /> Pagamentos</TabsTrigger>
          <TabsTrigger value="info" className="gap-2"><Globe className="h-4 w-4" /> Informações</TabsTrigger>
          <TabsTrigger value="location" className="gap-2"><MapPin className="h-4 w-4" /> Localização</TabsTrigger>
        </TabsList>

        {/* Opening Hours */}
        <TabsContent value="hours">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Clock className="h-5 w-5 text-primary" /> Horário de Funcionamento</CardTitle>
              <CardDescription>Defina os horários de abertura e fechamento para cada dia</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {hours.map((h, i) => (
                  <div key={h.day} className="flex items-center gap-4">
                    <span className="font-medium text-sm w-10">{h.day}</span>
                    <Switch
                      checked={!h.closed}
                      onCheckedChange={(checked) => updateHour(i, 'closed', !checked)}
                    />
                    {!h.closed ? (
                      <>
                        <Input
                          type="time"
                          value={h.open}
                          onChange={e => updateHour(i, 'open', e.target.value)}
                          className="w-32"
                        />
                        <span className="text-muted-foreground text-sm">às</span>
                        <Input
                          type="time"
                          value={h.close}
                          onChange={e => updateHour(i, 'close', e.target.value)}
                          className="w-32"
                        />
                      </>
                    ) : (
                      <span className="text-muted-foreground text-sm">Fechado</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Reservation Duration */}
              <div className="mt-6 pt-6 border-t border-border">
                <Label className="text-sm font-medium">Duração de cada reserva (minutos)</Label>
                <p className="text-xs text-muted-foreground mb-2">Define o intervalo entre os horários disponíveis para reserva</p>
                <Select value={String(reservationDuration)} onValueChange={v => setReservationDuration(Number(v))}>
                  <SelectTrigger className="w-40">
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
        </TabsContent>

        {/* Payment Methods */}
        <TabsContent value="payments">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /> Formas de Pagamento</CardTitle>
              <CardDescription>Selecione quais formas de pagamento são aceitas</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {PAYMENT_OPTIONS.map(opt => (
                  <div key={opt.key} className="flex items-center justify-between max-w-sm">
                    <Label htmlFor={`pay-${opt.key}`} className="cursor-pointer">{opt.label}</Label>
                    <Switch
                      id={`pay-${opt.key}`}
                      checked={!!payments[opt.key]}
                      onCheckedChange={(checked) => setPayments(prev => ({ ...prev, [opt.key]: checked }))}
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Info */}
        <TabsContent value="info">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base">Informações da Empresa</CardTitle>
              <CardDescription>Dados exibidos na página pública</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-lg">
              <div>
                <Label>Descrição</Label>
                <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Breve descrição do restaurante..." rows={4} />
              </div>
              <div>
                <Label className="flex items-center gap-1.5"><Phone className="h-4 w-4" /> Telefone</Label>
                <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(84) 3333-4444" />
              </div>
              <div>
                <Label className="flex items-center gap-1.5"><Instagram className="h-4 w-4" /> Instagram</Label>
                <Input value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="@restaurante" />
              </div>
              <div>
                <Label className="flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> WhatsApp</Label>
                <Input value={whatsapp} onChange={e => setWhatsapp(e.target.value)} placeholder="5584999999999" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Location */}
        <TabsContent value="location">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><MapPin className="h-5 w-5 text-primary" /> Localização</CardTitle>
              <CardDescription>Endereço e mapa exibidos na página pública</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-lg">
              <div>
                <Label>Endereço completo</Label>
                <Textarea value={address} onChange={e => setAddress(e.target.value)} placeholder="Rua, número, bairro, cidade - UF" rows={2} />
              </div>
              <div>
                <Label>Link do Google Maps (embed)</Label>
                <Input value={googleMapsUrl} onChange={e => setGoogleMapsUrl(e.target.value)} placeholder="https://www.google.com/maps/embed?pb=..." />
                <p className="text-xs text-muted-foreground mt-1">
                  No Google Maps, clique em "Compartilhar" → "Incorporar mapa" e cole o link do src do iframe aqui.
                </p>
              </div>
              {googleMapsUrl && (
                <div className="rounded-lg overflow-hidden border">
                  <iframe
                    src={googleMapsUrl.includes('/embed') ? googleMapsUrl : `https://www.google.com/maps?q=${encodeURIComponent(address || 'Brasil')}&output=embed`}
                    width="100%"
                    height="250"
                    style={{ border: 0 }}
                    allowFullScreen
                    loading="lazy"
                    title="Preview do mapa"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
