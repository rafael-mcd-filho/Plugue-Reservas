import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CalendarDays, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useReservationScheduleOverrides,
  useCreateReservationScheduleOverride,
  useUpdateReservationScheduleOverride,
  useDeleteReservationScheduleOverride,
  type ReservationScheduleOverride,
} from '@/hooks/useReservationScheduleOverrides';

const BADGE_CLASS = 'flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary';
const CARD_CLASS = 'rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.03)]';
const FIELD_CLASS = 'h-10 w-full rounded-lg border-[rgba(0,0,0,0.14)] bg-white shadow-none';

const INTERVAL_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hora' },
  { value: '90', label: '1h30' },
  { value: '120', label: '2 horas' },
];

function formatIntervalLabel(minutes: number) {
  const opt = INTERVAL_OPTIONS.find((o) => o.value === String(minutes));
  return opt?.label ?? `${minutes} min`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

interface FormState {
  date: string;
  start_time: string;
  end_time: string;
  slot_interval_minutes: string;
  label: string;
}

const EMPTY_FORM: FormState = {
  date: '',
  start_time: '',
  end_time: '',
  slot_interval_minutes: '60',
  label: '',
};

function validateForm(form: FormState): string | null {
  if (!form.date) return 'Selecione uma data';
  if (form.date < todayIso()) return 'A data não pode ser no passado';
  if (!form.start_time) return 'Informe o horário de início';
  if (!form.end_time) return 'Informe o horário de término';
  if (form.start_time >= form.end_time) return 'O horário de término deve ser depois do início';
  return null;
}

interface OverrideDialogProps {
  companyId: string;
  override?: ReservationScheduleOverride;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function OverrideDialog({ companyId, override, open, onOpenChange }: OverrideDialogProps) {
  const isEditing = !!override;
  const [form, setForm] = useState<FormState>(() =>
    override
      ? {
          date: override.date,
          start_time: override.start_time.slice(0, 5),
          end_time: override.end_time.slice(0, 5),
          slot_interval_minutes: String(override.slot_interval_minutes),
          label: override.label ?? '',
        }
      : EMPTY_FORM,
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const createMutation = useCreateReservationScheduleOverride();
  const updateMutation = useUpdateReservationScheduleOverride();
  const isPending = createMutation.isPending || updateMutation.isPending;

  function set(key: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setValidationError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setForm(override
        ? {
            date: override.date,
            start_time: override.start_time.slice(0, 5),
            end_time: override.end_time.slice(0, 5),
            slot_interval_minutes: String(override.slot_interval_minutes),
            label: override.label ?? '',
          }
        : EMPTY_FORM);
      setValidationError(null);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit() {
    const error = validateForm(form);
    if (error) { setValidationError(error); return; }

    const payload = {
      date: form.date,
      start_time: form.start_time,
      end_time: form.end_time,
      slot_interval_minutes: Number(form.slot_interval_minutes),
      label: form.label.trim() || null,
    };

    if (isEditing && override) {
      await updateMutation.mutateAsync({ id: override.id, companyId, update: payload });
    } else {
      await createMutation.mutateAsync({ company_id: companyId, ...payload });
    }
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Editar regra' : 'Nova regra pontual'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="rso-date">Data</Label>
            <Input
              id="rso-date"
              type="date"
              min={todayIso()}
              value={form.date}
              onChange={(e) => set('date', e.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rso-start">Início</Label>
              <Input
                id="rso-start"
                type="time"
                value={form.start_time}
                onChange={(e) => set('start_time', e.target.value)}
                className={FIELD_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rso-end">Último horário</Label>
              <Input
                id="rso-end"
                type="time"
                value={form.end_time}
                onChange={(e) => set('end_time', e.target.value)}
                className={FIELD_CLASS}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Intervalo entre horários</Label>
            <Select value={form.slot_interval_minutes} onValueChange={(v) => set('slot_interval_minutes', v)}>
              <SelectTrigger className={FIELD_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVAL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rso-label">
              Descrição <span className="text-muted-foreground font-normal">(opcional)</span>
            </Label>
            <Input
              id="rso-label"
              placeholder="Ex.: Evento de aniversário"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          {validationError && (
            <p className="text-sm text-destructive">{validationError}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEditing ? 'Salvar' : 'Criar regra'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ScheduleOverridesCardProps {
  companyId: string;
}

export function ScheduleOverridesCard({ companyId }: ScheduleOverridesCardProps) {
  const { data: overrides = [], isLoading } = useReservationScheduleOverrides(companyId);
  const deleteMutation = useDeleteReservationScheduleOverride();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingOverride, setEditingOverride] = useState<ReservationScheduleOverride | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  return (
    <>
      <Card className={CARD_CLASS}>
        <CardHeader className="space-y-0 pb-2">
          <div className="flex items-start gap-3">
            <div className={BADGE_CLASS}>
              <CalendarDays className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-lg">Regras pontuais por data</CardTitle>
              <CardDescription>
                Sobrepõem os horários de funcionamento em datas específicas. Útil para eventos, feriados ou mudanças de turno.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-2 space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-2">Carregando...</p>
          ) : overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Nenhuma regra configurada.</p>
          ) : (
            <div className="space-y-2">
              {overrides.map((ov) => (
                <div
                  key={ov.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {format(parseISO(ov.date), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ov.start_time.slice(0, 5)} até {ov.end_time.slice(0, 5)}, a cada {formatIntervalLabel(ov.slot_interval_minutes)}
                      {ov.label ? ` · ${ov.label}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setEditingOverride(ov)}
                      aria-label="Editar regra"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => setDeletingId(ov.id)}
                      aria-label="Remover regra"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Nova regra
          </Button>
        </CardContent>
      </Card>

      <OverrideDialog
        companyId={companyId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {editingOverride && (
        <OverrideDialog
          companyId={companyId}
          override={editingOverride}
          open={!!editingOverride}
          onOpenChange={(open) => { if (!open) setEditingOverride(null); }}
        />
      )}

      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover regra?</AlertDialogTitle>
            <AlertDialogDescription>
              Os horários desse dia voltarão ao padrão de funcionamento da empresa. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deletingId) deleteMutation.mutate({ id: deletingId, companyId });
                setDeletingId(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
