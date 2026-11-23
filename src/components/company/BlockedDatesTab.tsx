import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarOff, ChevronDown, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
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

function formatBlockedDate(date: string, pattern = 'dd/MM/yyyy (EEE)') {
  return format(new Date(`${date}T12:00:00`), pattern, { locale: ptBR });
}

// "24/12 · quinta": o ano só aparece quando não é o ano corrente.
function formatBlockedDay(date: string) {
  const sameYear = date.slice(0, 4) === String(new Date().getFullYear());
  const day = formatBlockedDate(date, sameYear ? 'dd/MM' : 'dd/MM/yyyy');
  const weekday = formatBlockedDate(date, 'EEEE').replace('-feira', '');
  return `${day} · ${weekday}`;
}

function toDateKey(date: Date) {
  return format(date, 'yyyy-MM-dd');
}

function BlockedDateItem({
  blockedDate,
  muted = false,
  onDelete,
}: {
  blockedDate: BlockedDate;
  muted?: boolean;
  onDelete: (id: string) => void;
}) {
  const dayLabel = formatBlockedDay(blockedDate.date);

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[rgba(0,0,0,0.06)] px-5 py-3 last:border-b-0 sm:grid sm:grid-cols-[150px_minmax(0,1fr)_auto_auto]',
        muted && 'bg-muted/10',
      )}
    >
      <span className={cn('text-sm font-semibold tabular-nums', muted ? 'text-muted-foreground' : 'text-foreground')}>
        {dayLabel}
      </span>
      <span className="order-last w-full min-w-0 truncate text-sm text-muted-foreground sm:order-none sm:w-auto sm:text-foreground">
        {blockedDate.reason || <span className="text-muted-foreground">Sem motivo informado</span>}
      </span>
      <span
        className={cn(
          'ml-auto rounded-full px-2.5 py-1 text-xs font-semibold sm:ml-0 sm:justify-self-start',
          muted
            ? 'bg-muted text-muted-foreground'
            : blockedDate.all_day
              ? 'bg-destructive/10 text-destructive'
              : 'bg-warning-soft text-foreground',
        )}
      >
        {blockedDate.all_day
          ? 'Dia inteiro'
          : `${blockedDate.start_time?.substring(0, 5)} às ${blockedDate.end_time?.substring(0, 5)}`}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 rounded-lg border-[rgba(0,0,0,0.14)] bg-white"
            aria-label={`Mais ações do bloqueio de ${formatBlockedDate(blockedDate.date, 'dd/MM/yyyy')}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => onDelete(blockedDate.id)}
            className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Remover bloqueio
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export default function BlockedDatesTab({ companyId }: Props) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [showPastDates, setShowPastDates] = useState(false);
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

  const today = toDateKey(new Date());
  const futureDates = blockedDates.filter((blockedDate) => blockedDate.date >= today);
  const pastDates = blockedDates
    .filter((blockedDate) => blockedDate.date < today)
    .sort((left, right) => right.date.localeCompare(left.date));

  const openAddDialog = () => {
    setForm({ date: '', all_day: true, start_time: '', end_time: '', reason: '' });
    setShowAdd(true);
  };

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <>
      <div>
        <section aria-labelledby="blocked-dates-heading" className={cn(settingsCardClassName, 'overflow-hidden')}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(0,0,0,0.06)] px-5 py-4">
            <div className="min-w-0">
              <h2 id="blocked-dates-heading" className="text-base font-semibold text-foreground">Datas bloqueadas e especiais</h2>
              <p className="text-xs text-muted-foreground">Feriados, eventos privados ou horários em que a casa não recebe reservas.</p>
            </div>
            <Button size="sm" className="h-9 gap-1.5 rounded-lg px-4" onClick={() => openAddDialog()}>
              <Plus className="h-4 w-4" />
              Bloquear data
            </Button>
          </div>

          {futureDates.length === 0 && pastDates.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <CalendarOff className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Nenhuma data bloqueada</p>
                <p className="text-xs text-muted-foreground">Clique em Bloquear data para adicionar.</p>
              </div>
            </div>
          ) : (
            <>
              {futureDates.length > 0 ? (
                <ul aria-label="Próximas datas bloqueadas">
                  {futureDates.map((blockedDate) => (
                    <BlockedDateItem
                      key={blockedDate.id}
                      blockedDate={blockedDate}
                      onDelete={(id) => deleteMutation.mutate(id)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-5 text-sm text-muted-foreground">Nenhuma data futura bloqueada.</p>
              )}

              {pastDates.length > 0 && (
                <Collapsible
                  open={showPastDates}
                  onOpenChange={setShowPastDates}
                  className="border-t border-[rgba(0,0,0,0.08)]"
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="flex h-auto w-full items-center justify-between gap-3 rounded-none px-5 py-3 text-left hover:bg-muted/20"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">Datas passadas</span>
                        <span className="block text-xs text-muted-foreground">
                          Histórico de bloqueios que não afetam novas reservas.
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-xs">
                          {pastDates.length}
                        </Badge>
                        <ChevronDown className={cn('h-4 w-4 transition-transform', showPastDates && 'rotate-180')} />
                      </span>
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul aria-label="Datas bloqueadas que já passaram" className="border-t border-[rgba(0,0,0,0.08)]">
                      {pastDates.map((blockedDate) => (
                        <BlockedDateItem
                          key={blockedDate.id}
                          blockedDate={blockedDate}
                          muted
                          onDelete={(id) => deleteMutation.mutate(id)}
                        />
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </>
          )}
        </section>

      </div>

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
              <Switch
                id="blocked-date-all-day"
                checked={form.all_day}
                onCheckedChange={(checked) => setForm({ ...form, all_day: checked })}
              />
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
    </>
  );
}
