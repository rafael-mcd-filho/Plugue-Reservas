import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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

const settingsCardClassName = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const settingsFieldClassName = 'h-10 rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';
const settingsBadgeClassName = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';

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

  const today = new Date().toISOString().split('T')[0];
  const futureDates = blockedDates.filter((blockedDate) => blockedDate.date >= today);
  const pastDates = blockedDates.filter((blockedDate) => blockedDate.date < today);

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <Card className={settingsCardClassName}>
      <CardHeader className="space-y-0">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className={settingsBadgeClassName}>
              <CalendarOff className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-lg">Datas bloqueadas</CardTitle>
              <CardDescription>Bloqueie datas ou horários específicos (feriados, eventos privados).</CardDescription>
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            className="h-10 rounded-lg border-[rgba(0,0,0,0.14)] bg-white px-4"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="h-4 w-4" />
            Bloquear data
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-2">
        {futureDates.length === 0 && pastDates.length === 0 ? (
          <div className="flex min-h-[250px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-[rgba(0,0,0,0.12)] bg-muted/10 px-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <CalendarOff className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-lg font-medium text-foreground">Nenhuma data bloqueada</p>
              <p className="text-sm text-muted-foreground">Clique em "Bloquear data" para adicionar.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {futureDates.map((blockedDate) => (
              <div
                key={blockedDate.id}
                className="flex flex-col gap-4 rounded-xl border border-[rgba(0,0,0,0.08)] bg-background px-4 py-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="space-y-2">
                  <div className="text-sm font-semibold">
                    {format(new Date(`${blockedDate.date}T12:00:00`), 'dd/MM/yyyy (EEE)', { locale: ptBR })}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {blockedDate.all_day ? (
                      <Badge variant="secondary" className="rounded-full px-3 py-1 text-xs">
                        Dia inteiro
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
                        {blockedDate.start_time?.substring(0, 5)} às {blockedDate.end_time?.substring(0, 5)}
                      </Badge>
                    )}
                    {blockedDate.reason && <span className="text-sm text-muted-foreground">{blockedDate.reason}</span>}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-lg text-destructive hover:bg-destructive-soft hover:text-destructive"
                  aria-label={`Remover bloqueio de ${format(new Date(`${blockedDate.date}T12:00:00`), 'dd/MM/yyyy')}`}
                  onClick={() => deleteMutation.mutate(blockedDate.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            {pastDates.length > 0 && (
              <p className="pt-1 text-xs text-muted-foreground">+ {pastDates.length} data(s) passada(s)</p>
            )}
          </div>
        )}
      </CardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-sm rounded-2xl border-[rgba(0,0,0,0.08)]">
          <DialogHeader>
            <DialogTitle>Bloquear data</DialogTitle>
          </DialogHeader>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              addMutation.mutate();
            }}
            className="mt-2 space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="blocked-date-date">Data *</Label>
              <Input
                id="blocked-date-date"
                name="date"
                type="date"
                value={form.date}
                onChange={(event) => setForm({ ...form, date: event.target.value })}
                required
                min={today}
                className={settingsFieldClassName}
                autoComplete="off"
              />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
              <Label htmlFor="blocked-date-all-day">Dia inteiro</Label>
              <Switch id="blocked-date-all-day" checked={form.all_day} onCheckedChange={(checked) => setForm({ ...form, all_day: checked })} />
            </div>

            {!form.all_day && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Início</Label>
                  <Input
                    id="blocked-date-start-time"
                    name="start_time"
                    type="time"
                    value={form.start_time}
                    onChange={(event) => setForm({ ...form, start_time: event.target.value })}
                    className={settingsFieldClassName}
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Fim</Label>
                  <Input
                    id="blocked-date-end-time"
                    name="end_time"
                    type="time"
                    value={form.end_time}
                    onChange={(event) => setForm({ ...form, end_time: event.target.value })}
                    className={settingsFieldClassName}
                    autoComplete="off"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="blocked-date-reason">Motivo (opcional)</Label>
              <Input
                id="blocked-date-reason"
                name="reason"
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                placeholder="Ex: Feriado, Evento privado..."
                className={settingsFieldClassName}
                autoComplete="off"
              />
            </div>

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                className="rounded-lg border-[rgba(0,0,0,0.14)] bg-white"
                onClick={() => setShowAdd(false)}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={addMutation.isPending}>
                {addMutation.isPending ? 'Salvando...' : 'Bloquear'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
