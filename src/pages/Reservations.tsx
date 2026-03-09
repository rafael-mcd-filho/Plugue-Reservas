import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isToday, isBefore, startOfDay, addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Search, Pencil, Trash2, Loader2, CalendarIcon, Users, Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type ReservationStatus = 'confirmed' | 'cancelled' | 'completed' | 'no-show';

interface Reservation {
  id: string;
  company_id: string;
  table_id: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
  date: string;
  time: string;
  party_size: number;
  status: ReservationStatus;
  occasion: string | null;
  notes: string | null;
  created_at: string;
}

export default function Reservations() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [editDialog, setEditDialog] = useState(false);
  const [editingRes, setEditingRes] = useState<Reservation | null>(null);
  const [editStatus, setEditStatus] = useState<ReservationStatus>('confirmed');
  const [dayModal, setDayModal] = useState<string | null>(null);

  const { data: company } = useQuery({
    queryKey: ['company-for-reservations', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any).select('id').eq('slug', slug!).maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!slug,
  });

  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['reservations', company?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('*')
        .eq('company_id', company.id)
        .order('date', { ascending: true })
        .order('time', { ascending: true });
      if (error) throw error;
      return (data as any[]) as Reservation[];
    },
    enabled: !!company?.id,
  });

  const { data: tables = [] } = useQuery({
    queryKey: ['tables-for-reservations', company?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('id, number')
        .eq('company_id', company.id);
      if (error) throw error;
      return (data as any[]);
    },
    enabled: !!company?.id,
  });

  const tableMap = new Map(tables.map((t: any) => [t.id, t.number]));

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ReservationStatus }) => {
      const { error } = await supabase
        .from('reservations' as any)
        .update({ status, updated_at: new Date().toISOString() } as any)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reservations', company?.id] });
      toast.success('Status atualizado!');
      setEditDialog(false);
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('reservations' as any).delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reservations', company?.id] });
      toast.success('Reserva removida!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  // Sorted chronologically: today/future first, then past
  const sortedReservations = useMemo(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    return [...reservations].sort((a, b) => {
      const aFuture = a.date >= todayStr;
      const bFuture = b.date >= todayStr;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      if (aFuture) {
        // Both future: ascending
        const cmp = a.date.localeCompare(b.date);
        return cmp !== 0 ? cmp : a.time.localeCompare(b.time);
      }
      // Both past: descending
      const cmp = b.date.localeCompare(a.date);
      return cmp !== 0 ? cmp : b.time.localeCompare(a.time);
    });
  }, [reservations]);

  const filtered = useMemo(() => {
    return sortedReservations
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .filter(r => {
        if (dateFrom && r.date < format(dateFrom, 'yyyy-MM-dd')) return false;
        if (dateTo && r.date > format(dateTo, 'yyyy-MM-dd')) return false;
        return true;
      })
      .filter(r =>
        r.guest_name.toLowerCase().includes(search.toLowerCase()) ||
        r.guest_phone.includes(search)
      );
  }, [sortedReservations, statusFilter, dateFrom, dateTo, search]);

  // Monthly cards data
  const monthDays = useMemo(() => {
    const today = startOfDay(new Date());
    const monthEnd = endOfMonth(today);
    const days = eachDayOfInterval({ start: today, end: monthEnd });
    
    return days.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayRes = reservations.filter(r => r.date === dateStr && r.status !== 'cancelled');
      return {
        date: day,
        dateStr,
        reservationCount: dayRes.length,
        totalGuests: dayRes.reduce((sum, r) => sum + r.party_size, 0),
      };
    });
  }, [reservations]);

  const dayModalReservations = useMemo(() => {
    if (!dayModal) return [];
    return reservations
      .filter(r => r.date === dayModal)
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [reservations, dayModal]);

  const openEdit = (r: Reservation) => {
    setEditingRes(r);
    setEditStatus(r.status);
    setEditDialog(true);
  };

  const clearDateFilters = () => {
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Reservas</h1>
        <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reservas</h1>
        <p className="text-muted-foreground mt-1">Gerencie todas as reservas da unidade</p>
      </div>

      <Tabs defaultValue="calendar" className="space-y-6">
        <TabsList>
          <TabsTrigger value="calendar">Calendário</TabsTrigger>
          <TabsTrigger value="list">Lista</TabsTrigger>
        </TabsList>

        {/* Calendar Cards Tab */}
        <TabsContent value="calendar" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Próximos dias de {format(new Date(), 'MMMM yyyy', { locale: ptBR })}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-3">
            {monthDays.map(day => (
              <button
                key={day.dateStr}
                onClick={() => setDayModal(day.dateStr)}
                className={cn(
                  'p-4 rounded-xl border text-left transition-all hover:shadow-md hover:border-primary/50',
                  isToday(day.date)
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-card',
                  day.reservationCount === 0 && 'opacity-60',
                )}
              >
                <div className="text-xs text-muted-foreground uppercase">
                  {format(day.date, 'EEE', { locale: ptBR })}
                </div>
                <div className="text-2xl font-bold text-foreground">
                  {format(day.date, 'dd')}
                </div>
                <div className="text-xs text-muted-foreground mb-3">
                  {format(day.date, 'MMM', { locale: ptBR })}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs">
                    <Clock className="h-3 w-3 text-primary" />
                    <span className="font-medium text-foreground">{day.reservationCount}</span>
                    <span className="text-muted-foreground">reservas</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <Users className="h-3 w-3 text-primary" />
                    <span className="font-medium text-foreground">{day.totalGuests}</span>
                    <span className="text-muted-foreground">pessoas</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </TabsContent>

        {/* List Tab */}
        <TabsContent value="list" className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Buscar por nome ou telefone..." value={search} onChange={e => setSearch(e.target.value)} className="pl-10" />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                <SelectItem value="confirmed">Confirmada</SelectItem>
                <SelectItem value="cancelled">Cancelada</SelectItem>
                <SelectItem value="completed">Concluída</SelectItem>
                <SelectItem value="no-show">Não compareceu</SelectItem>
              </SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !dateFrom && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateFrom ? format(dateFrom, 'dd/MM/yy') : 'De'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("w-[140px] justify-start text-left text-sm", !dateTo && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateTo ? format(dateTo, 'dd/MM/yy') : 'Até'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateTo} onSelect={setDateTo} initialFocus className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>
            {(dateFrom || dateTo) && (
              <Button variant="ghost" size="icon" onClick={clearDateFilters} className="h-10 w-10">
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <Card className="border-none shadow-sm">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-6 py-4 font-medium text-muted-foreground">Data/Hora</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Cliente</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Pessoas</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Mesa</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Ocasião</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Status</th>
                      <th className="px-6 py-4 font-medium text-muted-foreground">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr><td colSpan={7} className="text-center py-12 text-muted-foreground">Nenhuma reserva encontrada</td></tr>
                    ) : filtered.map(r => {
                      const todayStr = format(new Date(), 'yyyy-MM-dd');
                      const isPast = r.date < todayStr;
                      return (
                        <tr key={r.id} className={cn('border-b last:border-0 hover:bg-muted/50 transition-colors', isPast && 'opacity-60')}>
                          <td className="px-6 py-4">
                            <div className={cn('font-medium', r.date === todayStr && 'text-primary')}>
                              {new Date(r.date + 'T00:00:00').toLocaleDateString('pt-BR')}
                            </div>
                            <div className="text-xs text-muted-foreground">{r.time?.slice(0, 5)}</div>
                          </td>
                          <td className="px-6 py-4">
                            <div>{r.guest_name}</div>
                            <div className="text-xs text-muted-foreground">{r.guest_phone}</div>
                          </td>
                          <td className="px-6 py-4">{r.party_size}</td>
                          <td className="px-6 py-4">
                            {r.table_id ? `Mesa ${tableMap.get(r.table_id) ?? '?'}` : '—'}
                          </td>
                          <td className="px-6 py-4 text-xs text-muted-foreground">{r.occasion || '—'}</td>
                          <td className="px-6 py-4"><ReservationStatusBadge status={r.status} /></td>
                          <td className="px-6 py-4">
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => deleteMutation.mutate(r.id)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Status Dialog */}
      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Alterar Status</DialogTitle>
          </DialogHeader>
          {editingRes && (
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                {editingRes.guest_name} — {new Date(editingRes.date + 'T00:00:00').toLocaleDateString('pt-BR')} às {editingRes.time?.slice(0, 5)}
              </p>
              <Select value={editStatus} onValueChange={v => setEditStatus(v as ReservationStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="confirmed">Confirmada</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                  <SelectItem value="completed">Concluída</SelectItem>
                  <SelectItem value="no-show">Não compareceu</SelectItem>
                </SelectContent>
              </Select>
              <Button className="w-full" onClick={() => updateMutation.mutate({ id: editingRes.id, status: editStatus })}
                disabled={updateMutation.isPending}>
                Salvar
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Day Detail Modal */}
      <Dialog open={!!dayModal} onOpenChange={v => { if (!v) setDayModal(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Reservas — {dayModal && format(new Date(dayModal + 'T12:00:00'), "EEEE, dd 'de' MMMM", { locale: ptBR })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            {dayModalReservations.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">Nenhuma reserva para este dia</p>
            ) : dayModalReservations.map(r => (
              <div key={r.id} className="flex items-center gap-4 p-3 rounded-lg border border-border bg-card">
                <div className="text-center min-w-[50px]">
                  <div className="text-lg font-bold text-primary">{r.time?.slice(0, 5)}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">{r.guest_name}</div>
                  <div className="text-xs text-muted-foreground">{r.guest_phone}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Users className="h-3 w-3" />{r.party_size}p
                    </span>
                    {r.table_id && (
                      <span className="text-xs text-muted-foreground">
                        Mesa {tableMap.get(r.table_id) ?? '?'}
                      </span>
                    )}
                    {r.occasion && (
                      <span className="text-xs text-muted-foreground">· {r.occasion}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ReservationStatusBadge status={r.status} />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(r)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
