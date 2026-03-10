import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { Search, Download, Users, CalendarDays, Phone, Mail, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';

interface Lead {
  guest_phone: string;
  guest_name: string;
  guest_email: string | null;
  guest_birthdate: string | null;
  total_reservations: number;
  last_reservation_date: string;
  reservations: any[];
}

export default function Leads() {
  const { companyId } = useCompanySlug();
  const [search, setSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['leads-reservations', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('guest_name, guest_phone, guest_email, guest_birthdate, date, time, party_size, status, occasion, created_at')
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
    enabled: !!companyId,
  });

  const leads = useMemo(() => {
    const map = new Map<string, Lead>();
    reservations.forEach((r: any) => {
      const phone = r.guest_phone;
      if (!map.has(phone)) {
        map.set(phone, {
          guest_phone: phone,
          guest_name: r.guest_name,
          guest_email: r.guest_email,
          guest_birthdate: r.guest_birthdate,
          total_reservations: 0,
          last_reservation_date: r.date,
          reservations: [],
        });
      }
      const lead = map.get(phone)!;
      lead.total_reservations++;
      lead.reservations.push(r);
      // Update name/email with latest if available
      if (r.guest_name) lead.guest_name = r.guest_name;
      if (r.guest_email) lead.guest_email = r.guest_email;
      if (r.guest_birthdate) lead.guest_birthdate = r.guest_birthdate;
    });
    return Array.from(map.values()).sort((a, b) => b.total_reservations - a.total_reservations);
  }, [reservations]);

  const filteredLeads = useMemo(() => {
    if (!search) return leads;
    const q = search.toLowerCase();
    return leads.filter(l =>
      l.guest_name.toLowerCase().includes(q) ||
      l.guest_phone.includes(q) ||
      l.guest_email?.toLowerCase().includes(q)
    );
  }, [leads, search]);

  const exportCSV = () => {
    const headers = ['Nome', 'WhatsApp', 'Email', 'Nascimento', 'Total Reservas', 'Última Reserva'];
    const rows = filteredLeads.map(l => [
      l.guest_name,
      l.guest_phone,
      l.guest_email || '',
      l.guest_birthdate || '',
      l.total_reservations.toString(),
      l.last_reservation_date,
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${filteredLeads.length} leads exportados`);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed': return 'bg-primary text-primary-foreground';
      case 'cancelled': return 'bg-destructive text-destructive-foreground';
      case 'completed': return 'bg-muted text-muted-foreground';
      default: return 'bg-secondary text-secondary-foreground';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Leads</h1>
          <p className="text-sm text-muted-foreground">{leads.length} clientes · {reservations.length} reservas</p>
        </div>
        <Button onClick={exportCSV} variant="outline" className="gap-2" disabled={filteredLeads.length === 0}>
          <Download className="h-4 w-4" /> Exportar CSV
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome, telefone ou email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-center py-12">Carregando...</p>
      ) : filteredLeads.length === 0 ? (
        <p className="text-muted-foreground text-center py-12">Nenhum lead encontrado</p>
      ) : (
        <div className="grid gap-3">
          {filteredLeads.map(lead => (
            <Card key={lead.guest_phone} className="border shadow-sm hover:shadow-md transition-shadow cursor-pointer" onClick={() => setSelectedLead(lead)}>
              <CardContent className="py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                    {lead.guest_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">{lead.guest_name}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{lead.guest_phone}</span>
                      {lead.guest_email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{lead.guest_email}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-right">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{lead.total_reservations}</p>
                    <p className="text-xs text-muted-foreground">reservas</p>
                  </div>
                  <Eye className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Lead Detail Dialog */}
      <Dialog open={!!selectedLead} onOpenChange={() => setSelectedLead(null)}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          {selectedLead && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                    {selectedLead.guest_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p>{selectedLead.guest_name}</p>
                    <p className="text-sm font-normal text-muted-foreground">{selectedLead.guest_phone}</p>
                  </div>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-3 pt-2">
                {selectedLead.guest_email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="text-foreground">{selectedLead.guest_email}</span>
                  </div>
                )}
                {selectedLead.guest_birthdate && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    <span className="text-foreground">{format(new Date(selectedLead.guest_birthdate + 'T12:00:00'), "dd 'de' MMMM", { locale: ptBR })}</span>
                  </div>
                )}
              </div>

              <div className="pt-4">
                <h4 className="text-sm font-semibold text-foreground mb-3">Histórico de Reservas ({selectedLead.total_reservations})</h4>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {selectedLead.reservations.map((r: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-xl border border-border text-sm">
                      <div>
                        <p className="font-medium text-foreground">
                          {format(new Date(r.date + 'T12:00:00'), "dd/MM/yyyy", { locale: ptBR })} às {r.time?.substring(0, 5)}
                        </p>
                        <p className="text-xs text-muted-foreground">{r.party_size} pessoas{r.occasion ? ` · ${r.occasion}` : ''}</p>
                      </div>
                      <Badge className={getStatusColor(r.status)}>
                        {r.status === 'confirmed' ? 'Confirmada' : r.status === 'cancelled' ? 'Cancelada' : r.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
