import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Users, Plus, Pencil, Trash2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';

type TableStatus = 'available' | 'occupied' | 'reserved' | 'maintenance';

interface RestaurantTable {
  id: string;
  company_id: string;
  number: number;
  capacity: number;
  section: string;
  status: TableStatus;
}

interface TodayReservation {
  id: string;
  table_id: string;
  guest_name: string;
  time: string;
  duration_minutes: number;
  party_size: number;
  status: string;
}

const STATUS_COLORS: Record<TableStatus, string> = {
  available: 'border-accent bg-accent/10',
  occupied: 'border-primary bg-primary/10',
  reserved: 'border-yellow-500 bg-yellow-500/10',
  maintenance: 'border-muted-foreground/30 bg-muted opacity-60',
};

const STATUS_LABELS: Record<TableStatus, string> = {
  available: 'Disponível',
  occupied: 'Ocupada',
  reserved: 'Reservada',
  maintenance: 'Manutenção',
};

const STATUS_DOT: Record<TableStatus, string> = {
  available: 'bg-accent',
  occupied: 'bg-primary',
  reserved: 'bg-yellow-500',
  maintenance: 'bg-muted-foreground/40',
};

const SECTIONS = ['salão', 'varanda', 'privativo'] as const;
const SECTION_LABELS: Record<string, string> = { salão: 'Salão Principal', varanda: 'Varanda', privativo: 'Área Privativa' };

