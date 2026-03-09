import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Search, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { toast } from 'sonner';

type ReservationStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no-show';

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
  table_number?: number;
}

export default function Reservations() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [editDialog, setEditDialog] = useState(false);
  const [editingRes, setEditingRes] = useState<Reservation | null>(null);
  const [editStatus, setEditStatus] = useState<ReservationStatus>('pending');

  // Fetch company
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

  // Fetch reservations
  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ['reservations', company?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reservations' as any)
        .select('*')
        .eq('company_id', company.id)
        .order('date', { ascending: false })
        .order('time', { ascending: false });
      if (error) throw error;
      return (data as any[]) as Reservation[];
    },
    enabled: !!company?.id,
  });

  // Fetch tables for display
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

  const filtered = reservations
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .filter(r =>
      r.guest_name.toLowerCase().includes(search.toLowerCase()) ||
      r.guest_phone.includes(search)
    );

  const openEdit = (r: Reservation) => {
    setEditingRes(r);
    setEditStatus(r.status);
    setEditDialog(true);
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

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome ou telefone..." value={search} onChange={e => setSearch(e.target.value)} className="pl-10" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="pending">Pendente</SelectItem>
            <SelectItem value="confirmed">Confirmada</SelectItem>
            <SelectItem value="cancelled">Cancelada</SelectItem>
            <SelectItem value="completed">Concluída</SelectItem>
            <SelectItem value="no-show">Não compareceu</SelectItem>
          </SelectContent>
        </Select>
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
                ) : filtered.map(r => (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium">{new Date(r.date + 'T00:00:00').toLocaleDateString('pt-BR')}</div>
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
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

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
    </div>
  );
}
