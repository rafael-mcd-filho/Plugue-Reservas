import { useState } from 'react';
import { Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useReservations } from '@/contexts/ReservationContext';
import { ReservationStatusBadge } from '@/components/StatusBadge';
import { Reservation, ReservationStatus } from '@/types/restaurant';
import { toast } from 'sonner';

const emptyForm = {
  guestName: '', guestPhone: '', guestEmail: '', date: '', time: '', partySize: 2, tableId: '', status: 'pending' as ReservationStatus, notes: '',
};

export default function Reservations() {
  const { reservations, tables, addReservation, updateReservation, deleteReservation, getTableById } = useReservations();
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filtered = reservations
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .filter(r => r.guestName.toLowerCase().includes(search.toLowerCase()) || r.guestPhone.includes(search))
    .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm, date: new Date().toISOString().split('T')[0] });
    setDialogOpen(true);
  };

  const openEdit = (r: Reservation) => {
    setEditing(r);
    setForm({ guestName: r.guestName, guestPhone: r.guestPhone, guestEmail: r.guestEmail || '', date: r.date, time: r.time, partySize: r.partySize, tableId: r.tableId, status: r.status, notes: r.notes || '' });
    setDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.guestName || !form.date || !form.time || !form.tableId) {
      toast.error('Preencha todos os campos obrigatórios');
      return;
    }
    if (editing) {
      updateReservation(editing.id, form);
      toast.success('Reserva atualizada!');
    } else {
      addReservation(form);
      toast.success('Reserva criada!');
    }
    setDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    deleteReservation(id);
    toast.success('Reserva removida');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reservas</h1>
          <p className="text-muted-foreground mt-1">Gerencie todas as reservas do restaurante</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate} className="gap-2">
              <Plus className="h-4 w-4" /> Nova Reserva
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Editar Reserva' : 'Nova Reserva'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label>Nome do Cliente *</Label>
                  <Input value={form.guestName} onChange={e => setForm({ ...form, guestName: e.target.value })} placeholder="Nome completo" />
                </div>
                <div>
                  <Label>Telefone *</Label>
                  <Input value={form.guestPhone} onChange={e => setForm({ ...form, guestPhone: e.target.value })} placeholder="(11) 99999-9999" />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input value={form.guestEmail} onChange={e => setForm({ ...form, guestEmail: e.target.value })} placeholder="email@exemplo.com" type="email" />
                </div>
                <div>
                  <Label>Data *</Label>
                  <Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                </div>
                <div>
                  <Label>Horário *</Label>
                  <Input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} />
                </div>
                <div>
                  <Label>Pessoas</Label>
                  <Input type="number" min={1} max={20} value={form.partySize} onChange={e => setForm({ ...form, partySize: Number(e.target.value) })} />
                </div>
                <div>
                  <Label>Mesa *</Label>
                  <Select value={form.tableId} onValueChange={v => setForm({ ...form, tableId: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecionar mesa" /></SelectTrigger>
                    <SelectContent>
                      {tables.filter(t => t.capacity >= form.partySize).map(t => (
                        <SelectItem key={t.id} value={t.id}>Mesa {t.number} ({t.capacity} lugares - {t.section})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {editing && (
                  <div>
                    <Label>Status</Label>
                    <Select value={form.status} onValueChange={v => setForm({ ...form, status: v as ReservationStatus })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pendente</SelectItem>
                        <SelectItem value="confirmed">Confirmada</SelectItem>
                        <SelectItem value="cancelled">Cancelada</SelectItem>
                        <SelectItem value="completed">Concluída</SelectItem>
                        <SelectItem value="no-show">Não compareceu</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="col-span-2">
                  <Label>Observações</Label>
                  <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Observações sobre a reserva..." rows={2} />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
                <Button type="submit">{editing ? 'Salvar' : 'Criar Reserva'}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
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
                  <th className="px-6 py-4 font-medium text-muted-foreground">Status</th>
                  <th className="px-6 py-4 font-medium text-muted-foreground">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-12 text-muted-foreground">Nenhuma reserva encontrada</td></tr>
                ) : filtered.map(r => {
                  const table = getTableById(r.tableId);
                  return (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium">{new Date(r.date + 'T00:00:00').toLocaleDateString('pt-BR')}</div>
                        <div className="text-xs text-muted-foreground">{r.time}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div>{r.guestName}</div>
                        <div className="text-xs text-muted-foreground">{r.guestPhone}</div>
                      </td>
                      <td className="px-6 py-4">{r.partySize}</td>
                      <td className="px-6 py-4">Mesa {table?.number ?? '?'}</td>
                      <td className="px-6 py-4"><ReservationStatusBadge status={r.status} /></td>
                      <td className="px-6 py-4">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => handleDelete(r.id)}>
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
    </div>
  );
}