export default function TableMap() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<RestaurantTable | null>(null);
  const [form, setForm] = useState({ number: '', capacity: '2', section: 'salão' as string });

  // Fetch company
  const { data: company } = useQuery({
    queryKey: ['company-for-tables', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('id, name')
        .eq('slug', slug!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!slug,
  });

  // Fetch tables
  const { data: tables = [], isLoading } = useQuery({
    queryKey: ['restaurant-tables', company?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('*')
        .eq('company_id', company.id)
        .order('number', { ascending: true });
      if (error) throw error;
      return (data as any[]) as RestaurantTable[];
    },
    enabled: !!company?.id,
  });

  // Fetch today's reservations for real-time status
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayReservations = [] } = useQuery({
    queryKey: ['today-reservations', company?.id, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('id, table_id, guest_name, time, duration_minutes, party_size, status')
        .eq('company_id', company.id)
        .eq('date', today)
        .in('status', ['confirmed', 'pending']);
      if (error) throw error;
      return (data as any[]) as TodayReservation[];
    },
    enabled: !!company?.id,
    refetchInterval: 30000, // refresh every 30s
  });

  // Compute real-time status based on current time + reservations
  const tableStatusMap = useMemo(() => {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const map: Record<string, { status: TableStatus; reservation?: TodayReservation }> = {};

    for (const table of tables) {
      // Check if table is in maintenance (from DB status)
      if (table.status === 'maintenance') {
        map[table.id] = { status: 'maintenance' };
        continue;
      }

      const tableRes = todayReservations.filter(r => r.table_id === table.id);

      // Find currently active reservation (occupied)
      const activeRes = tableRes.find(r => {
        const [h, m] = r.time.split(':').map(Number);
        const startMin = h * 60 + m;
        const endMin = startMin + (r.duration_minutes || 30);
        return nowMinutes >= startMin && nowMinutes < endMin;
      });

      if (activeRes) {
        map[table.id] = { status: 'occupied', reservation: activeRes };
        continue;
      }

      // Find upcoming reservation within next 60 min (reserved)
      const upcomingRes = tableRes.find(r => {
        const [h, m] = r.time.split(':').map(Number);
        const startMin = h * 60 + m;
        return startMin > nowMinutes && startMin <= nowMinutes + 60;
      });

      if (upcomingRes) {
        map[table.id] = { status: 'reserved', reservation: upcomingRes };
        continue;
      }

      map[table.id] = { status: 'available' };
    }

    return map;
  }, [tables, todayReservations]);

  // Use computed status for tables
  const enrichedTables = useMemo(() =>
    tables.map(t => ({
      ...t,
      status: tableStatusMap[t.id]?.status ?? t.status,
      reservation: tableStatusMap[t.id]?.reservation,
    })),
    [tables, tableStatusMap]
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        company_id: company.id,
        number: parseInt(form.number),
        capacity: parseInt(form.capacity),
        section: form.section,
        status: 'available',
        updated_at: new Date().toISOString(),
      };
      if (editingTable) {
        const { error } = await supabase
          .from('restaurant_tables' as any)
          .update(payload as any)
          .eq('id', editingTable.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('restaurant_tables' as any)
          .insert(payload as any);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant-tables', company?.id] });
      toast.success(editingTable ? 'Mesa atualizada!' : 'Mesa criada!');
      closeModal();
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('restaurant_tables' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant-tables', company?.id] });
      toast.success('Mesa removida!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const openCreate = () => {
    const nextNumber = tables.length > 0 ? Math.max(...tables.map(t => t.number)) + 1 : 1;
    setEditingTable(null);
    setForm({ number: String(nextNumber), capacity: '2', section: 'salão' });
    setModalOpen(true);
  };

  const openEdit = (table: RestaurantTable) => {
    setEditingTable(table);
    setForm({ number: String(table.number), capacity: String(table.capacity), section: table.section });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingTable(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.number || !form.capacity) { toast.error('Preencha todos os campos'); return; }
    saveMutation.mutate();
  };

  const summary = {
    available: enrichedTables.filter(t => t.status === 'available').length,
    occupied: enrichedTables.filter(t => t.status === 'occupied').length,
    reserved: enrichedTables.filter(t => t.status === 'reserved').length,
    maintenance: enrichedTables.filter(t => t.status === 'maintenance').length,
  };

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-[300px] w-full" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mapa de Mesas</h1>
          <p className="text-muted-foreground mt-1">Gerencie as mesas da unidade</p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="h-4 w-4" /> Nova Mesa
        </Button>
      </div>

      {/* Summary */}
      <div className="flex flex-wrap gap-4">
        {(Object.entries(summary) as [TableStatus, number][]).map(([status, count]) => (
          <div key={status} className="flex items-center gap-2 text-sm">
            <div className={cn('w-3 h-3 rounded-full', STATUS_DOT[status])} />
            <span className="text-muted-foreground">{STATUS_LABELS[status]}</span>
            <span className="text-muted-foreground">({count})</span>
          </div>
        ))}
        <span className="text-sm font-medium text-foreground ml-auto">Total: {enrichedTables.length} mesas</span>
      </div>

      {/* Sections */}
      {enrichedTables.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-muted-foreground mb-4">Nenhuma mesa cadastrada ainda.</p>
            <Button onClick={openCreate} variant="outline" className="gap-2">
              <Plus className="h-4 w-4" /> Cadastrar primeira mesa
            </Button>
          </CardContent>
        </Card>
      ) : (
        SECTIONS.map(section => {
          const sectionTables = enrichedTables.filter(t => t.section === section);
          if (sectionTables.length === 0) return null;
          return (
            <Card key={section} className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg">{SECTION_LABELS[section]}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {sectionTables.map(table => (
                    <div
                      key={table.id}
                      className={cn('relative p-4 rounded-xl border-2 transition-all group', STATUS_COLORS[table.status])}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-lg font-bold">Mesa {table.number}</span>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Users className="h-3.5 w-3.5" />
                          <span className="text-xs">{table.capacity}</span>
                        </div>
                      </div>
                      <span className={cn(
                        'inline-block text-xs px-2 py-0.5 rounded-full font-medium',
                        table.status === 'available' && 'bg-accent/20 text-accent-foreground',
                        table.status === 'occupied' && 'bg-primary/20 text-primary-foreground',
                        table.status === 'reserved' && 'bg-yellow-500/20 text-yellow-700',
                        table.status === 'maintenance' && 'bg-muted text-muted-foreground',
                      )}>
                        {STATUS_LABELS[table.status]}
                      </span>
                      {/* Reservation info */}
                      {table.reservation && (
                        <div className="mt-2 pt-2 border-t border-border/50 space-y-0.5">
                          <p className="text-xs font-medium text-foreground truncate">{table.reservation.guest_name}</p>
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            <span className="text-xs">{table.reservation.time.slice(0, 5)}</span>
                            <span className="text-xs">· {table.reservation.party_size}p</span>
                          </div>
                        </div>
                      )}
                      {/* Actions */}
                      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(table)} className="p-1 rounded hover:bg-background/80">
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                        <button onClick={() => deleteMutation.mutate(table.id)} className="p-1 rounded hover:bg-background/80">
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      {/* Create/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={v => { if (!v) closeModal(); else setModalOpen(true); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingTable ? 'Editar Mesa' : 'Nova Mesa'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div>
              <Label>Número da Mesa</Label>
              <Input type="number" min={1} value={form.number} onChange={e => setForm(f => ({ ...f, number: e.target.value }))} required />
            </div>
            <div>
              <Label>Capacidade (pessoas)</Label>
              <Input type="number" min={1} max={50} value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} required />
            </div>
            <div>
              <Label>Seção</Label>
              <Select value={form.section} onValueChange={v => setForm(f => ({ ...f, section: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SECTIONS.map(s => <SelectItem key={s} value={s}>{SECTION_LABELS[s]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
              {editingTable ? 'Salvar Alterações' : 'Criar Mesa'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
