import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

interface Props {
  companyId: string;
}

interface BlockedDate {
  id: string;
  company_id: string;
  date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  created_at: string;
}

export default function BlockedDatesTab({ companyId }: Props) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    date: '',
    all_day: true,
    start_time: '',
    end_time: '',
    reason: '',
  });

  const { data: blockedDates = [], isLoading } = useQuery({
    queryKey: ['blocked-dates', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('blocked_dates' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('date', { ascending: true });
      if (error) throw error;
      return data as unknown as BlockedDate[];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!form.date) throw new Error('Selecione uma data');
      const { error } = await supabase.from('blocked_dates' as any).insert({
        company_id: companyId,
        date: form.date,
        all_day: form.all_day,
        start_time: form.all_day ? null : form.start_time || null,
        end_time: form.all_day ? null : form.end_time || null,
        reason: form.reason || null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blocked-dates', companyId] });
      toast.success('Data bloqueada!');
      setShowAdd(false);
      setForm({ date: '', all_day: true, start_time: '', end_time: '', reason: '' });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('blocked_dates' as any).delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blocked-dates', companyId] });
      toast.success('Bloqueio removido!');
    },
    onError: (err: any) => toast.error(err.message),
  });

  // Split into future and past
  const today = new Date().toISOString().split('T')[0];
  const futureDates = blockedDates.filter(d => d.date >= today);
  const pastDates = blockedDates.filter(d => d.date < today);

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarOff className="h-5 w-5 text-primary" /> Datas Bloqueadas
            </CardTitle>
            <CardDescription>Bloqueie datas ou horários específicos (feriados, eventos privados)</CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4" /> Bloquear Data
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {futureDates.length === 0 && pastDates.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Nenhuma data bloqueada. Clique em "Bloquear Data" para adicionar.
          </p>
        ) : (
          <div className="space-y-2">
            {futureDates.map(bd => (
              <div key={bd.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background">
                <div className="flex items-center gap-3">
                  <div className="text-sm font-semibold">
                    {format(new Date(bd.date + 'T12:00:00'), "dd/MM/yyyy (EEE)", { locale: ptBR })}
                  </div>
                  {bd.all_day ? (
                    <Badge variant="secondary" className="text-xs">Dia inteiro</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      {bd.start_time?.substring(0, 5)} — {bd.end_time?.substring(0, 5)}
                    </Badge>
                  )}
                  {bd.reason && <span className="text-xs text-muted-foreground">{bd.reason}</span>}
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deleteMutation.mutate(bd.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {pastDates.length > 0 && (
              <p className="text-xs text-muted-foreground pt-2">+ {pastDates.length} data(s) passada(s)</p>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Bloquear Data</DialogTitle></DialogHeader>
          <form onSubmit={e => { e.preventDefault(); addMutation.mutate(); }} className="space-y-4 mt-2">
            <div>
              <Label>Data *</Label>
              <Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required min={today} />
            </div>
            <div className="flex items-center justify-between">
              <Label>Dia inteiro</Label>
              <Switch checked={form.all_day} onCheckedChange={checked => setForm({ ...form, all_day: checked })} />
            </div>
            {!form.all_day && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Início</Label>
                  <Input type="time" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })} />
                </div>
                <div>
                  <Label>Fim</Label>
                  <Input type="time" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} />
                </div>
              </div>
            )}
            <div>
              <Label>Motivo (opcional)</Label>
              <Input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Ex: Feriado, Evento privado..." />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancelar</Button>
              <Button type="submit" disabled={addMutation.isPending}>{addMutation.isPending ? 'Salvando...' : 'Bloquear'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
